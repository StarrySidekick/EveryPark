#!/usr/bin/env python3
"""
Cut every road into tiles — all of them, at every zoom.

    python3 fetchroads.py                       # raw/roads.npz
    python3 makeroadtiles.py --zooms 7 8 9 10 11 12 13 14
    python3 makeroadtiles.py pack -o data/roads.pmtiles

WHAT MAKES THIS DIFFERENT FROM maketiles.py
-------------------------------------------
Every web map you have ever used thins its roads by zoom. That is not
laziness, it is arithmetic: a zoom-7 tile covers a third of New York,
and putting a million driveways in it means a multi-megabyte tile that
draws as a grey smear. So renderers drop minor roads at low zoom and
add them back as you go in.

This map does the opposite on purpose (Timothy, 2026-09-21): "I want to
be able to see all the roads at once, regardless of zoom level" — the
road network read as a heat map of where people are. Every road is in
every zoom level. Four things make that affordable:

  1. QUANTISATION IS THE SIMPLIFICATION. Coordinates arrive as integers
     on the zoom-14 tile grid. Zoom z is just `>> (14 - z)`. Vertices
     that land on the same integer collapse, so a road that needs 40
     points at z14 needs 2 at z8 without anyone running Douglas-Peucker.

  2. ONE FEATURE PER RANK PER TILE. Each tile holds nine features at
     most, one per rank, each a MultiLineString of every road of that
     rank in the tile. No per-feature tags, no per-feature overhead in
     the protobuf, and in the browser it strokes as one canvas path
     instead of ten thousand.

  3. IDENTICAL RUNS DEDUPE. At zoom 8 two parallel streets a hundred
     metres apart quantise to exactly the same pair of integers. The
     second one is not more information, it is the same ink. Dropping
     it is free and invisible.

  4. NO NAMES. Names are what make a road tileset big — a string table
     per tile, repeated at every zoom. The heat map does not need them,
     and the labels layer over the imagery basemaps already has them.

A road that collapses to a single point at low zoom is kept as a
one-pixel tick rather than dropped (TICK below). Dropping it would be a
level-of-detail rule by the back door, and the dense mass of very short
streets IS the signal this map is for.
"""

import argparse
import glob
import gzip
import math
import os
import pickle
import sys
import time
from array import array
from collections import defaultdict

import numpy as np
from pmtiles.writer import Writer
from pmtiles.tile import Compression, TileType, zxy_to_tileid

EXTENT = 4096
TILE_BITS = 12                    # 4096 == 1 << 12
# Longest hop allowed between two consecutive vertices before it is
# subdivided. A segment longer than a tile can pass clean through a tile
# with neither endpoint inside it, and that tile would then be missing a
# road that crosses it. Half a tile is the cheap, safe bound.
MAX_HOP = EXTENT // 2
# A road shorter than one integer at this zoom still exists. Give it one
# screen pixel (EXTENT / 256) so it strokes instead of vanishing.
TICK = EXTENT // 256
# Vertices this far off the line between their neighbours are dropped.
# One unit is a sixteenth of a screen pixel at 256 px tiles, and the
# check below is against every point dropped since the last kept one, so
# this is a hard bound on the error and not a drift that accumulates.
# Measured on Connecticut: it removes 53% of the bytes at zoom 9 and 22%
# at zoom 14, which is the difference between a 96 MB archive and a 60 MB
# one. TIGER's own positional tolerance is 7.6 m; this is 0.5 m at z14.
SIMPLIFY = 1

STAGE_DIR = "_roadstage"       # overridden by --stage-dir


# ---------------------------------------------------------------------
# Minimal MVT writer
# ---------------------------------------------------------------------
# mapbox_vector_tile wants shapely geometries, which means building a
# million shapely objects per zoom — minutes of work to describe
# something that is already a flat list of integers. The format is small
# enough to emit directly: this is the whole of it.

def _varint(n, out):
    while n > 0x7F:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)


def _bytes_field(num, payload, out):
    _varint((num << 3) | 2, out)
    _varint(len(payload), out)
    out.extend(payload)


