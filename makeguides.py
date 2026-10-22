#!/usr/bin/env python3
"""
Bake a guide for each park in data/testset.json.

    python3 makeguides.py                   # every park in the test set
    python3 makeguides.py --only bc69dafa2a # one park, by id
    python3 makeguides.py --no-elev         # skip terrain sampling

WHAT A GUIDE IS
---------------
Everything the 3D viewer needs to put you at a way in and walk you along
the blazes, decided once, here, instead of in the browser on every open:

  * the boundary, from CT DEEP's property layer (the boundary of record)
  * the trails as a ROUTABLE GRAPH: junctions are nodes, the stretches
    between them are edges carrying name, blaze, surface, length, climb
  * the ways in: DEEP's own access points, plus every place a trail
    meets a public road
  * named features: summits and falls from the USGS gazetteer, towers,
    viewpoints, toilets and the rest from OpenStreetMap

The viewer has always fetched trails live, but as raster cells and
loose lines. A route needs to know that two lines MEET, and the raw
data does not say so. That is the hard part of this file (build_graph).

WHY BUILD-SIDE, AND WHY ONLY TEN
--------------------------------
Timothy, 2026-10-22: accuracy first, proven on ten parks before going
wide (INTENT.md). A baked guide can be audited (every number in
docs/TESTSET.md comes from data/guides/audit.json, which this writes),
and a live fetch cannot. It is also the shape offline guides will need
later, but that is not why it exists now.

SOURCES, AND WHICH ONE WINS
---------------------------
DEEP's trail layer is the agency's own record and carries the blaze
(TRAILMARK), so where it has a trail it wins. OpenStreetMap is used for
what DEEP does not have, and those edges stay marked `osm` so the viewer
and the directions can say so. Two sources AGREE on a stretch when they
run within AGREE_M of each other; the audit reports both directions of
that, because "DEEP has a trail OSM lacks" and "OSM has a path DEEP
lacks" are different problems.

Overpass is not used: it is unreachable from at least one machine this
is built on. The Esri-hosted OSM mirror carries the same trails, but
NOT parking lots (nodes only, and most lots are mapped as areas), which
is why ways in are derived from road contact rather than from parking.
A road access point says where a trail reaches a road. It does not
claim there is anywhere to park.

WHAT COMES OUT
--------------
data/guides/<id>.json   GENERATED. One park.
data/guides/audit.json  GENERATED. The measured numbers, all ten parks.
"""

import argparse
import io
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import date

import requests

DEEP = "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/"
OSM6 = "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/"
GAZ = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/"
TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

URL_PROPERTY = DEEP + "Connecticut_DEEP_Property/FeatureServer/0/query"
URL_TRAILS = DEEP + "DEEP_Trails_Set/FeatureServer/3/query"
URL_INTEREST = DEEP + "DEEP_Trails_Set/FeatureServer/2/query"
URL_ACCESS = DEEP + "DEEP_Property_Access_Locations/FeatureServer/0/query"
URL_OSM_TRAILS = OSM6 + "OSM_NA_Trails/FeatureServer/0/query"
URL_OSM_ROADS = OSM6 + "OSM_NA_Highways/FeatureServer/0/query"
URL_OSM_POIS = OSM6 + "OSM_NA_POIs/FeatureServer/0/query"
URL_OSM_TOURISM = OSM6 + "OSM_NA_Tourism/FeatureServer/0/query"
URL_OSM_AMENITY = OSM6 + "OSM_NA_Amenities/FeatureServer/0/query"

SNAP_M = 8        # two line ends this close are one junction
OSM_SNAP_M = 30   # an OSM-only stretch ends this far from the DEEP line it joins
NEAR_M = 150      # how far outside the boundary a trail is kept
AGREE_M = 25      # two sources are describing the same trail
ROAD_M = 15       # a trail node this close to a public road is a way in
ON_ROAD_M = 12    # a DEEP "trail" this close to an OSM road is the road
ENTRY_SNAP_M = 300  # an access point further than this from any trail reaches none
STEP_M = 10       # sampling step along lines, for every distance test
TERRAIN_Z = 14    # ~7 m pixels at 41.5 N; finer than the 20 m viewer block

# A trail meeting one of these is a way in. Footways and tracks are not
# roads in this sense, and an unnamed service road is usually a
# driveway, so those count only inside the park, where they are the
# park's own roads to its own lots.
PUBLIC_ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary",
                "unclassified", "residential", "living_street",
                "primary_link", "secondary_link", "tertiary_link"}
PATHS = ("path", "footway", "track", "bridleway", "cycleway", "steps",
         "pedestrian")

# Roads a person can walk along to get between trails. Primary roads and
# up are left out: walking the shoulder of Route 7 is not a route a guide
# should ever suggest, even where it is the short way.
WALK_ROADS = {"tertiary", "unclassified", "residential", "living_street",
              "service", "tertiary_link"}


def walkable_road(a):
    if a.get("highway") not in WALK_ROADS:
        return False
    if (a.get("access") or "") in ("private", "no"):
        return False
    # Driveways are somebody's house; lot aisles are noise, and a way in
    # inside a lot snaps to the trail anyway.
    return (a.get("service") or "") not in ("driveway", "parking_aisle",
                                            "drive-through")


DEEP_TRAIL_FIELDS = ["TRAILSYSID", "TRAILNAME", "TRAILCLASS", "TRAILSURF",
                     "TRAILMARK", "PUBACCESS", "HIKE", "WALK", "BIKE",
                     "MTNBIKE", "EQUESTRIAN", "CROSSCSKI", "SNOWMOBILE",
                     "ADAACCESS", "DOGLEASH", "DOGUNLEASH", "SPECIALPERMIT",
                     "TRAILCOMMENTS", "HORIZACCUR"]
# Permissions DEEP records per segment, as the strings "True"/"False"/
# "Unknown". Not booleans, and not truthy-safe: "False" is truthy.
DEEP_USES = {"HIKE": "hike", "WALK": "walk", "BIKE": "bike",
             "MTNBIKE": "mtnbike", "EQUESTRIAN": "horse", "CROSSCSKI": "ski",
             "SNOWMOBILE": "snowmobile", "ADAACCESS": "ada",
             "DOGLEASH": "dogleash", "DOGUNLEASH": "dogfree"}

S = requests.Session()


# ---- Fetching -------------------------------------------------------

