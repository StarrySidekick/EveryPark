#!/usr/bin/env python3
"""
Build a PMTiles archive from the GeoJSON files that tiles.html downloads.

    python3 maketiles.py ep-*.geojson -o data/everypark.pmtiles

Each input file becomes one named layer inside the tiles, so the map can
style and toggle them independently. Geometry is simplified per zoom
level: at zoom 8 a footpath is sub-pixel, so there's no point shipping
its vertices. Attributes ride along with the geometry, which is what
makes restyling possible without refetching anything.
"""

import argparse
import gzip
import json
import os
import sys
from collections import defaultdict

import mercantile
from shapely.geometry import shape, box, mapping
from shapely.ops import transform as shp_transform
import mapbox_vector_tile
from pmtiles.writer import Writer
from pmtiles.tile import Compression, TileType, zxy_to_tileid

EXTENT = 4096          # MVT coordinate space per tile
BUFFER = 128           # draw past the tile edge so lines don't seam

# Which zooms each layer appears at. Detail layers stay out of the low
# zooms entirely — that's most of the size saving, and at z9 a trail
# network is an unreadable smudge anyway.
LAYER_ZOOM = {
    "stateland":  (6, 14),
    "padus":      (8, 14),
    "preserves":  (9, 14),
    "townparks":  (10, 14),
    "landuse":    (10, 14),
    "cemeteries": (11, 14),
    "parcels":    (12, 14),
    "trails":     (12, 14),
    "blueblazed": (9, 14),
}
DEFAULT_ZOOM = (10, 14)

# Drop features too small to see at a given zoom. Values are in square
# degrees, scaled by zoom; polygons under roughly a quarter-pixel go.
def min_area_for(z):
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


def load_layer(path):
    name = os.path.basename(path)
    for prefix in ("ep-",):
        if name.startswith(prefix):
            name = name[len(prefix):]
    name = name.split(".")[0]

    with open(path) as fh:
        gj = json.load(fh)

    feats = []
    skipped = 0
    for f in gj.get("features") or []:
        g = f.get("geometry")
        if not g:
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
        except Exception:
            skipped += 1
            continue
        feats.append((geom, clean_props(f.get("properties"))))
    return name, feats, skipped


def tile_bounds(t):
    b = mercantile.bounds(t)
    return box(b.west, b.south, b.east, b.north)


def to_tile_coords(geom, t):
    """Map lon/lat into the tile's 0..4096 integer grid, y flipped."""
    b = mercantile.bounds(t)
    dx = b.east - b.west
    dy = b.north - b.south

    def fn(x, y, z=None):
        return (
            [(px - b.west) / dx * EXTENT for px in x],
            [EXTENT - (py - b.south) / dy * EXTENT for py in y],
        )

    return shp_transform(fn, geom)


def build(inputs, out_path, minzoom, maxzoom):
    layers = {}
    for path in inputs:
        name, feats, skipped = load_layer(path)
        layers[name] = feats
        note = f" ({skipped} skipped)" if skipped else ""
        print(f"  {name}: {len(feats):,} features{note}", flush=True)

    # Index each layer's features by the tiles they touch, per zoom.
    # Doing it zoom by zoom keeps memory flat rather than holding every
    # tile's contents at once.
    tiles = defaultdict(lambda: defaultdict(list))

    for name, feats in layers.items():
        lo, hi = LAYER_ZOOM.get(name, DEFAULT_ZOOM)
        lo, hi = max(lo, minzoom), min(hi, maxzoom)
        if lo > hi:
            continue
        for z in range(lo, hi + 1):
            min_a = min_area_for(z)
            kept = 0
            for geom, props in feats:
                if geom.geom_type in ("Polygon", "MultiPolygon") and geom.area < min_a:
                    continue
                sg = simplify_for(geom, z)
                w, s, e, n = sg.bounds
                for t in mercantile.tiles(w, s, e, n, [z]):
                    tiles[(z, t.x, t.y)][name].append((sg, props))
                kept += 1
            print(f"    {name} z{z}: {kept:,} features", flush=True)

    print(f"  {len(tiles):,} tiles to write", flush=True)

    written = 0
    with open(out_path, "wb") as fh:
        writer = Writer(fh)
        for (z, x, y) in sorted(tiles.keys()):
            t = mercantile.Tile(x, y, z)
            clip = tile_bounds(t).buffer((360.0 / (2 ** z)) * (BUFFER / EXTENT))
            mvt_layers = []
            for name, items in tiles[(z, x, y)].items():
                out_feats = []
                for geom, props in items:
                    try:
                        g = geom.intersection(clip)
                        if g.is_empty:
                            continue
                        g = to_tile_coords(g, t)
                        out_feats.append({"geometry": g, "properties": props})
                    except Exception:
                        continue
                if out_feats:
                    mvt_layers.append({"name": name, "features": out_feats})
            if not mvt_layers:
                continue
            buf = mapbox_vector_tile.encode(
                mvt_layers, default_options={"extents": EXTENT})
            if not buf:
                continue
            writer.write_tile(zxy_to_tileid(z, x, y), gzip.compress(buf, 6))
            written += 1
            if written % 500 == 0:
                print(f"    wrote {written:,} tiles", flush=True)

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
                    for n in layers
                ],
            },
        )

    size = os.path.getsize(out_path)
    print(f"\n  {written:,} tiles -> {out_path} ({size/1024/1024:.1f} MB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", help="ep-*.geojson files")
    ap.add_argument("-o", "--out", default="data/everypark.pmtiles")
    ap.add_argument("--minzoom", type=int, default=6)
    ap.add_argument("--maxzoom", type=int, default=14)
    args = ap.parse_args()

    missing = [p for p in args.inputs if not os.path.exists(p)]
    if missing:
        sys.exit("missing: " + ", ".join(missing))

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    build(args.inputs, args.out, args.minzoom, args.maxzoom)


if __name__ == "__main__":
    main()
