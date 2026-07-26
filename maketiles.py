#!/usr/bin/env python3
"""
Build a PMTiles archive from the GeoJSON files that tiles.html downloads.

Two phases, so a big build can be done in pieces rather than one long run:

    # encode one or more zoom levels into a stage file
    python3 maketiles.py stage ep-*.geojson --zooms 6 7 8 9 10 11
    python3 maketiles.py stage ep-*.geojson --zooms 12 13
    python3 maketiles.py stage ep-*.geojson --zooms 14

    # merge the stages into the finished archive
    python3 maketiles.py pack -o data/everypark.pmtiles

Each input file becomes one named layer inside the tiles, so the map can
style and toggle them independently. Geometry is simplified per zoom
level: at zoom 8 a footpath is sub-pixel, so there's no point shipping
its vertices. Attributes ride along with the geometry, which is what
makes restyling possible without refetching anything.
"""

import argparse
import glob
import gzip
import json
import math
import os
import pickle
import re
import sys
from collections import defaultdict

import mercantile
from shapely.geometry import shape, box
from shapely.ops import transform as shp_transform
from shapely.strtree import STRtree
import mapbox_vector_tile
from pmtiles.writer import Writer
from pmtiles.tile import Compression, TileType, zxy_to_tileid

EXTENT = 4096          # MVT coordinate space per tile
BUFFER = 128           # draw past the tile edge so lines don't seam

# Connecticut, with a small margin. Everything is clipped to this before
# tiling. Without it a single PAD-US record for the Appalachian Trail
# corridor — which runs through fourteen states — claims a bounding box
# spanning half the country and lands in thousands of tiles.
CT_CLIP = box(-73.80, 40.90, -71.72, 42.11)

# OSM tags worth drawing. footway and cycleway are overwhelmingly town
# sidewalks and road-side bike lanes: they quadruple the feature count
# and clutter the map without telling you anything about a park.
TRAIL_KEEP = {"path", "track", "bridleway"}

# Which zooms each layer appears at. Detail layers stay out of the low
# zooms entirely — that's most of the size saving, and at z9 a trail
# network is an unreadable smudge anyway.
LAYER_ZOOM = {
    "stateland":  (6, 14),
    "padus":      (8, 14),
    "preserves":  (9, 14),
    "blueblazed": (9, 14),
    "townparks":  (10, 14),
    "landuse":    (10, 14),
    "cemeteries": (11, 14),
    "parcels":    (12, 14),
    "trails":     (12, 14),
}
DEFAULT_ZOOM = (10, 14)

STAGE_DIR = "_stage"


def min_area_for(z):
    """Polygons under about a quarter-pixel aren't worth shipping."""
    tile_deg = 360.0 / (2 ** z)
    px_deg = tile_deg / 512.0
    return (px_deg ** 2) * 0.25


def simplify_for(geom, z):
    """Simplify to about a third of a pixel at this zoom."""
    tile_deg = 360.0 / (2 ** z)
    tol = (tile_deg / 512.0) * 0.35
    try:
        g = geom.simplify(tol, preserve_topology=True)
        return g if not g.is_empty else geom
    except Exception:
        return geom


def clean_props(props):
    """MVT can't carry nulls or nested values; flatten to scalars."""
    out = {}
    for k, v in (props or {}).items():
        if v is None:
            continue
        if isinstance(v, (str, int, float, bool)):
            if isinstance(v, str):
                v = v.strip()
                if not v:
                    continue
                if len(v) > 120:
                    v = v[:120]
            out[k] = v
        else:
            out[k] = json.dumps(v)[:120]
    return out


def layer_name(path):
    name = os.path.basename(path)
    if name.startswith("ep-"):
        name = name[3:]
    return name.split(".")[0]


def load_layer(path):
    name = layer_name(path)
    with open(path) as fh:
        gj = json.load(fh)

    feats = []
    skipped = 0
    for f in gj.get("features") or []:
        g = f.get("geometry")
        if not g:
            skipped += 1
            continue
        props = f.get("properties") or {}
        if name == "trails" and props.get("highway") not in TRAIL_KEEP:
            skipped += 1
            continue
        try:
            geom = shape(g)
            if geom.is_empty:
                skipped += 1
                continue
            if not geom.is_valid:
                geom = geom.buffer(0)
                if geom.is_empty:
                    skipped += 1
                    continue
            # Clip to Connecticut. Cheap containment test first — most
            # features are entirely inside and need no clipping at all.
            if not CT_CLIP.contains(geom):
                geom = geom.intersection(CT_CLIP)
                if geom.is_empty:
                    skipped += 1
                    continue
        except Exception:
            skipped += 1
            continue
        feats.append((geom, clean_props(props)))
    return name, feats, skipped


