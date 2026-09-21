#!/usr/bin/env python3
"""
Pull every recorded road in Connecticut and New York, plus the trail
network, into one compact array for the tiler.

    python3 fetchroads.py                 # everything, to raw/roads.npz
    python3 fetchroads.py --states CT     # one state, for a quick measure
    python3 fetchroads.py --skip-trails   # roads only

WHY TIGER AND NOT OPENSTREETMAP
-------------------------------
The map already leans on OSM for parks and trails, so OSM was the
obvious first answer. Two things decided against it for roads:

  * Bulk OSM means a Geofabrik extract — 450 MB for New York alone,
    and the national extract host is not reachable from every machine
    this project is built on. Overpass cannot answer "every road in New
    York"; it times out long before it finishes.
  * TIGER/Line *is* the record of what roads exist. It is the Census
    Bureau's road census, updated yearly, published per county, and it
    carries a rank code (MTFCC) on every single feature. "Every road
    that is recorded" is literally what this file is.

TIGER's one weakness is trails: the Capitol Region planning area has
21,422 road features and exactly 24 walkways and bike paths in it. So
footpaths come from the same Esri-hosted OSM mirror the park trails
already use, and land in the same `path` rank.

WHAT COMES OUT
--------------
raw/roads.npz — five parallel arrays, no geometry library involved:

    xs, ys    int32, every vertex, already projected into Web Mercator
              and quantised to the tile grid at ZMAX (see below)
    starts    int64, index into xs/ys where each road begins
    counts    int32, how many vertices it has
    rank      uint8, index into RANKS

Coordinates are stored ONCE, in tile units at the deepest zoom. Every
lower zoom is then a right-shift: z13 units >> 1 are z12 units, exactly.
That is the whole reason the tiler is fast enough to run all zooms with
every road at every one of them — no reprojection, no simplification
pass, no floating point. Quantisation *is* the simplification.
"""

import argparse
import io
import math
import os
import re
import sys
import time
import zipfile
from collections import Counter

import numpy as np
import requests
import shapefile                      # pyshp — pure Python, reads .shp/.dbf

# Tile grid the coordinates are quantised to. 4096 units per tile at
# zoom 14 is 0.45 m on the ground at this latitude, which is finer than
# TIGER's own positional accuracy, so nothing real is lost. The whole
# world is then 2**14 * 4096 = 67.1 M units across, comfortably inside
# int32 — the reason this can be integers at all.
ZMAX = 14
EXTENT = 4096
WORLD = (2 ** ZMAX) * EXTENT

# Same rectangle as REGION_BBOX in fetchsources.py. TIGER files are
# already cut to county lines so this is a sanity net, not the filter.
REGION = (-79.85, 40.40, -71.70, 45.10)

TIGER_YEAR = 2025
TIGER_ROOT = f"https://www2.census.gov/geo/tiger/TIGER{TIGER_YEAR}/ROADS/"
STATE_FIPS = {"CT": "09", "NY": "36"}

# Esri's mirror of OSM trails, the same service the park trails come
# from (OSM6 in fetchsources.py). Layer 0 only, as there.
OSM_TRAILS = ("https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/"
              "services/OSM_NA_Trails/FeatureServer/0/query")

# ---------------------------------------------------------------------
# The rank ladder
# ---------------------------------------------------------------------
# Order matters: it is the draw order (last = on top) and the index
# stored in the `rank` array. Every styling decision in the browser
# keys on these names, so they are the contract between this file,
# makeroadtiles.py and CONFIG.roads.
RANKS = [
    "path",        # walkways, bike paths, bridle paths, OSM footpaths
    "track",       # 4WD vehicular trail: the edge of the road network
    "service",     # alleys, driveways, parking aisles, service drives
    "local",       # the neighbourhood street — 80% of every county file
    "collector",   # county roads and named through roads
    "arterial",    # numbered US and state routes
    "ramp",        # on and off ramps, drawn with the highways they serve
    "highway",     # limited-access road without an interstate number
    "interstate",  # I-84, I-91, I-95
]
RANK_ID = {name: i for i, name in enumerate(RANKS)}

# MTFCC is TIGER's feature class. The full list is in the TIGER
# technical documentation; these are every code the ROADS layer uses.
MTFCC_RANK = {
    "S1100": "highway",     # primary road — refined to interstate below
    "S1200": "collector",   # secondary road — refined to arterial below
    "S1400": "local",       # local neighborhood road, rural road, city street
    "S1500": "track",       # vehicular trail (4WD)
    "S1630": "ramp",
    "S1640": "service",     # service drive, usually along a limited-access road
    "S1710": "path",        # walkway / pedestrian trail
    "S1720": "path",        # stairway
    "S1730": "service",     # alley
    "S1740": "service",     # private road for service vehicles
    "S1750": "service",     # internal Census use
    "S1780": "service",     # parking lot road
    "S1820": "path",        # bike path or trail
    "S1830": "path",        # bridle path
}

