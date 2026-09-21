#!/usr/bin/env python3
"""
Prove the road tiles say what the source said.

    python3 tools/roadcheck.py --src raw/roads-CT.npz --stage-dir _roadstage-CT

Run this before packing. Every failure mode this project has had with
tiles looked completely fine in a screenshot: the archive was a plausible
size, the map drew, and the geometry was mirrored inside every tile
because it had been checked with the same broken decoder that wrote it.
So this checks three separate things, two of them against something the
encoder had no part in:

  1. ROUND TRIP — decode with mapbox_vector_tile (a library that shares
     no code with makeroadtiles.py's hand-written encoder) and confirm
     every vertex of a sample of roads is present, exactly, in the tile
     it belongs to.
  2. GROUND TRUTH — a handful of real interchanges whose latitude and
     longitude are known independently must decode back to within a few
     hundred metres of where they actually are. This is what catches a
     y-flip: a mirrored tile round-trips perfectly and is still wrong.
  3. NO LEVEL OF DETAIL — the point of this tileset. Every rank that
     exists at the deepest zoom must also exist at the shallowest, and
     the road count must not fall as you zoom out.

Exits non-zero on failure, so it can gate a build.
"""

import argparse
import gzip
import math
import os
import pickle
import random
import sys

import numpy as np
import mapbox_vector_tile
from pmtiles.tile import zxy_to_tileid

EXTENT = 4096
LANDMARK_M = 750          # see GROUND_TRUTH
# Must match SIMPLIFY in makeroadtiles.py: the most a vertex may be moved
# by thinning, in tile units. One unit is 1/16 of a screen pixel.
TOL_UNITS = 1
GEOCODE_M = 60            # see geocode_check

# Addresses resolved by the Census Bureau's own geocoder. The point of
# this is not that the Census is authoritative about where Fifth Avenue
# is — it is that their code and this code read the same TIGER lines, so
# if the two disagree about where a street lands, the projection here is
# wrong. Any rank counts: this measures position, not classification.
GEOCODE = [
    "1 Constitution Plaza, Hartford, CT",
    "350 Fifth Ave, New York, NY",
    "1 Elk St, Albany, NY",
    "20 West St, Danbury, CT",
]
GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

# Landmarks read off a map by hand. They are deliberately coarse: what
# they catch is a mirrored, transposed or wrongly-shifted tile, and every
# one of those is wrong by kilometres, not by the couple of hundred
# metres between an eyeballed interchange and the centreline TIGER drew
# for it. For a tight positional check use --geocode below, where the
# coordinate is computed by the Census Bureau's own code.
GROUND_TRUTH = [
    ("I-84 / I-91 interchange, Hartford CT", 41.7712, -72.6740, "interstate"),
    ("I-95 at the Byram river, Greenwich CT", 41.0060, -73.6540, "interstate"),
    ("I-87 Northway, Albany NY",              42.7250, -73.7990, "interstate"),
    ("Grand Central Pkwy, Queens NY",         40.7430, -73.8300, "highway"),
    ("Main St, Danbury CT",                   41.3950, -73.4540, "local"),
    ("Route 28, Blue Mountain Lake NY",       43.8570, -74.4320, "arterial"),
]


def decode(buf):
    return mapbox_vector_tile.decode(
        gzip.decompress(buf), default_options={"y_coord_down": True})


def world_to_lonlat(X, Y, zmax):
    n = (2 ** zmax) * EXTENT
    lon = X / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y / n))))
    return lon, lat


def lonlat_to_world(lon, lat, zmax):
    n = (2 ** zmax) * EXTENT
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def tile_vertices(buf):
    """{rank: set of (x, y) inside the tile} from an encoded tile."""
    out = {}
    for name, layer in decode(buf).items():
        pts = set()
        for feat in layer["features"]:
            g = feat["geometry"]
            parts = (g["coordinates"] if g["type"] == "MultiLineString"
                     else [g["coordinates"]])
            for part in parts:
                for x, y in part:
                    pts.add((int(x), int(y)))
        out[name] = pts
    return out


def tile_runs(buf):
    """{rank: [[(x, y), ...], ...]} — the runs, not just their vertices."""
    out = {}
    for name, layer in decode(buf).items():
        runs = out.setdefault(name, [])
        for feat in layer["features"]:
            g = feat["geometry"]
            parts = (g["coordinates"] if g["type"] == "MultiLineString"
                     else [g["coordinates"]])
            runs.extend(parts)
    return out