def tile_clip(t, z):
    b = mercantile.bounds(t)
    pad = (b.east - b.west) * (BUFFER / EXTENT)
    return box(b.west - pad, b.south - pad, b.east + pad, b.north + pad)


MERC_MAX = 20037508.342789244


def merc_y(lat):
    """Latitude to Web Mercator northing, clamped near the poles."""
    lat = max(min(lat, 85.05112878), -85.05112878)
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * (MERC_MAX / math.pi)


def to_tile_coords(geom, t):
    """
    Map lon/lat into the tile's 0..4096 integer grid, y flipped.

    The y axis MUST go through the Mercator projection first. Tiles are
    square in projected metres, not in degrees, so interpolating latitude
    linearly across a tile shears everything northward or southward —
    subtly at high zoom, wildly at low zoom.
    """
    b = mercantile.xy_bounds(t)          # tile bounds in EPSG:3857 metres
    dx = b.right - b.left
    dy = b.top - b.bottom

    def fn(x, y, z=None):
        return (
            [((px * MERC_MAX / 180.0) - b.left) / dx * EXTENT for px in x],
            [EXTENT - (merc_y(py) - b.bottom) / dy * EXTENT for py in y],
        )

    return shp_transform(fn, geom)


# How much of a PAD-US shape must already be covered by a DEEP or OSM
# shape before it counts as a duplicate.
DUP_OVERLAP = 0.55


# Most authoritative geometry first. Anything substantially covered by a
# layer above it is a duplicate and gets dropped, so each piece of ground
# is drawn exactly once, by whichever source describes it best.
#
#   stateland  DEEP's own parcels — definitive for state land
#   townparks  OSM, the usual source for municipal parks
#   cemeteries specific and rarely overlapping
#   landuse    town greens and rec grounds
#   preserves  OSM nature_reserve, which also tags state forests and parks
#   padus      national coverage, so it restates almost everything above
DEDUP_ORDER = ["stateland", "townparks", "cemeteries", "landuse", "preserves", "padus"]


def norm_name(props):
    n = props.get("PROPERTY") or props.get("Unit_Nm") or props.get("name") or ""
    return re.sub(r"[^a-z0-9]+", " ", str(n).lower()).strip()


def dedupe_layers(layers):
    kept_geoms = []
    kept_names = {}          # normalised name -> [geom, ...]

    def remember(geom, props):
        if geom.geom_type in ("Polygon", "MultiPolygon"):
            kept_geoms.append(geom)
            nm = norm_name(props)
            if nm:
                kept_names.setdefault(nm, []).append(geom)

    for name in DEDUP_ORDER:
        feats = layers.get(name)
        if not feats:
            continue
        if not kept_geoms:                      # first layer keeps everything
            for geom, props in feats:
                remember(geom, props)
            continue

        tree = STRtree(kept_geoms)
        kept = []
        by_area = by_name = 0
        for geom, props in feats:
            if geom.geom_type not in ("Polygon", "MultiPolygon") or geom.area <= 0:
                kept.append((geom, props))
                continue

            # Same name, same ground, different source. This catches the
            # cases area overlap misses — a single sprawling PAD-US unit
            # against the many small DEEP parcels that make it up, where
            # no one parcel covers enough of it to look like a duplicate.
            nm = norm_name(props)
            if nm and nm in kept_names:
                if any(geom.intersects(g) for g in kept_names[nm]):
                    by_name += 1
                    continue

            covered = 0.0
            for idx in tree.query(geom):
                try:
                    covered += geom.intersection(kept_geoms[idx]).area
                except Exception:
                    continue
                if covered / geom.area >= DUP_OVERLAP:
                    break
            if covered / geom.area >= DUP_OVERLAP:
                by_area += 1
            else:
                kept.append((geom, props))

        layers[name] = kept
        if by_area or by_name:
            print(f"  {name}: dropped {by_area:,} by overlap + {by_name:,} by name, "
                  f"{len(kept):,} remain", flush=True)
        for geom, props in kept:
            remember(geom, props)