# An interstate is not a separate MTFCC. It is a primary road whose
# route type is 'I' — which is also how the name reads: TIGER writes
# them "I- 84", with the space. Both tests are here because RTTYP is
# blank on a small number of genuine interstate segments.
INTERSTATE_NAME = re.compile(r"^I-\s*\d", re.I)


def rank_of(mtfcc, rttyp, name):
    base = MTFCC_RANK.get(mtfcc)
    if base is None:
        return None
    if base == "highway" and (rttyp == "I" or INTERSTATE_NAME.match(name or "")):
        return "interstate"
    # A secondary road carrying a US or state route number is an
    # arterial; the rest are county roads and local through roads.
    if base == "collector" and rttyp in ("U", "S", "I"):
        return "arterial"
    return base


# ---------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------
def project(lons, lats):
    """Lon/lat arrays -> int32 tile units at ZMAX. Vectorised."""
    lons = np.asarray(lons, dtype=np.float64)
    lats = np.clip(np.asarray(lats, dtype=np.float64), -85.05112878, 85.05112878)
    x = (lons + 180.0) / 360.0 * WORLD
    s = np.sin(np.radians(lats))
    y = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * WORLD
    np.clip(x, 0, WORLD - 1, out=x)
    np.clip(y, 0, WORLD - 1, out=y)
    return x.astype(np.int32), y.astype(np.int32)


# ---------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------
def get(url, **kw):
    """One GET with the retry ladder the rest of the project uses."""
    last = None
    for attempt in range(5):
        try:
            r = requests.get(url, timeout=kw.pop("timeout", 180), **kw)
            if r.status_code == 200:
                return r
            last = f"HTTP {r.status_code}"
        except Exception as e:                      # noqa: BLE001
            last = str(e)
        wait = 2 ** attempt
        print(f"    retry in {wait}s ({last})", flush=True)
        time.sleep(wait)
    raise RuntimeError(f"{url}: {last}")


def county_files(state):
    """Every county road file the Census publishes for this state."""
    fips = STATE_FIPS[state]
    html = get(TIGER_ROOT).text
    names = sorted(set(re.findall(
        rf"tl_{TIGER_YEAR}_({fips}\d{{3}})_roads\.zip", html)))
    if not names:
        raise RuntimeError(f"no {state} county files listed at {TIGER_ROOT}")
    return names


def read_county(fips, cache_dir):
    """Download (once) and parse one county's roads."""
    name = f"tl_{TIGER_YEAR}_{fips}_roads"
    path = os.path.join(cache_dir, name + ".zip")
    if not os.path.exists(path):
        r = get(TIGER_ROOT + name + ".zip")
        with open(path, "wb") as fh:
            fh.write(r.content)
    with zipfile.ZipFile(path) as z:
        sf = shapefile.Reader(
            shp=io.BytesIO(z.read(name + ".shp")),
            dbf=io.BytesIO(z.read(name + ".dbf")),
            shx=io.BytesIO(z.read(name + ".shx")))
        # shapeRecords() materialises everything at once; iterating in
        # step keeps a county's peak memory to one feature.
        for shp, rec in zip(sf.iterShapes(), sf.iterRecords()):
            yield rec, shp


def esri_count(url, where, bbox):
    js = get(url, params={"where": where, "returnCountOnly": "true",
                          "f": "json", "geometry": ",".join(map(str, bbox)),
                          "geometryType": "esriGeometryEnvelope",
                          "inSR": "4326",
                          "spatialRel": "esriSpatialRelIntersects"}).json()
    if "error" in js:
        raise RuntimeError(js["error"])
    return js["count"]


def esri_paged(url, where, fields, bbox, page=1000, tile_max=4000, depth_max=6):
    """
    Page an ArcGIS FeatureServer by splitting the map, not by offset.

    Deep resultOffset paging is what fetchsources.py learned not to
    trust on this mirror: past a few thousand records the service starts
    refusing, and a refusal that returns an empty page looks exactly
    like the end of the data. So a box is quartered until the service
    says it holds few enough features to answer in a couple of pages,
    and a box whose COUNT query errors is quartered on that evidence
    alone.
    """
    def leaves(box, depth=0):
        try:
            total = esri_count(url, where, box)
            small = total <= tile_max
        except Exception:                           # noqa: BLE001
            total, small = None, False
        if small or depth >= depth_max:
            return [(box, total)] if total is None or total else []
        w, s, e, n = box
        mx, my = (w + e) / 2, (s + n) / 2
        out = []
        for q in ((w, s, mx, my), (mx, s, e, my),
                  (w, my, mx, n), (mx, my, e, n)):
            out.extend(leaves(q, depth + 1))
        return out

    plan = leaves(tuple(bbox))
    print(f"  {len(plan)} boxes to page", flush=True)
    for box, total in plan:
        offset = 0
        while True:
            js = get(url, params={
                "where": where, "outFields": fields, "f": "json",
                "returnGeometry": "true", "outSR": "4326",
                "geometry": ",".join(map(str, box)),
                "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
                "resultOffset": offset, "resultRecordCount": page,
            }).json()
            if "error" in js:
                raise RuntimeError(js["error"])
            feats = js.get("features") or []
            for f in feats:
                yield f
            offset += len(feats)
            if len(feats) < page or offset >= (total or 0):
                break