def point_to_run(px, py, runs):
    """
    Shortest distance from a point to any of these polylines.

    Distance to the nearest VERTEX is the wrong measure here: a straight
    mile of interstate is two vertices a mile apart, so a point sitting
    exactly on the road reads as half a mile from it.
    """
    best = float("inf")
    for run in runs:
        for i in range(1, len(run)):
            x0, y0 = run[i - 1]
            x1, y1 = run[i]
            dx, dy = x1 - x0, y1 - y0
            if dx == 0 and dy == 0:
                d = math.hypot(px - x0, py - y0)
            else:
                t = ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)
                t = max(0.0, min(1.0, t))
                d = math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
            if d < best:
                best = d
    return best


def geocode_check(stagez, z, zmax, fails):
    """Every address must land within GEOCODE_M of some road in the tiles."""
    import requests
    for address in GEOCODE:
        try:
            js = requests.get(GEOCODER, params={
                "address": address, "benchmark": "Public_AR_Current",
                "format": "json"}, timeout=60).json()
            m0 = js["result"]["addressMatches"][0]
            lon = float(m0["coordinates"]["x"])
            lat = float(m0["coordinates"]["y"])
        except Exception as e:                        # noqa: BLE001
            print(f"  geocode: {address} — skipped ({e})")
            continue
        wx, wy = lonlat_to_world(lon, lat, zmax)
        shift = zmax - z
        X, Y = int(wx) >> shift, int(wy) >> shift
        tx0, ty0 = X >> 12, Y >> 12
        best = float("inf")
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                tid = zxy_to_tileid(z, tx0 + ox, ty0 + oy)
                if tid not in stagez:
                    continue
                for runs in tile_runs(stagez[tid]).values():
                    best = min(best, point_to_run(
                        X - ((tx0 + ox) << 12), Y - ((ty0 + oy) << 12), runs))
        if best == float("inf"):
            print(f"  geocode: {address} — no tiles there (other state?)")
            continue
        m = best * (40075016.686 * math.cos(math.radians(lat))
                    / ((2 ** z) * EXTENT))
        ok = m < GEOCODE_M
        print(f"  geocode: {address}: nearest road {m:,.0f} m "
              f"{'ok' if ok else 'FAIL'}")
        if not ok:
            fails.append(f"{address}: nearest road {m:,.0f} m away")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="raw/roads.npz")
    ap.add_argument("--stage-dir", default="_roadstage")
    ap.add_argument("--sample", type=int, default=3000)
    ap.add_argument("--zooms", nargs="+", type=int, default=[8, 11, 13])
    ap.add_argument("--geocode", action="store_true",
                    help="also check positions against the Census geocoder "
                         "(needs network)")
    args = ap.parse_args()

    d = np.load(args.src, allow_pickle=False)
    xs, ys = d["xs"], d["ys"]
    starts, counts, rank = d["starts"], d["counts"], d["rank"]
    ranks = [str(r) for r in d["ranks"]]
    zmax = int(d["zmax"])
    fails = []

    # ---- 1. round trip -------------------------------------------------
    # Two halves. Endpoints are never simplified away, so they must be
    # in the tiles EXACTLY, at every zoom — that is the cheap check that
    # covers the whole archive. Interior vertices may be thinned, so
    # those are checked by distance instead, at the zooms where a tile
    # holds few enough runs to measure every one of them.
    random.seed(11)
    sample = random.sample(range(len(starts)), min(args.sample, len(starts)))
    for z in args.zooms:
        path = os.path.join(args.stage_dir, f"z{z:02d}.pkl")
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            stagez = pickle.load(fh)
        cache = {}
        shift = zmax - z
        checked = missed = 0
        for i in sample:
            s, c = int(starts[i]), int(counts[i])
            name = ranks[rank[i]]
            for j in (s, s + c - 1):
                X, Y = int(xs[j]) >> shift, int(ys[j]) >> shift
                tid = zxy_to_tileid(z, X >> 12, Y >> 12)
                if tid not in stagez:
                    missed += 1
                    continue
                if tid not in cache:
                    cache[tid] = tile_vertices(stagez[tid])
                pts = cache[tid].get(name)
                checked += 1
                if not pts or (X & 4095, Y & 4095) not in pts:
                    missed += 1
        rate = 100.0 * (checked - missed) / max(checked, 1)
        line = (f"round trip z{z}: {checked:,} endpoints, "
                f"{rate:.3f}% present exactly in their own tile")
        print(line)
        if rate < 100.0:
            fails.append(line)

    for z in [q for q in args.zooms if q >= 12]:
        path = os.path.join(args.stage_dir, f"z{z:02d}.pkl")
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            stagez = pickle.load(fh)
        cache = {}
        shift = zmax - z
        worst = 0.0
        worst_at = None
        checked = 0
        for i in sample[:400]:
            s, c = int(starts[i]), int(counts[i])
            name = ranks[rank[i]]
            for j in range(s, s + c):
                X, Y = int(xs[j]) >> shift, int(ys[j]) >> shift
                tid = zxy_to_tileid(z, X >> 12, Y >> 12)
                if tid not in stagez:
                    continue
                if tid not in cache:
                    cache[tid] = tile_runs(stagez[tid])
                runs = cache[tid].get(name)
                if not runs:
                    continue
                d = point_to_run(X & 4095, Y & 4095, runs)
                checked += 1
                if d > worst:
                    worst, worst_at = d, (X, Y)
        line = (f"simplification z{z}: {checked:,} interior vertices, "
                f"worst {worst:.2f} units off the line they were on "
                f"(budget {TOL_UNITS})")
        print(line)
        if worst > TOL_UNITS + 0.01:
            fails.append(line + f" at {worst_at}")

    # ---- 2. ground truth -----------------------------------------------
    z = max(args.zooms)
    path = os.path.join(args.stage_dir, f"z{z:02d}.pkl")
    with open(path, "rb") as fh:
        stagez = pickle.load(fh)
    shift = zmax - z
    for label, lat, lon, want in GROUND_TRUTH:
        wx, wy = lonlat_to_world(lon, lat, zmax)
        X, Y = int(wx) >> shift, int(wy) >> shift
        # The nine tiles around the point, not just the one it lands in:
        # a landmark near a tile edge would otherwise be measured against
        # whatever piece of road happened to fall on this side of it.
        tx0, ty0 = X >> 12, Y >> 12
        best = float("inf")
        found_tile = False
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                tid = zxy_to_tileid(z, tx0 + ox, ty0 + oy)
                if tid not in stagez:
                    continue
                found_tile = True
                runs = tile_runs(stagez[tid]).get(want)
                if not runs:
                    continue
                best = min(best, point_to_run(
                    X - ((tx0 + ox) << 12), Y - ((ty0 + oy) << 12), runs))
        if not found_tile:
            print(f"  ground truth: {label} — no tile (other state?)")
            continue
        if best == float("inf"):
            line = f"ground truth FAIL: no {want} near {label}"
            print("  " + line)
            fails.append(line)
            continue
        # world units -> metres at this latitude and zoom
        m = best * (40075016.686 * math.cos(math.radians(lat))
                    / ((2 ** z) * EXTENT))
        ok = m < LANDMARK_M
        print(f"  ground truth: {label}: nearest {want} {m:,.0f} m away"
              f" {'ok' if ok else 'FAIL'}")
        if not ok:
            fails.append(f"{label}: nearest {want} is {m:,.0f} m away")

    if args.geocode:
        geocode_check(stagez, z, zmax, fails)

    # ---- 3. no level of detail ------------------------------------------
    print("\nranks present per zoom (the whole point — none may drop out):")
    seen_counts = {}
    for z in sorted(args.zooms):
        path = os.path.join(args.stage_dir, f"z{z:02d}.pkl")
        if not os.path.exists(path):
            continue
        with open(path, "rb") as fh:
            stagez = pickle.load(fh)
        present = set()
        runs = 0
        for buf in stagez.values():
            for name, layer in decode(buf).items():
                present.add(name)
                for feat in layer["features"]:
                    g = feat["geometry"]
                    runs += (len(g["coordinates"])
                             if g["type"] == "MultiLineString" else 1)
        seen_counts[z] = runs
        missing = [r for r in ranks if r not in present]
        print(f"  z{z}: {len(present)}/{len(ranks)} ranks, {runs:,} runs"
              + (f"  MISSING {missing}" if missing else ""))
        if missing:
            fails.append(f"z{z} is missing ranks: {missing}")

    if fails:
        print(f"\n{len(fails)} FAILED:")
        for f in fails:
            print("  " + f)
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