def stage(inputs, zooms):
    os.makedirs(STAGE_DIR, exist_ok=True)
    layers = {}
    for path in inputs:
        name, feats, skipped = load_layer(path)
        layers[name] = feats
        note = f" ({skipped:,} filtered/clipped out)" if skipped else ""
        print(f"  {name}: {len(feats):,} features{note}", flush=True)

    dedupe_layers(layers)

    with open(os.path.join(STAGE_DIR, "layers.json"), "w") as fh:
        json.dump(sorted(layers), fh)

    for z in zooms:
        buckets = defaultdict(lambda: defaultdict(list))
        min_a = min_area_for(z)
        for name, feats in layers.items():
            lo, hi = LAYER_ZOOM.get(name, DEFAULT_ZOOM)
            if not (lo <= z <= hi):
                continue
            kept = 0
            for geom, props in feats:
                if geom.geom_type in ("Polygon", "MultiPolygon") and geom.area < min_a:
                    continue
                sg = simplify_for(geom, z)
                w, s, e, n = sg.bounds
                for t in mercantile.tiles(w, s, e, n, [z]):
                    buckets[(t.x, t.y)][name].append((sg, props))
                kept += 1
            print(f"    z{z} {name}: {kept:,}", flush=True)

        out = {}
        for (x, y), by_layer in buckets.items():
            t = mercantile.Tile(x, y, z)
            clip = tile_clip(t, z)
            mvt_layers = []
            for name, items in by_layer.items():
                feats_out = []
                for geom, props in items:
                    try:
                        g = geom if clip.contains(geom) else geom.intersection(clip)
                        if g.is_empty:
                            continue
                        feats_out.append(
                            {"geometry": to_tile_coords(g, t), "properties": props})
                    except Exception:
                        continue
                if feats_out:
                    mvt_layers.append({"name": name, "features": feats_out})
            if not mvt_layers:
                continue
            try:
                # y_coord_down is essential. to_tile_coords already emits
                # MVT-native coordinates with y measured DOWN from the top
                # of the tile. Without this flag the encoder flips y a
                # second time, mirroring every shape inside its own tile.
                buf = mapbox_vector_tile.encode(
                    mvt_layers,
                    default_options={"extents": EXTENT, "y_coord_down": True})
            except Exception:
                continue
            if buf:
                out[zxy_to_tileid(z, x, y)] = gzip.compress(buf, 6)

        path = os.path.join(STAGE_DIR, f"z{z}.pkl")
        with open(path, "wb") as fh:
            pickle.dump(out, fh, protocol=4)
        size = sum(len(v) for v in out.values())
        print(f"  z{z}: {len(out):,} tiles, {size/1024/1024:.1f} MB -> {path}",
              flush=True)


def pack(out_path, minzoom, maxzoom):
    stages = sorted(glob.glob(os.path.join(STAGE_DIR, "z*.pkl")))
    if not stages:
        sys.exit("no stage files — run `stage` first")

    tiles = {}
    for p in stages:
        with open(p, "rb") as fh:
            tiles.update(pickle.load(fh))
        print(f"  loaded {p}", flush=True)

    with open(os.path.join(STAGE_DIR, "layers.json")) as fh:
        names = json.load(fh)

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "wb") as fh:
        writer = Writer(fh)
        for tid in sorted(tiles):
            writer.write_tile(tid, tiles[tid])
        writer.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": minzoom,
                "max_zoom": maxzoom,
                "min_lon_e7": int(-73.75 * 1e7),
                "min_lat_e7": int(40.95 * 1e7),
                "max_lon_e7": int(-71.77 * 1e7),
                "max_lat_e7": int(42.06 * 1e7),
                "center_zoom": 9,
                "center_lon_e7": int(-72.7 * 1e7),
                "center_lat_e7": int(41.55 * 1e7),
            },
            {
                "attribution": "CT DEEP, USGS PAD-US, OpenStreetMap contributors",
                "name": "EveryPark",
                "vector_layers": [
                    {"id": n,
                     "minzoom": max(LAYER_ZOOM.get(n, DEFAULT_ZOOM)[0], minzoom),
                     "maxzoom": min(LAYER_ZOOM.get(n, DEFAULT_ZOOM)[1], maxzoom)}
                    for n in names
                ],
            },
        )
    size = os.path.getsize(out_path)
    print(f"\n  {len(tiles):,} tiles -> {out_path} ({size/1024/1024:.1f} MB)")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("stage", help="encode zoom levels into stage files")
    s.add_argument("inputs", nargs="+")
    s.add_argument("--zooms", nargs="+", type=int, required=True)

    p = sub.add_parser("pack", help="merge stage files into a PMTiles archive")
    p.add_argument("-o", "--out", default="data/everypark.pmtiles")
    p.add_argument("--minzoom", type=int, default=6)
    p.add_argument("--maxzoom", type=int, default=14)

    args = ap.parse_args()
    if args.cmd == "stage":
        missing = [q for q in args.inputs if not os.path.exists(q)]
        if missing:
            sys.exit("missing: " + ", ".join(missing))
        stage(args.inputs, sorted(args.zooms))
    else:
        pack(args.out, args.minzoom, args.maxzoom)


if __name__ == "__main__":
    main()