# ---------------------------------------------------------------------
# Accumulation
# ---------------------------------------------------------------------
class Roads:
    """Grows the five parallel arrays a chunk at a time."""

    def __init__(self):
        self.xs, self.ys = [], []
        self.counts, self.ranks = [], []
        self.seen = set()          # LINEARID, so county-line roads land once
        self.tally = Counter()
        self.dupes = 0
        self.points = 0

    def add(self, lons, lats, rank, uid=None):
        if uid is not None:
            if uid in self.seen:
                self.dupes += 1
                return
            self.seen.add(uid)
        if len(lons) < 2:
            return
        x, y = project(lons, lats)
        self.xs.append(x)
        self.ys.append(y)
        self.counts.append(len(x))
        self.ranks.append(RANK_ID[rank])
        self.tally[rank] += 1
        self.points += len(x)

    def save(self, path):
        xs = np.concatenate(self.xs) if self.xs else np.zeros(0, np.int32)
        ys = np.concatenate(self.ys) if self.ys else np.zeros(0, np.int32)
        counts = np.array(self.counts, dtype=np.int32)
        starts = np.zeros(len(counts), dtype=np.int64)
        if len(counts):
            np.cumsum(counts[:-1], out=starts[1:])
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        np.savez(path, xs=xs, ys=ys, starts=starts, counts=counts,
                 rank=np.array(self.ranks, dtype=np.uint8),
                 ranks=np.array(RANKS), zmax=np.int32(ZMAX),
                 extent=np.int32(EXTENT))
        return xs.nbytes + ys.nbytes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--states", nargs="+", default=["CT", "NY"])
    ap.add_argument("--skip-trails", action="store_true")
    ap.add_argument("--out", default="raw/roads.npz")
    ap.add_argument("--cache", default="raw/tiger")
    args = ap.parse_args()

    os.makedirs(args.cache, exist_ok=True)
    roads = Roads()
    t0 = time.time()

    for state in args.states:
        if state.lower() == "none":
            continue
        fipses = county_files(state)
        print(f"{state}: {len(fipses)} county files", flush=True)
        for i, fips in enumerate(fipses, 1):
            n = 0
            for rec, shp in read_county(fips, args.cache):
                rank = rank_of(rec["MTFCC"], rec["RTTYP"], rec["FULLNAME"])
                if rank is None:
                    continue
                pts = shp.points
                if len(pts) < 2:
                    continue
                # TIGER stores one road as one part; a multi-part shape
                # would need splitting, and there are none in ROADS.
                lons = [p[0] for p in pts]
                lats = [p[1] for p in pts]
                if (max(lons) < REGION[0] or min(lons) > REGION[2]
                        or max(lats) < REGION[1] or min(lats) > REGION[3]):
                    continue
                try:
                    uid = int(rec["LINEARID"])
                except (TypeError, ValueError):
                    uid = rec["LINEARID"]
                roads.add(lons, lats, rank, uid)
                n += 1
            print(f"  [{i:>2}/{len(fipses)}] {fips}: {n:>7,} roads "
                  f"({roads.points/1e6:.1f}M vertices so far)", flush=True)

    if not args.skip_trails:
        # Trails have no LINEARID; the service is a single coherent
        # dataset so there is nothing to deduplicate against.
        print("trails: paging Esri's OSM mirror", flush=True)
        n = 0
        seen_trails = set()
        for f in esri_paged(OSM_TRAILS,
                            "highway IN ('path','track','bridleway')",
                            "highway", REGION):
            g = f.get("geometry") or {}
            hw = (f.get("attributes") or {}).get("highway")
            rank = "track" if hw == "track" else "path"
            for part in g.get("paths") or []:
                if len(part) < 2:
                    continue
                # Boxes overlap on their shared edges, so the same trail
                # comes back more than once. Its first and last vertex
                # are identity enough.
                key = (round(part[0][0], 6), round(part[0][1], 6),
                       round(part[-1][0], 6), round(part[-1][1], 6), len(part))
                if key in seen_trails:
                    continue
                seen_trails.add(key)
                roads.add([p[0] for p in part], [p[1] for p in part], rank)
                n += 1
            if n and n % 20000 == 0:
                print(f"  {n:,} trail segments", flush=True)
        print(f"  {n:,} trail segments", flush=True)

    nbytes = roads.save(args.out)
    total = sum(roads.tally.values())
    print(f"\n{total:,} roads, {roads.points:,} vertices "
          f"({nbytes/1e6:.0f} MB of coordinates), "
          f"{roads.dupes:,} county-line duplicates dropped, "
          f"{time.time()-t0:.0f}s")
    for name in reversed(RANKS):
        c = roads.tally[name]
        print(f"  {name:<11} {c:>9,}  {100*c/max(total,1):>5.1f}%")
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