def encode_layer(name, runs, extent=EXTENT):
    """One MVT layer: a single LINESTRING feature holding every run."""
    geom = bytearray()
    cx = cy = 0
    for run in runs:
        pts = array("i")
        pts.frombytes(run)
        n = len(pts) // 2
        if n < 2:
            continue
        # MoveTo(1) then LineTo(n-1). The cursor carries over from the
        # previous run, which is exactly how MVT expresses a multi-part
        # line — no repeated header, no separate feature.
        _varint((1 << 3) | 1, geom)
        dx, dy = pts[0] - cx, pts[1] - cy
        _varint((dx << 1) ^ (dx >> 31), geom)
        _varint((dy << 1) ^ (dy >> 31), geom)
        cx, cy = pts[0], pts[1]
        _varint(((n - 1) << 3) | 2, geom)
        for i in range(1, n):
            x, y = pts[2 * i], pts[2 * i + 1]
            dx, dy = x - cx, y - cy
            _varint((dx << 1) ^ (dx >> 31), geom)
            _varint((dy << 1) ^ (dy >> 31), geom)
            cx, cy = x, y
    if not geom:
        return b""

    feature = bytearray()
    _varint((3 << 3) | 0, feature)          # type = LINESTRING
    _varint(2, feature)
    _bytes_field(4, geom, feature)          # packed geometry

    layer = bytearray()
    _varint((15 << 3) | 0, layer)           # version = 2
    _varint(2, layer)
    _bytes_field(1, name.encode(), layer)   # name
    _bytes_field(2, feature, layer)         # the one feature
    _varint((5 << 3) | 0, layer)            # extent
    _varint(extent, layer)
    return bytes(layer)


def encode_tile(by_rank, order):
    out = bytearray()
    for rank in order:
        runs = by_rank.get(rank)
        if not runs:
            continue
        layer = encode_layer(rank, runs)
        if layer:
            _bytes_field(3, layer, out)     # Tile.layers
    return bytes(out)


def merge_tiles(a, b):
    """
    Combine two encoded tiles covering the same ground.

    Only happens on the Connecticut/New York line, where each state's
    stage holds its own half of the same tile. A tile is a sequence of
    length-delimited layer messages, so concatenating two tiles is valid
    protobuf — but it leaves two layers with the same name, and a
    renderer is entitled to use either one. Both halves are unpacked and
    re-emitted as one layer per rank instead.
    """
    import mapbox_vector_tile
    runs = defaultdict(dict)
    for buf in (a, b):
        dec = mapbox_vector_tile.decode(gzip.decompress(buf),
                                        default_options={"y_coord_down": True})
        for name, layer in dec.items():
            for feat in layer["features"]:
                g = feat["geometry"]
                parts = (g["coordinates"] if g["type"] == "MultiLineString"
                         else [g["coordinates"]])
                for part in parts:
                    flat = array("i")
                    for x, y in part:
                        flat.append(int(x))
                        flat.append(int(y))
                    runs[name][flat.tobytes()] = None
    order = [r for r in RANK_ORDER if r in runs] or list(runs)
    return gzip.compress(encode_tile(runs, order), 6)


# Draw order, low rank first. Kept here as well as in fetchroads.py so
# pack can merge tiles without loading the source arrays.
RANK_ORDER = ["path", "track", "service", "local", "collector",
              "arterial", "ramp", "highway", "interstate"]


def thin(ax, ay, tol=SIMPLIFY):
    """
    Drop vertices that are within `tol` of the line they sit on.

    Deliberately not the usual one-pass version, which tests only the
    candidate vertex against the new chord: drop four vertices in a row
    off a gentle curve that way and the line can wander a long way from
    where it started, one tolerance at a time. Here every vertex dropped
    since the last kept one is re-tested against the chord, so `tol` is
    the real maximum deviation of the output from the input.
    """
    t2 = tol * tol
    ox, oy = [ax[0]], [ay[0]]
    pending = []                       # dropped since the last kept vertex
    for j in range(1, len(ax) - 1):
        x0, y0 = ox[-1], oy[-1]
        x2, y2 = ax[j + 1], ay[j + 1]
        dx, dy = x2 - x0, y2 - y0
        d2 = dx * dx + dy * dy
        ok = d2 > 0
        if ok:
            for px, py in pending + [(ax[j], ay[j])]:
                cr = (px - x0) * dy - (py - y0) * dx
                if cr * cr > t2 * d2:
                    ok = False
                    break
        if ok:
            pending.append((ax[j], ay[j]))
        else:
            ox.append(ax[j])
            oy.append(ay[j])
            pending = []
    ox.append(ax[-1])
    oy.append(ay[-1])
    return ox, oy