def arc(url, params, tries=4):
    """POST an ArcGIS query, following exceededTransferLimit by offset."""
    base = {"f": "json", **params}
    out, offset = [], 0
    while True:
        q = dict(base, resultOffset=offset) if offset else base
        for k in range(tries):
            try:
                r = S.post(url, data=q, timeout=90)
                d = r.json()
                if "error" in d:
                    raise RuntimeError(d["error"])
                break
            except Exception as e:                      # noqa: BLE001
                if k == tries - 1:
                    raise RuntimeError(f"{url}: {e}") from e
                time.sleep(2 ** k)
        feats = d.get("features") or []
        out += feats
        if not d.get("exceededTransferLimit") or not feats:
            return out
        offset += len(feats)


def envelope(bbox):
    w, s, e, n = bbox
    return {"geometry": json.dumps({"xmin": w, "ymin": s, "xmax": e,
                                    "ymax": n,
                                    "spatialReference": {"wkid": 4326}}),
            "geometryType": "esriGeometryEnvelope", "inSR": "4326",
            "outSR": "4326", "spatialRel": "esriSpatialRelIntersects"}


def sql(s):
    return s.replace("'", "''")


# ---- Local metric geometry -------------------------------------------
# Everything below is done in metres on a flat plane centred on the
# park. At park scale (a few km) the error of that is well under 1%,
# and it keeps every distance test a plain hypot.

class Plane:
    def __init__(self, lat0, lng0):
        self.lat0, self.lng0 = lat0, lng0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110574.0

    def xy(self, lng, lat):
        return ((lng - self.lng0) * self.kx, (lat - self.lat0) * self.ky)

    def ll(self, x, y):
        return (self.lng0 + x / self.kx, self.lat0 + y / self.ky)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    qx, qy = ax + t * dx, ay + t * dy
    return math.hypot(px - qx, py - qy), t


def line_len(pts):
    return sum(math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
               for i in range(len(pts) - 1))