# ---------------------------------------------------------------------
# Cutting one zoom
# ---------------------------------------------------------------------
def cut_zoom(xs, ys, starts, counts, rank, ranks, z, zmax):
    """
    Every road, shifted to this zoom and split at tile boundaries.

    Returns {(tx, ty): {rank_name: {run_bytes: None}}} — the inner dict
    is a dict and not a set so identical runs collapse while the order
    stays reproducible between builds.
    """
    shift = zmax - z
    qx = xs >> shift if shift else xs
    qy = ys >> shift if shift else ys
    span = 1 << z

    buckets = defaultdict(lambda: defaultdict(dict))
    n_runs = 0

    for i in range(len(starts)):
        s = int(starts[i])
        c = int(counts[i])
        name = ranks[rank[i]]
        px = qx[s:s + c].tolist()
        py = qy[s:s + c].tolist()

        # Drop repeated vertices first: at low zoom most of a road's
        # geometry lands on one integer and this is where the saving is.
        ax, ay = [px[0]], [py[0]]
        for j in range(1, c):
            if px[j] != ax[-1] or py[j] != ay[-1]:
                ax.append(px[j])
                ay.append(py[j])

        if SIMPLIFY and len(ax) > 2:
            ax, ay = thin(ax, ay)

        if len(ax) == 1:
            # Collapsed to a point. Keep it as a one-pixel tick; see the
            # module docstring for why this is not rounded away.
            ax.append(ax[0] + TICK)
            ay.append(ay[0])

        tx = ax[0] >> TILE_BITS
        ty = ay[0] >> TILE_BITS
        run = array("i", [ax[0] - (tx << TILE_BITS), ay[0] - (ty << TILE_BITS)])

        def flush(tx, ty, run):
            nonlocal n_runs
            if len(run) < 4 or not (0 <= tx < span and 0 <= ty < span):
                return
            buckets[(tx, ty)][name][run.tobytes()] = None
            n_runs += 1

        for j in range(1, len(ax)):
            x0, y0 = ax[j - 1], ay[j - 1]
            x1, y1 = ax[j], ay[j]
            dx, dy = x1 - x0, y1 - y0
            steps = max(abs(dx), abs(dy)) // MAX_HOP + 1
            for k in range(1, steps + 1):
                nx = x0 + dx * k // steps
                ny = y0 + dy * k // steps
                ntx, nty = nx >> TILE_BITS, ny >> TILE_BITS
                if ntx == tx and nty == ty:
                    run.append(nx - (tx << TILE_BITS))
                    run.append(ny - (ty << TILE_BITS))
                    continue
                # Crossed into another tile. The point beyond the edge
                # goes into BOTH runs, so the line meets the tile border
                # from each side and there is no seam.
                run.append(nx - (tx << TILE_BITS))
                run.append(ny - (ty << TILE_BITS))
                flush(tx, ty, run)
                tx, ty = ntx, nty
                run = array("i", [x0 - (tx << TILE_BITS), y0 - (ty << TILE_BITS),
                                  nx - (tx << TILE_BITS), ny - (ty << TILE_BITS)])
        flush(tx, ty, run)

    return buckets, n_runs


def stage(src, zooms, stage_dir=STAGE_DIR):
    d = np.load(src, allow_pickle=False)
    xs, ys = d["xs"], d["ys"]
    starts, counts, rank = d["starts"], d["counts"], d["rank"]
    ranks = [str(r) for r in d["ranks"]]
    zmax = int(d["zmax"])
    print(f"  {len(starts):,} roads, {len(xs):,} vertices, grid z{zmax}",
          flush=True)

    os.makedirs(stage_dir, exist_ok=True)
    with open(os.path.join(stage_dir, "ranks.json"), "w") as fh:
        import json
        json.dump(ranks, fh)

    for z in zooms:
        t0 = time.time()
        buckets, n_runs = cut_zoom(xs, ys, starts, counts, rank, ranks, z, zmax)
        out = {}
        for (tx, ty), by_rank in buckets.items():
            buf = encode_tile(by_rank, ranks)
            if buf:
                out[zxy_to_tileid(z, tx, ty)] = gzip.compress(buf, 6)
        size = sum(len(v) for v in out.values())
        path = os.path.join(stage_dir, f"z{z:02d}.pkl")
        with open(path, "wb") as fh:
            pickle.dump(out, fh, protocol=4)
        big = max((len(v) for v in out.values()), default=0)
        print(f"  z{z}: {len(out):,} tiles, {n_runs:,} runs, "
              f"{size/1e6:.1f} MB (biggest tile {big/1e3:.0f} kB), "
              f"{time.time()-t0:.0f}s", flush=True)
        del buckets, out


def pack(out_path, minzoom, maxzoom, stage_dirs):
    import json
    stages = []
    for d in stage_dirs:
        stages += sorted(glob.glob(os.path.join(d, "z*.pkl")))
    if not stages:
        sys.exit("no stage files — run the stage step first")
    with open(os.path.join(stage_dirs[0], "ranks.json")) as fh:
        ranks = json.load(fh)

    # Two states staged separately merge here. Tiles can only collide
    # along the state line, where both archives hold the same tile id
    # with different roads in it — so they are merged rank by rank
    # rather than one overwriting the other.
    tiles = {}
    for p in stages:
        z = int(os.path.basename(p)[1:3])
        if not (minzoom <= z <= maxzoom):
            print(f"  skipping {p} (outside z{minzoom}-{maxzoom})", flush=True)
            continue
        with open(p, "rb") as fh:
            part = pickle.load(fh)
        clashes = 0
        for tid, buf in part.items():
            if tid in tiles:
                tiles[tid] = merge_tiles(tiles[tid], buf)
                clashes += 1
            else:
                tiles[tid] = buf
        note = f" ({clashes:,} shared with another stage)" if clashes else ""
        print(f"  loaded {p}{note}", flush=True)

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
                "min_lon_e7": int(-79.85 * 1e7),
                "min_lat_e7": int(40.40 * 1e7),
                "max_lon_e7": int(-71.70 * 1e7),
                "max_lat_e7": int(45.10 * 1e7),
                "center_zoom": 9,
                "center_lon_e7": int(-73.5 * 1e7),
                "center_lat_e7": int(41.8 * 1e7),
            },
            {
                "attribution": "US Census Bureau TIGER/Line, OpenStreetMap contributors",
                "name": "EveryPark roads",
                "vector_layers": [
                    {"id": r, "minzoom": minzoom, "maxzoom": maxzoom}
                    for r in ranks
                ],
            },
        )
    size = os.path.getsize(out_path)
    print(f"\n  {len(tiles):,} tiles -> {out_path} ({size/1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="stage", choices=["stage", "pack"])
    ap.add_argument("--src", default="raw/roads.npz")
    ap.add_argument("--zooms", nargs="+", type=int,
                    default=[7, 8, 9, 10, 11, 12, 13, 14])
    ap.add_argument("-o", "--out", default="data/roads.pmtiles")
    ap.add_argument("--stage-dir", nargs="+", default=[STAGE_DIR],
                    help="where stage pickles go (stage) or come from (pack)")
    ap.add_argument("--minzoom", type=int, default=7)
    ap.add_argument("--maxzoom", type=int, default=14)
    args = ap.parse_args()

    if args.cmd == "stage":
        stage(args.src, sorted(args.zooms), args.stage_dir[0])
    else:
        pack(args.out, args.minzoom, args.maxzoom, args.stage_dir)


if __name__ == "__main__":
    main()