def samples(pts, step=STEP_M):
    """Points along a line every `step` metres, with the edge each is on."""
    out = []
    for i in range(len(pts) - 1):
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        L = math.hypot(bx - ax, by - ay)
        n = max(1, int(L // step))
        for k in range(n):
            t = k / n
            out.append((ax + t * (bx - ax), ay + t * (by - ay), i, L / n))
    if pts:
        out.append((pts[-1][0], pts[-1][1], len(pts) - 2, 0.0))
    return out


class SegGrid:
    """Nearest-segment lookups over many polylines, on a coarse grid."""

    def __init__(self, cell=50.0):
        self.cell = cell
        self.g = defaultdict(list)

    def add(self, key, i, a, b):
        c = self.cell
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        for gx in range(int(math.floor(x0 / c)), int(math.floor(x1 / c)) + 1):
            for gy in range(int(math.floor(y0 / c)), int(math.floor(y1 / c)) + 1):
                self.g[(gx, gy)].append((key, i, a, b))

    def add_line(self, key, pts):
        for i in range(len(pts) - 1):
            self.add(key, i, pts[i], pts[i + 1])

    def near(self, x, y, r):
        """Every (d, key, i, t) within r, nearest first, one per key."""
        c = self.cell
        best = {}
        for gx in range(int(math.floor((x - r) / c)), int(math.floor((x + r) / c)) + 1):
            for gy in range(int(math.floor((y - r) / c)), int(math.floor((y + r) / c)) + 1):
                for key, i, a, b in self.g.get((gx, gy), ()):
                    d, t = seg_dist(x, y, a[0], a[1], b[0], b[1])
                    if d <= r and (key not in best or d < best[key][0]):
                        best[key] = (d, key, i, t)
        return sorted(best.values())

    def dist(self, x, y, r):
        hits = self.near(x, y, r)
        return hits[0][0] if hits else math.inf


def inside(rings, x, y):
    """Even-odd, so holes are holes without trusting ring winding."""
    c = False
    for ring in rings:
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
            j = i
    return c


def ring_area_m2(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return a / 2


# ---- Elevation ------------------------------------------------------

class Terrain:
    """Bilinear samples from AWS terrarium tiles, cached under raw/."""

    def __init__(self, cache="raw/terrain"):
        self.cache = cache
        self.tiles = {}
        os.makedirs(cache, exist_ok=True)

    def _tile(self, x, y):
        k = (x, y)
        if k in self.tiles:
            return self.tiles[k]
        from PIL import Image                           # only when sampling
        path = os.path.join(self.cache, f"{TERRAIN_Z}_{x}_{y}.png")
        if not os.path.exists(path):
            r = S.get(TERRAIN.format(z=TERRAIN_Z, x=x, y=y), timeout=60)
            r.raise_for_status()
            with open(path, "wb") as fh:
                fh.write(r.content)
        im = Image.open(path).convert("RGB")
        self.tiles[k] = im.load()
        return self.tiles[k]

    def _px(self, X, Y):
        tx, ty = int(X // 256), int(Y // 256)
        px = self._tile(tx, ty)
        r, g, b = px[int(X) % 256, int(Y) % 256]
        return r * 256 + g + b / 256 - 32768

    def at(self, lng, lat):
        n = 2 ** TERRAIN_Z
        X = (lng + 180) / 360 * n * 256
        lr = math.radians(lat)
        Y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n * 256
        X -= 0.5
        Y -= 0.5
        x0, y0 = math.floor(X), math.floor(Y)
        fx, fy = X - x0, Y - y0
        h00, h10 = self._px(x0, y0), self._px(x0 + 1, y0)
        h01, h11 = self._px(x0, y0 + 1), self._px(x0 + 1, y0 + 1)
        return (h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy)
                + h01 * (1 - fx) * fy + h11 * fx * fy)


def climb(heights, noise=1.5):
    """Up and down along a profile, ignoring wiggles under `noise` metres.

    Summing every tiny rise in a 7 m DEM reports a flat towpath as a
    hill walk; the hysteresis keeps only changes that persist.
    """
    up = down = 0.0
    if not heights:
        return 0.0, 0.0
    ref = heights[0]
    for h in heights[1:]:
        if h - ref >= noise:
            up += h - ref
            ref = h
        elif ref - h >= noise:
            down += ref - h
            ref = h
    # What is left under the noise floor at the end still happened.
    # Dropping it made up minus down differ from the edge's net change,
    # and a route summed from twenty short edges then reported less climb
    # than the height it gains: 176 m to a summit 189 m above the start.
    if heights[-1] > ref:
        up += heights[-1] - ref
    else:
        down += ref - heights[-1]
    return up, down


# ---- Normalising the sources ----------------------------------------

COLOURS = ("light blue", "blue", "white", "red", "yellow", "orange", "green",
           "purple", "violet", "pink", "black", "brown", "teal", "aqua",
           "silver", "gold", "grey", "gray", "tan")


def blaze_of(mark):
    """DEEP's TRAILMARK as words: 'Blue', 'Blue/Red Dot', 'Unblazed'...

    Returned as a tidy string plus the colours it names, in order, so
    the viewer can paint the first and dot the second without parsing.
    """
    # "None/White Tree" is DEEP saying this trail has no blaze of its own
    # and shares the path with one marked by a white tree. Printed as is
    # it became "the NONE/WHITE TREE blazes", which is nonsense on a
    # trail; the None part is dropped and the real mark kept.
    parts = [p.strip() for p in re.split(r"/", mark or "") if p.strip()]
    # A mark with no colour in it is not paint: "None", "Unknown", and
    # "Park Road" (a trail along a road, at one park) all say so.
    parts = [p for p in parts
             if any(re.search(r"(^|[^a-z])" + c + r"($|[^a-z])", p.lower()) for c in COLOURS)]
    if not parts:
        return None, []
    s = "/".join(parts)
    low = s.lower()
    found = []
    i = 0
    while i < len(low):
        for c in COLOURS:
            if low.startswith(c, i) and (i == 0 or not low[i - 1].isalpha()):
                found.append("grey" if c == "gray" else c)
                i += len(c)
                break
        else:
            i += 1
    return s, found


def deep_uses(a):
    return {v: a.get(k) == "True" for k, v in DEEP_USES.items()
            if a.get(k) in ("True", "False")}


# ---- One park --------------------------------------------------------

def fetch_park(entry):
    deep_name = entry["deep"]
    props = arc(URL_PROPERTY, {"where": f"PROPERTY = '{sql(deep_name)}'",
                               "outFields": "PROPERTY,DEP_ID,ACRE_GIS,AV_LEGEND,AGNCYFN_CD",
                               "returnGeometry": "true", "outSR": "4326",
                               "maxAllowableOffset": "0.00001"})
    if not props:
        raise SystemExit(f"no DEEP property named {deep_name!r}")
    rings = [r for f in props for r in (f.get("geometry") or {}).get("rings", [])]
    w = min(x for r in rings for x, _ in r)
    e = max(x for r in rings for x, _ in r)
    s = min(y for r in rings for _, y in r)
    n = max(y for r in rings for _, y in r)
    lat0 = (s + n) / 2
    padx = NEAR_M * 2 / (111320 * math.cos(math.radians(lat0)))
    pady = NEAR_M * 2 / 110574
    bbox = [w - padx, s - pady, e + padx, n + pady]
    env = envelope(bbox)

    deep_trails = arc(URL_TRAILS, {**env, "where": "TRAILSTAT = 'Constructed'",
                                   "outFields": ",".join(DEEP_TRAIL_FIELDS),
                                   "returnGeometry": "true",
                                   "maxAllowableOffset": "0.000005"})
    interest = arc(URL_INTEREST, {**env, "where": "1=1", "outFields": "*",
                                  "returnGeometry": "true"})
    access = arc(URL_ACCESS, {"where": f"PROPERTY = '{sql(deep_name)}'",
                              "outFields": "*", "returnGeometry": "true",
                              "outSR": "4326"})
    osm_trails = arc(URL_OSM_TRAILS, {**env, "where": "highway IN ('" + "','".join(PATHS) + "')",
                                      "outFields": "osm_id,name,highway,surface,sac_scale,access,foot,bicycle,horse,ref,bridge",
                                      "returnGeometry": "true",
                                      "maxAllowableOffset": "0.000005"})
    roads = arc(URL_OSM_ROADS, {**env, "where": "highway NOT IN ('" + "','".join(PATHS) + "')",
                                "outFields": "name,highway,access,ref,service,surface",
                                "returnGeometry": "true",
                                "maxAllowableOffset": "0.00001"})
    pois = arc(URL_OSM_POIS, {**env, "where": "1=1",
                              "outFields": "name,amenity,tourism,historic,man_made,waterway,leisure,information,ele,tower_type,access",
                              "returnGeometry": "true"})
    tourism = arc(URL_OSM_TOURISM, {**env, "where": "1=1",
                                    "outFields": "name,tourism,historic,information,ele,amenity",
                                    "returnGeometry": "true"})
    amenity = arc(URL_OSM_AMENITY, {**env, "where": "amenity IN ('toilets','drinking_water','shelter','parking','bbq','ranger_station')",
                                    "outFields": "name,amenity,access,fee,capacity",
                                    "returnGeometry": "true"})
    gaz_common = {**env, "outFields": "gaz_name,gaz_featureclass",
                  "returnGeometry": "true"}
    gaz_land = arc(GAZ + "5/query", {**gaz_common, "where": "1=1"})
    gaz_water = arc(GAZ + "7/query", {**gaz_common, "where":
                    "gaz_featureclass IN ('Falls','Lake','Reservoir','Beach','Spring','Bay','Swamp')"})
    return dict(props=props, rings=rings, bbox=bbox, deep_trails=deep_trails,
                interest=interest, access=access, osm_trails=osm_trails,
                roads=roads, pois=pois, tourism=tourism, amenity=amenity,
                gaz=gaz_land + gaz_water)


def clip_lines(feats, P, rings_xy, ring_grid, attr_of):
    """Each feature's runs that touch the park, trimmed to NEAR_M outside.

    A segment is kept whole only as far as it stays near the park: the
    Metacomet Trail is one long feature, and keeping it whole would draw
    twenty kilometres of somebody else's ridge into Talcott Mountain.
    A run must also go INSIDE at least once: a path running parallel
    just outside the line is a neighbour, not part of this park.
    """
    out = []
    for f in feats:
        g = f.get("geometry") or {}
        a = f.get("attributes") or {}
        for path in g.get("paths") or []:
            pts = [P.xy(x, y) for x, y in path]
            if len(pts) < 2:
                continue
            near = []
            ins = []
            for i in range(len(pts) - 1):
                sm = samples([pts[i], pts[i + 1]])
                ii = any(inside(rings_xy, x, y) for x, y, _, _ in sm)
                nn = ii or any(ring_grid.dist(x, y, NEAR_M) <= NEAR_M for x, y, _, _ in sm)
                near.append(nn)
                ins.append(ii)
            i = 0
            while i < len(near):
                if not near[i]:
                    i += 1
                    continue
                j = i
                touched = False
                while j < len(near) and near[j]:
                    touched |= ins[j]
                    j += 1
                if touched:
                    run = pts[i:j + 1]
                    out.append({"xy": run, "attrs": attr_of(a)})
                i = j
    return out


def uncovered_runs(lines, grid):
    """The stretches of `lines` that nothing in `grid` runs beside.

    Used twice: OSM paths that no DEEP trail covers, and walkable roads
    that no trail covers. Either way the covered part is already in the
    graph, and adding it again would draw the same way twice.
    """
    out = []
    for ln in lines:
        sm = samples(ln["xy"])
        far = [grid.dist(x, y, AGREE_M) > AGREE_M for x, y, _, _ in sm]
        i = 0
        while i < len(sm):
            if not far[i]:
                i += 1
                continue
            j = i
            while j < len(sm) and far[j]:
                j += 1
            # One sample of overlap on each side, so the run reaches back
            # to the DEEP trail it branches from and can be joined to it.
            a, b = max(0, i - 1), min(len(sm) - 1, j)
            run = [(x, y) for x, y, _, _ in sm[a:b + 1]]
            if line_len(run) >= 30:
                out.append({"xy": run, "attrs": ln["attrs"], "tol": OSM_SNAP_M})
            i = j
    return out


def build_graph(lines):
    """Junctions and the stretches between them.

    Three ways the raw lines fail to say they meet, all handled:
      1. Ends that nearly coincide (digitised separately): snapped.
      2. An end landing on the MIDDLE of another line, a T-junction
         with no vertex there: the other line is split at that point.
      3. Two lines crossing with no shared vertex at all: both split
         at the crossing.
    Without 2 and 3 a router sees two trails that cross on the map as
    two islands, and a loop that obviously exists cannot be found.
    """
    grid = SegGrid(40.0)
    for k, ln in enumerate(lines):
        grid.add_line(k, ln["xy"])
    splits = defaultdict(list)          # line -> [(edge, t)]

    def ends_of(ln):
        return [ln["xy"][0], ln["xy"][-1]]

    for k, ln in enumerate(lines):
        tol = ln.get("tol", SNAP_M)
        for (x, y) in ends_of(ln):
            for d, other, i, t in grid.near(x, y, tol):
                if other == k:
                    continue
                o = lines[other]["xy"]
                px = o[i][0] + t * (o[i + 1][0] - o[i][0])
                py = o[i][1] + t * (o[i + 1][1] - o[i][1])
                # Landing on the other line's own end is case 1, not 2.
                if (math.hypot(px - o[0][0], py - o[0][1]) <= SNAP_M
                        or math.hypot(px - o[-1][0], py - o[-1][1]) <= SNAP_M):
                    continue
                splits[other].append((i, t))
    # Crossings.
    seen = set()
    for cell, items in grid.g.items():
        for u in range(len(items)):
            ka, ia, a1, a2 = items[u]
            for v in range(u + 1, len(items)):
                kb, ib, b1, b2 = items[v]
                if ka == kb:
                    continue
                key = (min((ka, ia), (kb, ib)), max((ka, ia), (kb, ib)))
                if key in seen:
                    continue
                seen.add(key)
                hit = cross(a1, a2, b1, b2)
                if hit:
                    ta, tb = hit
                    splits[ka].append((ia, ta))
                    splits[kb].append((ib, tb))

    pieces = []
    for k, ln in enumerate(lines):
        pts = ln["xy"]
        cuts = sorted(set(splits.get(k, [])))
        cur = [pts[0]]
        ci = 0
        for i in range(len(pts) - 1):
            while ci < len(cuts) and cuts[ci][0] == i:
                t = cuts[ci][1]
                ci += 1
                p = (pts[i][0] + t * (pts[i + 1][0] - pts[i][0]),
                     pts[i][1] + t * (pts[i + 1][1] - pts[i][1]))
                cur.append(p)
                if line_len(cur) > 0.5:
                    pieces.append((cur, k))
                cur = [p]
            cur.append(pts[i + 1])
        if line_len(cur) > 0.5:
            pieces.append((cur, k))

    # Cluster piece ends into nodes. An OSM-only run carries a wider
    # tolerance, because it was cut where it came within AGREE_M of a
    # DEEP trail, so its end is up to that far from the junction.
    nodes = []
    ngrid = defaultdict(list)
    C = OSM_SNAP_M

    def node_for(p, tol):
        gx, gy = int(p[0] // C), int(p[1] // C)
        best, bd = None, tol
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for ni in ngrid.get((gx + dx, gy + dy), ()):
                    d = math.hypot(nodes[ni][0] - p[0], nodes[ni][1] - p[1])
                    if d <= bd:
                        best, bd = ni, d
        if best is not None:
            return best
        nodes.append(p)
        ngrid[(gx, gy)].append(len(nodes) - 1)
        return len(nodes) - 1

    # DEEP pieces first, so their ends become the junctions and an OSM
    # run's wider tolerance snaps onto them rather than the reverse.
    order = sorted(range(len(pieces)), key=lambda q: lines[pieces[q][1]].get("tol", SNAP_M))
    edges = []
    for q in order:
        pts, k = pieces[q]
        tol = lines[k].get("tol", SNAP_M)
        a = node_for(pts[0], tol)
        b = node_for(pts[-1], tol)
        L = line_len(pts)
        if a == b and L < 25:
            continue
        # The edge's geometry ends exactly on its nodes, so lines drawn
        # from it meet with no visible gap.
        pts = [nodes[a]] + list(pts[1:-1]) + [nodes[b]]
        edges.append({"a": a, "b": b, "xy": pts, "m": line_len(pts), "line": k})
    return nodes, edges


def cross(a1, a2, b1, b2):
    """Proper intersection of two segments, as (t on a, t on b)."""
    rx, ry = a2[0] - a1[0], a2[1] - a1[1]
    sx, sy = b2[0] - b1[0], b2[1] - b1[1]
    den = rx * sy - ry * sx
    if abs(den) < 1e-9:
        return None
    qx, qy = b1[0] - a1[0], b1[1] - a1[1]
    t = (qx * sy - qy * sx) / den
    u = (qx * ry - qy * rx) / den
    # Strictly inside both, with a margin: a touch at an end is a
    # junction the snapping already handles.
    if 0.02 < t < 0.98 and 0.02 < u < 0.98:
        return t, u
    return None


def connectors(candidates, edges, find):
    """The shortest stretches of `candidates` that join two graph pieces."""
    eg = SegGrid(40.0)
    for k, ed in enumerate(edges):
        eg.add_line(k, ed["xy"])
    out = []
    for ln in candidates:
        sm = samples(ln["xy"], 4)
        last_i = last_c = None
        for i, (x, y, _, _) in enumerate(sm):
            hits = eg.near(x, y, SNAP_M)
            if not hits:
                continue
            c = find(edges[hits[0][1]]["a"])
            if last_c is not None and c != last_c:
                run = [(px, py) for px, py, _, _ in sm[last_i:i + 1]]
                out.append({"xy": run, "tol": SNAP_M * 2,
                            "attrs": dict(ln["attrs"], connector=True)})
            last_i, last_c = i, c
    return out


def components(n, edges):
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for e in edges:
        ra, rb = find(e["a"]), find(e["b"])
        if ra != rb:
            parent[ra] = rb
    comp = defaultdict(float)
    for e in edges:
        comp[find(e["a"])] += e["m"]
    return find, comp


FEATURE_KIND = [
    ("summit", lambda t: t.get("gaz") in ("Summit", "Ridge", "Cliff", "Pillar", "Gap", "Range")),
    ("falls", lambda t: t.get("gaz") == "Falls" or t.get("waterway") == "waterfall"),
    ("lake", lambda t: t.get("gaz") in ("Lake", "Reservoir", "Swamp", "Bay")),
    ("beach", lambda t: t.get("gaz") == "Beach"),
    ("spring", lambda t: t.get("gaz") == "Spring"),
    ("viewpoint", lambda t: t.get("tourism") == "viewpoint"),
    ("tower", lambda t: t.get("man_made") in ("tower", "observation_tower") or t.get("tower_type") == "observation"),
    ("toilets", lambda t: t.get("amenity") == "toilets"),
    ("water", lambda t: t.get("amenity") == "drinking_water"),
    ("shelter", lambda t: t.get("amenity") == "shelter"),
    ("info", lambda t: t.get("tourism") == "information" and t.get("information") in ("board", "map", "office", "visitor_centre")),
    ("picnic", lambda t: t.get("tourism") == "picnic_site" or t.get("leisure") == "picnic_table"),
    ("camp", lambda t: t.get("tourism") in ("camp_site", "camp_pitch")),
    ("historic", lambda t: bool(t.get("historic")) and t.get("historic") not in ("yes",)),
    ("attraction", lambda t: t.get("tourism") in ("attraction", "museum")),
    ("parking", lambda t: t.get("amenity") == "parking"),
    ("interest", lambda t: t.get("deep_interest") is not None),
]


def kind_of(tags):
    for k, test in FEATURE_KIND:
        if test(tags):
            return k
    return None


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower().replace("'", "")).strip()


def bake(entry, places, terrain):
    raw = fetch_park(entry)
    rings_ll = raw["rings"]
    w, s, e, n = raw["bbox"]
    P = Plane((s + n) / 2, (w + e) / 2)
    rings_xy = [[P.xy(x, y) for x, y in r] for r in rings_ll]
    ring_grid = SegGrid(60.0)
    for k, r in enumerate(rings_xy):
        ring_grid.add_line(("ring", k), r)

    def in_park(x, y):
        return inside(rings_xy, x, y)

    def dist_park(x, y):
        return 0.0 if in_park(x, y) else ring_grid.dist(x, y, 5000)

    deep_lines = clip_lines(raw["deep_trails"], P, rings_xy, ring_grid, lambda a: {
        "src": "deep", "name": (a.get("TRAILNAME") or "").strip() or None,
        "mark": a.get("TRAILMARK"), "class": a.get("TRAILCLASS"),
        "surf": a.get("TRAILSURF"), "uses": deep_uses(a),
        "permit": a.get("SPECIALPERMIT") == "True",
        "note": (a.get("TRAILCOMMENTS") or "").strip() or None})
    osm_lines = clip_lines(raw["osm_trails"], P, rings_xy, ring_grid, lambda a: {
        "src": "osm", "name": (a.get("name") or "").strip() or None,
        "mark": None, "class": a.get("highway"), "surf": a.get("surface"),
        "sac": a.get("sac_scale"), "access": a.get("access") or a.get("foot"),
        "bridge": a.get("bridge") if a.get("bridge") not in (None, "no") else None,
        "osm": a.get("osm_id")})
    # Private OSM paths are not ways anyone may walk; they stay out.
    osm_lines = [ln for ln in osm_lines
                 if (ln["attrs"].get("access") or "") not in ("private", "no")]

    deep_grid = SegGrid(50.0)
    for k, ln in enumerate(deep_lines):
        deep_grid.add_line(k, ln["xy"])
    osm_grid = SegGrid(50.0)
    for k, ln in enumerate(osm_lines):
        osm_grid.add_line(k, ln["xy"])

    # Agreement, measured only on the part inside the park, so trimmed
    # tails outside do not count for or against either source.
    def km_inside(lines, other_grid):
        tot = seen = 0.0
        for ln in lines:
            for x, y, _, step in samples(ln["xy"]):
                if not in_park(x, y):
                    continue
                tot += step
                if other_grid.dist(x, y, AGREE_M) <= AGREE_M:
                    seen += step
        return tot / 1000, seen / 1000
    deep_km, deep_seen = km_inside(deep_lines, osm_grid)
    osm_km, osm_seen = km_inside(osm_lines, deep_grid)

    extra = uncovered_runs(osm_lines, deep_grid)

    # Walkable roads. Without them the graph has no way across the
    # Eightmile River at Devil's Hopyard (the bridge is Hopyard Road)
    # and no way from Squantz Pond's lot to its own shore trail: a road
    # is how you get from where you parked to where the trail starts.
    # Only the stretches no trail already runs beside are added, and
    # they stay marked `road` so the route can prefer trails and the
    # directions can say which road.
    road_lines = clip_lines(
        [f for f in raw["roads"] if walkable_road(f.get("attributes") or {})],
        P, rings_xy, ring_grid, lambda a: {
            "src": "road", "name": (a.get("name") or a.get("ref") or "").strip() or None,
            "mark": None, "class": a.get("highway"), "surf": a.get("surface")})
    trail_grid = SegGrid(50.0)
    for k, ln in enumerate(deep_lines + extra):
        trail_grid.add_line(k, ln["xy"])
    road_runs = uncovered_runs(road_lines, trail_grid)

    # DEEP's trail layer also holds pavement: at Hammonasset most of its
    # "trail" is unnamed bituminous that sits on the park's roads and
    # lots. Marked here rather than dropped, since it is walkable and the
    # agency drew it, but a guide must not call a parking aisle a trail.
    any_road = SegGrid(50.0)
    for k, f in enumerate(raw["roads"]):
        for path in (f.get("geometry") or {}).get("paths") or []:
            any_road.add_line(k, [P.xy(x, y) for x, y in path])
    on_road_km = 0.0
    for ln in deep_lines:
        sm = samples(ln["xy"])
        hit = sum(1 for x, y, _, _ in sm if any_road.dist(x, y, ON_ROAD_M) <= ON_ROAD_M)
        if sm and hit / len(sm) >= 0.7:
            ln["attrs"]["onRoad"] = True
            on_road_km += sum(st for x, y, _, st in sm if in_park(x, y)) / 1000

    lines = deep_lines + extra + road_runs
    nodes_xy, edges = build_graph(lines)
    find, comp = components(len(nodes_xy), edges)
    # The duplicate test above has a blind spot: a short link between two
    # DEEP trails lies within AGREE_M of DEEP for its whole length, so it
    # reads as "already covered" and is dropped. At Devil's Hopyard that
    # link is the covered footbridge over the Eightmile River: 16 m of
    # OSM path, and without it the park's east half is unreachable. So any
    # OSM path or walkable road that joins two pieces of the network gets
    # the stretch that joins them added back, however short.
    added = []
    for _ in range(2):
        if len(comp) < 2:
            break
        joins = connectors(osm_lines + road_lines, edges, find)
        if not joins:
            break
        added += joins
        lines = deep_lines + extra + road_runs + added
        nodes_xy, edges = build_graph(lines)
        find, comp = components(len(nodes_xy), edges)
    total_m = sum(comp.values())
    main_root = max(comp, key=comp.get) if comp else None

    # Trail properties are shared by many edges; store each once.
    tprops, tindex = [], {}
    for ed in edges:
        a = lines[ed["line"]]["attrs"]
        blaze, cols = blaze_of(a.get("mark"))
        rec = {"src": a["src"], "name": a.get("name"), "blaze": blaze,
               "colours": cols, "class": a.get("class"), "surf": a.get("surf")}
        for k in ("uses", "sac", "permit", "note", "onRoad", "bridge", "connector"):
            if a.get(k):
                rec[k] = a[k]
        key = json.dumps(rec, sort_keys=True)
        if key not in tindex:
            tindex[key] = len(tprops)
            tprops.append(rec)
        ed["t"] = tindex[key]

    # Elevation, per node and along each edge.
    node_h = [None] * len(nodes_xy)
    if terrain:
        for i, (x, y) in enumerate(nodes_xy):
            node_h[i] = terrain.at(*P.ll(x, y))
        for ed in edges:
            prof = [terrain.at(*P.ll(x, y)) for x, y, _, _ in samples(ed["xy"])]
            ed["up"], ed["down"] = climb(prof)

    # ---- Ways in --------------------------------------------------
    entrances = []
    node_grid = defaultdict(list)
    for i, (x, y) in enumerate(nodes_xy):
        node_grid[(int(x // 100), int(y // 100))].append(i)

    def nearest_node(x, y, r):
        best, bd = None, r
        for dx in range(-int(r // 100) - 1, int(r // 100) + 2):
            for dy in range(-int(r // 100) - 1, int(r // 100) + 2):
                for i in node_grid.get((int(x // 100) + dx, int(y // 100) + dy), ()):
                    nx, ny = nodes_xy[i]
                    d = math.hypot(nx - x, ny - y)
                    if d <= bd:
                        best, bd = i, d
        return best, (bd if best is not None else None)

    for f in raw["access"]:
        a, g = f["attributes"], f.get("geometry") or {}
        if g.get("x") is None:
            continue
        x, y = P.xy(g["x"], g["y"])
        ni, d = nearest_node(x, y, ENTRY_SNAP_M)
        acts = sorted(k.lower() for k, v in a.items() if v == "Yes")
        entrances.append({"name": a.get("ACCSS_NAME"), "kind": "deep",
                          "type": a.get("ACCSS_TYPE"), "status": a.get("STATUS"),
                          "link": a.get("LINK"), "activities": acts,
                          "lng": round(g["x"], 6), "lat": round(g["y"], 6),
                          "node": ni, "snapM": round(d) if d is not None else None})

    road_grid = SegGrid(50.0)
    road_meta = []
    for f in raw["roads"]:
        a = f.get("attributes") or {}
        hw = a.get("highway") or ""
        if (a.get("access") or "") in ("private", "no"):
            continue
        for path in (f.get("geometry") or {}).get("paths") or []:
            pts = [P.xy(x, y) for x, y in path]
            k = len(road_meta)
            road_meta.append({"name": a.get("name") or a.get("ref"), "hw": hw, "pts": pts})
            road_grid.add_line(k, pts)
    found = []
    deg = Counter()
    on_trail = set()
    for ed in edges:
        deg[ed["a"]] += 1
        deg[ed["b"]] += 1
        if tprops[ed["t"]]["src"] != "road":
            on_trail.update((ed["a"], ed["b"]))
    for i, (x, y) in enumerate(nodes_xy):
        # A node on the road network alone is not a way onto a TRAIL.
        if i not in on_trail:
            continue
        for d, k, _, _ in road_grid.near(x, y, ROAD_M):
            rm = road_meta[k]
            ok = rm["hw"] in PUBLIC_ROADS or (rm["hw"] == "service" and in_park(x, y))
            if not ok:
                continue
            found.append((i, rm, d))
            break
    # One way in per road per 250 m: a trail that runs beside a road
    # for a stretch would otherwise list the same road twenty times.
    kept = []
    for i, rm, d in sorted(found, key=lambda t: (deg[t[0]] != 1, dist_park(*nodes_xy[t[0]]))):
        x, y = nodes_xy[i]
        if any(math.hypot(x - nodes_xy[j][0], y - nodes_xy[j][1]) < 250
               and (rm2["name"] == rm["name"]) for j, rm2, _ in kept):
            continue
        kept.append((i, rm, d))
    for i, rm, d in kept:
        lng, lat = P.ll(*nodes_xy[i])
        entrances.append({"name": rm["name"], "kind": "road", "road": rm["hw"],
                          "inside": in_park(*nodes_xy[i]),
                          "lng": round(lng, 6), "lat": round(lat, 6),
                          "node": i, "snapM": 0})

    # ---- Named features -------------------------------------------
    feats = []

    def add_feature(tags, gx, gy, src):
        k = kind_of(tags)
        if not k:
            return
        x, y = P.xy(gx, gy)
        dpk = dist_park(x, y)
        # Parking and toilets are often just outside the line; scenery
        # outside the park is somebody else's.
        if dpk > (100 if k in ("parking", "toilets", "info", "water") else 0):
            return
        feats.append({"kind": k, "name": tags.get("name"), "src": src,
                      "lng": round(gx, 6), "lat": round(gy, 6)})
    for f in raw["gaz"]:
        a, g = f.get("attributes") or {}, f.get("geometry") or {}
        pt = (g.get("points") or [[g.get("x"), g.get("y")]])[0]
        if pt[0] is None:
            continue
        add_feature({"gaz": a.get("gaz_featureclass"), "name": a.get("gaz_name")},
                    pt[0], pt[1], "USGS GNIS")
    for layer in ("pois", "tourism", "amenity"):
        for f in raw[layer]:
            g = f.get("geometry") or {}
            if g.get("x") is None:
                continue
            add_feature(f.get("attributes") or {}, g["x"], g["y"], "OpenStreetMap")
    for f in raw["interest"]:
        a, g = f.get("attributes") or {}, f.get("geometry") or {}
        if g.get("x") is None:
            continue
        add_feature({"deep_interest": a.get("INTEREST"), "name": a.get("MAPLABEL")},
                    g["x"], g["y"], "CT DEEP")
    # The same summit arrives from GNIS and OSM; keep the first of any
    # same-kind pair within 60 m.
    dedup = []
    for ft in feats:
        fx, fy = P.xy(ft["lng"], ft["lat"])
        if any(o["kind"] == ft["kind"]
               and math.hypot(fx - P.xy(o["lng"], o["lat"])[0],
                              fy - P.xy(o["lng"], o["lat"])[1]) < 60
               for o in dedup):
            continue
        dedup.append(ft)
    feats = dedup
    if terrain:
        for ft in feats:
            ft["elev"] = round(terrain.at(ft["lng"], ft["lat"]), 1)

    # ---- The record, and what is wrong with it ---------------------
    rec = next((p for p in places if p.get("id") == entry["id"]), None)
    deep_acres = sum((f["attributes"].get("ACRE_GIS") or 0) for f in raw["props"])
    legend = sorted({f["attributes"].get("AV_LEGEND") for f in raw["props"]})
    ring_acres = abs(sum(ring_area_m2(r) for r in rings_xy)) / 4046.86
    others = []
    for p in places:
        if p.get("id") == entry["id"] or p.get("state", "CT") != "CT":
            continue
        if not (w <= p["lng"] <= e and s <= p["lat"] <= n):
            continue
        if in_park(*P.xy(p["lng"], p["lat"])):
            others.append({"id": p["id"], "name": p["name"], "type": p.get("type"),
                           "subtype": p.get("subtype"), "acres": p.get("acres")})

    flags = []
    if rec is None:
        flags.append(f"no record with id {entry['id']} in places.json")
    else:
        if norm(rec["name"]) != norm(entry["deep"]):
            flags.append(f"named {rec['name']!r}; DEEP calls it {entry['deep']!r}")
        if legend and rec.get("subtype") not in legend:
            flags.append(f"classed {rec.get('subtype')!r}; DEEP's legend says {', '.join(legend)}")
        ra = rec.get("acres") or 0
        if deep_acres and abs(ra - deep_acres) / deep_acres > 0.10:
            flags.append(f"record says {ra} acres; DEEP says {deep_acres:.0f}")
    if others:
        flags.append(f"{len(others)} other place record(s) inside the boundary")
    unblazed = sum(ed["m"] for ed in edges if tprops[ed["t"]]["src"] == "deep" and not tprops[ed["t"]]["blaze"])
    deep_m = sum(ed["m"] for ed in edges if tprops[ed["t"]]["src"] == "deep")
    if deep_m and unblazed / deep_m > 0.2:
        flags.append(f"{unblazed / deep_m:.0%} of DEEP trail length has no recorded blaze")
    if not deep_lines:
        flags.append("DEEP records no trails here; every route is OSM's")
    if deep_km and on_road_km / deep_km > 0.15:
        flags.append(f"{on_road_km:.1f} km of DEEP 'trail' inside lies on a road")
    main_pct = comp[main_root] / total_m if total_m else 0
    if total_m and main_pct < 0.9:
        flags.append(f"network in {len(comp)} pieces; the largest is {main_pct:.0%} of the length")
    for en in entrances:
        if en["kind"] == "deep" and en["node"] is None:
            flags.append(f"DEEP access point {en['name']!r} is over {ENTRY_SNAP_M} m from any trail")
    if osm_km and (osm_km - osm_seen) / max(osm_km, 1e-9) > 0.25 and deep_lines:
        flags.append(f"{osm_km - osm_seen:.1f} km of OSM path inside has no DEEP trail beside it")
    if deep_km and (deep_km - deep_seen) / deep_km > 0.25 and osm_lines:
        flags.append(f"{deep_km - deep_seen:.1f} km of DEEP trail inside has no OSM path beside it")

    # Every piece cut off from the main network, and how close it comes.
    # A gap of 15 m is almost certainly a bridge or a crossing nobody
    # mapped; a gap of 800 m is a separate parcel. Either way it is a
    # spot a person can check on a map, and the place a hand-written
    # link in verified.json would go.
    gaps = []
    if main_root is not None:
        main_grid = SegGrid(60.0)
        for k, ed in enumerate(edges):
            if find(ed["a"]) == main_root:
                main_grid.add_line(k, ed["xy"])
        for root, m in sorted(comp.items(), key=lambda kv: -kv[1]):
            if root == main_root or m < 200:
                continue
            best = (math.inf, None)
            for i, (x, y) in enumerate(nodes_xy):
                if find(i) != root:
                    continue
                d = main_grid.dist(x, y, 2000)
                if d < best[0]:
                    best = (d, i)
            at = P.ll(*nodes_xy[best[1]]) if best[1] is not None else None
            gaps.append({"km": round(m / 1000, 2),
                         "nearestM": None if best[0] == math.inf else round(best[0]),
                         "at": None if at is None else [round(at[1], 5), round(at[0], 5)]})

    blazes = Counter()
    for ed in edges:
        t = tprops[ed["t"]]
        if t["src"] == "deep":
            blazes[t["blaze"] or "(none)"] += ed["m"] / 1000
    audit = {
        "id": entry["id"], "name": entry["name"],
        "record": None if rec is None else {
            "name": rec["name"], "type": rec.get("type"), "subtype": rec.get("subtype"),
            "acres": rec.get("acres"), "status": rec.get("status"),
            "feeState": rec.get("feeState"),
            "siteRules": (rec.get("attrs") or {}).get("siteRules"),
            "sources": (rec.get("attrs") or {}).get("sources")},
        "deep": {"property": entry["deep"], "legend": legend,
                 "acres": round(deep_acres), "ringAcres": round(ring_acres),
                 "rings": len(rings_ll)},
        "trails": {"deepSegments": len(raw["deep_trails"]),
                   "deepKmInside": round(deep_km, 2),
                   "deepKmSeenByOsm": round(deep_seen, 2),
                   "osmKmInside": round(osm_km, 2),
                   "osmKmSeenByDeep": round(osm_seen, 2),
                   "osmOnlyRunsAdded": len(extra),
                   "roadRunsAdded": len(road_runs),
                   "deepKmOnRoads": round(on_road_km, 2),
                   "blazesKm": {k: round(v, 2) for k, v in blazes.most_common()}},
        "graph": {"nodes": len(nodes_xy), "edges": len(edges),
                  "km": round(total_m / 1000, 2), "pieces": len(comp),
                  "largestPiecePct": round(100 * main_pct, 1),
                  "connectorsAdded": len(added), "gaps": gaps},
        "entrances": {"deep": sum(1 for x in entrances if x["kind"] == "deep"),
                      "road": sum(1 for x in entrances if x["kind"] == "road"),
                      "deepUnreached": [x["name"] for x in entrances
                                        if x["kind"] == "deep" and x["node"] is None]},
        "features": dict(Counter(f["kind"] for f in feats).most_common()),
        "othersInside": others,
        "flags": flags,
    }

    def ll6(x, y):
        lng, lat = P.ll(x, y)
        return [round(lng, 6), round(lat, 6)]

    guide = {
        "_generated": "makeguides.py; do not hand-edit, corrections go in verified.json",
        "id": entry["id"], "name": entry["name"], "deep": entry["deep"],
        "built": date.today().isoformat(),
        "bbox": [round(v, 6) for v in raw["bbox"]],
        "boundary": {"src": "CT DEEP", "acres": round(deep_acres),
                     "rings": [[[round(x, 6), round(y, 6)] for x, y in r] for r in rings_ll]},
        "trails": tprops,
        "nodes": [ll6(x, y) + ([round(node_h[i], 1)] if node_h[i] is not None else [])
                  for i, (x, y) in enumerate(nodes_xy)],
        "edges": [{"a": ed["a"], "b": ed["b"], "t": ed["t"], "m": round(ed["m"], 1),
                   **({"up": round(ed["up"], 1), "down": round(ed["down"], 1)} if "up" in ed else {}),
                   "g": [ll6(x, y) for x, y in ed["xy"]]} for ed in edges],
        "entrances": entrances,
        "features": feats,
        "sources": {
            "boundary": URL_PROPERTY, "trails": URL_TRAILS,
            "access": URL_ACCESS, "osmTrails": URL_OSM_TRAILS,
            "roads": URL_OSM_ROADS, "names": GAZ,
            "elevation": TERRAIN.format(z=TERRAIN_Z, x="{x}", y="{y}")},
        "audit": audit,
    }
    return guide, audit


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--testset", default="data/testset.json")
    ap.add_argument("--places", default="data/places.json")
    ap.add_argument("--out", default="data/guides")
    ap.add_argument("--only", action="append")
    ap.add_argument("--no-elev", action="store_true")
    args = ap.parse_args()

    ts = json.load(open(args.testset))["parks"]
    if args.only:
        ts = [p for p in ts if p["id"] in args.only]
    places = json.load(open(args.places))["places"]
    os.makedirs(args.out, exist_ok=True)
    terrain = None if args.no_elev else Terrain()
    audits = []
    apath = os.path.join(args.out, "audit.json")
    if args.only and os.path.exists(apath):
        audits = [a for a in json.load(open(apath))["parks"] if a["id"] not in args.only]
    for entry in ts:
        t0 = time.time()
        print(f"{entry['name']} ...", flush=True)
        guide, audit = bake(entry, places, terrain)
        with open(os.path.join(args.out, f"{entry['id']}.json"), "w") as fh:
            json.dump(guide, fh, separators=(",", ":"))
        audits.append(audit)
        g = audit["graph"]
        print(f"  {g['km']} km in {g['edges']} edges, {g['pieces']} piece(s), "
              f"largest {g['largestPiecePct']}%; "
              f"{audit['entrances']['deep']} DEEP + {audit['entrances']['road']} road ways in; "
              f"{sum(audit['features'].values())} features "
              f"({time.time() - t0:.0f}s)", flush=True)
        for fl in audit["flags"]:
            print(f"  ! {fl}", flush=True)
    order = {p["id"]: i for i, p in enumerate(json.load(open(args.testset))["parks"])}
    audits.sort(key=lambda a: order.get(a["id"], 99))
    with open(apath, "w") as fh:
        json.dump({"built": date.today().isoformat(), "parks": audits}, fh, indent=1)
    index = [{"id": a["id"], "name": a["name"]} for a in audits]
    with open(os.path.join(args.out, "index.json"), "w") as fh:
        json.dump(index, fh, indent=1)


if __name__ == "__main__":
    sys.exit(main())
