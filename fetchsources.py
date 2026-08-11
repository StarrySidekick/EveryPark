#!/usr/bin/env python3
"""
Pull every public source EveryPark uses, straight from the services.

This replaces the browser pages (build.html / tiles.html) that used to be
the only way to reach these endpoints. It runs on GitHub Actions, where
there's full network access, so refreshing the map needs nobody to open
anything.

    python3 fetchsources.py --out raw

Writes:
    raw/baked.json          place lists + enrichment inputs
    raw/ep-<layer>.geojson  full geometry, for the tile builder
"""

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

# Connecticut and New York together. The box is a crude envelope and
# necessarily spills into New Jersey, Pennsylvania, Massachusetts and
# Vermont -- an envelope cannot follow a state line. That spill is not
# filtered here on purpose: data/municipalities.geojson holds the 169 CT
# towns and 995 NY towns and cities, and buildplaces.py drops any place
# whose coordinates land in no municipality. The polygons are the state
# filter; this box only decides what gets asked for.
#
# Anything added that does NOT go through the municipality lookup must do
# its own state check, or it will quietly import New Jersey.
REGION_BBOX = "-79.77,40.47,-71.77,45.02"
OSM6 = "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/"
DEEP = "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/"
PADUS = ("https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
         "Manager_Name_PADUS/FeatureServer/0/query")

# ~2 m. At zoom 14 one tile unit is about half a metre, so finer detail
# than this is invisible and only makes the files bigger.
GEOM_OFFSET = "0.00002"
TRAIL_CELL = 0.0015

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "EveryPark/1.0 (+https://everypark.starrysidekick.com)"


def post(url, params, tries=4):
    """One query, retried — these services throttle under parallel load."""
    body = dict(params)
    body.setdefault("f", "json")
    last = None
    for attempt in range(tries):
        try:
            r = SESSION.post(url, data=body, timeout=120)
            r.raise_for_status()
            j = r.json()
            if isinstance(j, dict) and j.get("error"):
                raise RuntimeError(j["error"].get("message", "service error"))
            return j
        except Exception as e:                      # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


# The region is asked for in tiles, not in one rectangle.
#
# Widening the envelope from Connecticut to Connecticut+New York made the
# OSM mirror start answering "Cannot perform query. Invalid query
# parameters." — and it did so for whole SECTIONS, four retries deep, so
# the 2026-08-10 refresh degraded preserves, cemeteries, facilities,
# named water and the trail grid to Connecticut-only copies and produced
# a New York with no nature preserves in it at all.
#
# It is not a hard limit and not the geometry: re-run by hand the same
# query on the same envelope succeeded. It is that mirror buckling on
# large result sets, intermittently — the same endpoint named in the
# run #5 note. Splitting the envelope into a grid made it reliable: 0
# failed tiles at 2x2, 3x3 and 4x4, where the single rectangle failed
# outright. Smaller questions get answered.
#
# Tiles overlap nothing, but a feature straddling a seam is returned by
# both neighbours, so results are de-duplicated below.
REGION_SPLIT = 3


def region_tiles(n=REGION_SPLIT):
    w, s, e, nn = [float(v) for v in REGION_BBOX.split(",")]
    dx, dy = (e - w) / n, (nn - s) / n
    return [f"{w + i * dx},{s + j * dy},{w + (i + 1) * dx},{s + (j + 1) * dy}"
            for i in range(n) for j in range(n)]


def count(url, where, bbox=None):
    j = post(url, {"where": where, "geometry": bbox or REGION_BBOX,
                   "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                   "returnCountOnly": "true"})
    return j.get("count", 0)


def _dedupe_key(f):
    """Identity for a feature seen in two overlapping tiles.

    OBJECTID when the layer sends one; otherwise the first vertex plus
    the attribute bag, which is stable enough to catch a genuine repeat
    without collapsing two real neighbours.
    """
    a = f.get("attributes") or f.get("properties") or {}
    for k in ("OBJECTID", "objectid", "OID", "FID"):
        if a.get(k) is not None:
            return ("id", a[k])
    # centroid, not just geometry. A returnCentroid query sends
    # {"attributes": ..., "centroid": ...} with NO geometry key, so
    # keying on geometry alone left every feature at pt=None and
    # collapsed them by attributes: 1,000 preserves became 556. Position
    # is the only thing that separates two parcels sharing a name.
    g = f.get("geometry") or f.get("centroid") or {}
    pt = None
    if isinstance(g.get("x"), (int, float)):
        pt = (round(g["x"], 6), round(g["y"], 6))
    else:
        c = g.get("coordinates") or g.get("rings") or g.get("paths")
        while isinstance(c, list) and c and isinstance(c[0], list):
            c = c[0]
        if isinstance(c, list) and len(c) >= 2 and isinstance(c[0], (int, float)):
            pt = (round(c[0], 6), round(c[1], 6))
    return ("pt", pt, tuple(sorted((str(k), str(v)) for k, v in a.items())))


def paged(url, where, out_fields, per_feature, geometry=False, page=1000,
          centroid=True, offset=GEOM_OFFSET, workers=3, simplify=None):
    """
    Page through a layer, one region tile at a time. Polygon layers answer
    returnCentroid; point layers reject it outright and hand back a plain
    geometry instead — getting that wrong fails silently, returning
    features that are all skipped, so callers pass centroid=False for
    point layers.
    """
    got = [0]
    seen = set()

    def emit(f):
        k = _dedupe_key(f)
        if k in seen:
            return
        seen.add(k)
        per_feature(f)
        got[0] += 1

    # A fixed grid was not enough. At 3x3 the mirror still refused the two
    # biggest layers — preserves (12k features region-wide) and the trail
    # grid (~139k) — while every smaller section started succeeding. The
    # split has to follow the DATA, not the map: a tile is subdivided
    # until it is small enough to be answered, and a tile whose count
    # query itself errors is subdivided on that evidence alone.
    TILE_MAX = 4000
    DEPTH_MAX = 4

    def leaves(bbox, depth=0):
        try:
            total = count(url, where, bbox)
            small = total <= TILE_MAX
        except Exception:                           # noqa: BLE001
            total, small = None, False              # refused: too big, split
        if small or depth >= DEPTH_MAX:
            return [(bbox, total)] if total or total is None else []
        w, s, e, n = [float(v) for v in bbox.split(",")]
        mx, my = (w + e) / 2, (s + n) / 2
        out = []
        for q in (f"{w},{s},{mx},{my}", f"{mx},{s},{e},{my}",
                  f"{w},{my},{mx},{n}", f"{mx},{my},{e},{n}"):
            out.extend(leaves(q, depth + 1))
        return out

    plan = []
    for tile in region_tiles():
        plan.extend(leaves(tile))

    for bbox, total in plan:
        if total is None:
            total = count(url, where, bbox)
        if not total:
            continue

        def grab(off, _bbox=bbox):
            p = {"where": where, "geometry": _bbox,
                 "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                 "outSR": "4326", "outFields": out_fields,
                 "resultOffset": str(off), "resultRecordCount": str(page)}
            if geometry:
                p.update({"returnGeometry": "true", "maxAllowableOffset": offset,
                          "geometryPrecision": "6", "f": "geojson"})
            else:
                p["returnGeometry"] = "false"
                if centroid:
                    p["returnCentroid"] = "true"
                else:
                    p["returnGeometry"] = "true"
            # Esri-format geometry can be simplified too. The trail grid
            # only needs to know WHERE there is a trail, at a 0.0015-degree
            # cell, so it asks for very coarse paths — without this it
            # would pull full-precision geometry for ~139,000 ways.
            if simplify:
                p["maxAllowableOffset"], p["geometryPrecision"] = simplify
            j = post(url, p)
            return j.get("features") or []

        with ThreadPoolExecutor(max_workers=workers) as ex:
            for feats in ex.map(grab, range(0, total, page)):
                for f in feats:
                    emit(f)
    return got[0]


def point_of(f):
    """Centroid if the layer gave one, else its own point geometry."""
    if f.get("centroid"):
        return f["centroid"]
    g = f.get("geometry") or {}
    if isinstance(g.get("x"), (int, float)):
        return g
    return None


def acres_of(area, lat):
    k = math.cos(math.radians(lat))
    return round((area or 0) * k * k * 0.000247105)


# --------------------------------------------------------------- layers
GEOMETRY_LAYERS = [
    ("stateland", DEEP + "Connecticut_DEEP_Property/FeatureServer/0/query",
     "1=1", "AV_LEGEND,PROPERTY,ACRE_GIS"),
    ("townparks", OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
     "leisure='park' AND (access IS NULL OR access NOT IN ('private','no'))",
     "name,operator,access"),
    ("preserves", OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
     "leisure='nature_reserve' AND (access IS NULL OR access NOT IN ('private','no'))",
     "name,operator,access"),
    ("cemeteries", OSM6 + "OSM_NA_Landuse/FeatureServer/0/query",
     "landuse='cemetery' AND (access IS NULL OR access NOT IN ('private','no'))",
     "name,operator"),
    ("landuse", OSM6 + "OSM_NA_Landuse/FeatureServer/0/query",
     "landuse IN ('recreation_ground','village_green','forest') AND "
     "(access IS NULL OR access NOT IN ('private','no'))",
     "name,landuse,operator"),
    ("padus", PADUS, "1=1",
     "Unit_Nm,Own_Name,Mang_Name,Pub_Access,Des_Tp,GIS_Acres"),
    # NOT fetched: Connecticut_Parcels_for_Protected_Open_Space_Mapping.
    # Despite the name it is not a layer of protected parcels — it is the
    # statewide tax parcel layer, 1,020,364 polygons, overwhelmingly private
    # house lots. It was the input DEEP used *for* open-space mapping, not
    # the output. Pulling it would mean hundreds of megabytes of private
    # property, which is the opposite of what this map is for.
    # New York DEC land as real outlines, not just centroids. Without
    # this the 2,983 DEC places borrow whatever PAD-US or OSM happens to
    # have over them, which covers most of the same ground but never
    # parcel for parcel — a Forest Preserve unit would be drawn as
    # somebody else's polygon. ADMINISTRATIVE is dropped here for the
    # same reason it is dropped from the attribute pass: DEC offices and
    # depots are not places anyone visits.
    ("nydec", "https://services6.arcgis.com/DZHaqZm9cxOD4CWM/arcgis/rest/"
              "services/NYS_DEC_Lands/FeatureServer/0/query",
     "CATEGORY <> 'ADMINISTRATIVE'", "FACILITY,CATEGORY,ACRES"),
    ("trails", OSM6 + "OSM_NA_Trails/FeatureServer/0/query",
     "highway IN ('path','track','bridleway')", "name,highway,surface,access"),
    ("blueblazed", DEEP + "BlueBlazedHikingTrails/FeatureServer/0/query",
     "1=1", "TrailName,Blaze,Length"),
]


def fetch_geometry(outdir):
    for name, url, where, fields in GEOMETRY_LAYERS:
        feats = []
        try:
            n = paged(url, where, fields, lambda f: feats.append(f),
                      geometry=True, page=600)
        except Exception as e:                      # noqa: BLE001
            print(f"  {name}: FAILED ({e})", flush=True)
            continue
        for f in feats:
            f.pop("id", None)
        path = os.path.join(outdir, f"ep-{name}.geojson")
        with open(path, "w") as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh,
                      separators=(",", ":"))
        print(f"  {name}: {len(feats):,} features "
              f"({os.path.getsize(path)/1024/1024:.1f} MB)", flush=True)


def run_section(cache, stale, prev, name, keys, fn):
    """Run one source section; if it fails, degrade to last refresh's data.

    A single flaky endpoint used to abort the whole 65-minute refresh
    (run #5 died at 12 minutes on one OSM mirror). Sections are
    independent, so one failing should cost one section, not the run.
    Degrading is only safe when there is something to degrade TO — with
    no previous data the failure stays fatal, because publishing a map
    with a whole category quietly missing is exactly the silent-success
    trap this project keeps falling into.
    """
    try:
        got = fn()
    except Exception as e:                          # noqa: BLE001
        missing = [k for k in keys if k not in prev]
        if missing:
            print(f"::error::{name} failed ({e}) and there is no previous "
                  f"data for {', '.join(missing)} — cannot degrade", flush=True)
            raise
        print(f"::warning::{name} failed ({e}) — reusing last refresh's "
              f"data for {', '.join(keys)}", flush=True)
        for k in keys:
            cache[k] = prev[k]
            stale.append(k)
        return
    cache.update(got)


def fetch_attributes(outdir, prev=None, only=None):
    prev = prev or {}
    cache = {}
    stale = []

    # --- other DEEP land: wildlife areas, hatcheries, flood control ----
    def s_stateextra():
        best = {}

        def se(f):
            a, c = f["attributes"], point_of(f)
            if not a.get("PROPERTY") or not c:
                return
            ac = round(a.get("ACRE_GIS") or 0)
            cur = best.get(a["PROPERTY"])
            if not cur or ac > cur["a"]:
                best[a["PROPERTY"]] = {"n": a["PROPERTY"], "t": a.get("AV_LEGEND"),
                                       "a": ac, "lat": round(c["y"], 5),
                                       "lng": round(c["x"], 5)}

        paged(DEEP + "Connecticut_DEEP_Property/FeatureServer/0/query",
              "AV_LEGEND IN ('Wildlife Area','Wildlife Sanctuary','Flood Control',"
              "'Fish Hatchery')", "PROPERTY,AV_LEGEND,ACRE_GIS", se)
        return {"ctparks_stateextra_v1": [v for v in best.values() if v["a"] >= 5]}

    # --- boat launches -------------------------------------------------
    def s_boats():
        boats, seen = [], set()
        for url in (DEEP + "DEEP_State_Trailered_Boat_Launches/FeatureServer/0/query",
                    DEEP + "DEEP_State_Cartop_Boat_Launches/FeatureServer/0/query"):
            try:
                j = post(url, {"where": "1=1", "outSR": "4326",
                               "outFields": "ACCSS_NAME,PROPERTY,ACCSS_TOWN,WATERBODY,"
                                            "TRAILER,CARRY_IN,HANDICAP,LINK",
                               "returnGeometry": "true", "resultRecordCount": "300"})
            except Exception:                           # noqa: BLE001
                continue
            for f in j.get("features") or []:
                g, a = f.get("geometry"), f["attributes"]
                if not g:
                    continue
                nm = a.get("ACCSS_NAME") or a.get("PROPERTY")
                k = f"{str(nm).lower()}{round(g['y']*2000)}{round(g['x']*2000)}"
                if not nm or k in seen:
                    continue
                seen.add(k)
                boats.append({"n": nm, "town": a.get("ACCSS_TOWN") or "",
                              "w": a.get("WATERBODY") or "", "trailer": a.get("TRAILER"),
                              "carry": a.get("CARRY_IN"), "hc": a.get("HANDICAP"),
                              "url": a.get("LINK"), "lat": round(g["y"], 5),
                              "lng": round(g["x"], 5)})
        return {"ctparks_boat_v2": boats}

    # --- coastal access sites ------------------------------------------
    def s_coastal():
        """CT DEEP Coastal Access Sites: 357 points, fees and facilities.

        Two services publish this layer, both with 357 features and the
        same description. The one with the NEWER edit date
        (CT_Coastal_Public_Access_Sites, 2023-01-05) is a shapefile round
        trip: field names truncated to ten characters (SiteAddres,
        Directio_1) and Fee, Restrooms, HandicappedAccess, ParkingDesc
        and all twenty-odd activity flags dropped. It keeps 11 fields of
        the 67. This one is a year older and complete; prefer it.

        The flags are the strings "YES"/"NO" — a THIRD vocabulary, after
        the trails layer's "True"/"False"/"Unknown" and the access-point
        layer's "Yes"/"No". "NO" is truthy in both Python and JS, so a
        plain `if a["Fee"]:` calls every one of the 357 fee-charging when
        only 69 are. They are collapsed to a list of the YES ones here,
        at the edge, while the vocabulary is still in view.
        """
        FLAGS = [
            ("Restrooms", "restrooms"), ("HandicappedAccess", "accessible"),
            ("PicnicArea", "picnic area"), ("Trails", "trails"),
            ("Walkway", "walkway"), ("AccessPier", "access pier"),
            ("Fishing", "fishing"), ("Shellfishing", "shellfishing"),
            ("Crabbing", "crabbing"), ("Scuba", "scuba"),
            ("SupervisedSwimming", "supervised swimming"),
            ("UnsupervisedSwimming", "unsupervised swimming"),
            ("BirdWildlife", "birding and wildlife"),
            ("WaterfowlHunting", "waterfowl hunting"),
            ("BoatLaunchRamp", "boat launch ramp"),
            ("CarTopBoatAccess", "car-top boat access"),
            ("Camping", "camping"), ("RvCamping", "RV camping"),
            ("NatureCenter", "nature centre"), ("Lighthouse", "lighthouse"),
            ("FoodConcession", "food concession"),
            ("HistoricCultural", "historic or cultural site"),
        ]
        out = []
        j = post(DEEP + "Coastal_Access_Sites_Feature_Service/FeatureServer/0/query",
                 {"where": "1=1", "outSR": "4326", "outFields": "*",
                  "returnGeometry": "true", "resultRecordCount": "1000"})
        for f in j.get("features") or []:
            g, a = f.get("geometry"), f["attributes"]
            nm = str(a.get("SiteName") or "").strip()
            if not g or g.get("x") is None or not nm:
                continue
            rec = {"n": nm, "town": a.get("Town") or "",
                   "lat": round(g["y"], 5), "lng": round(g["x"], 5),
                   "owner": a.get("OwnerType") or "Unknown",
                   "ownerName": a.get("OwnerName") or "",
                   "fee": a.get("Fee") == "YES",
                   "has": [label for fld, label in FLAGS if a.get(fld) == "YES"]}
            for src, key in (("SiteWebsite", "url"), ("MapLink", "map"),
                             ("ParkingDesc", "parking"),
                             ("SiteDescription", "desc")):
                v = str(a.get(src) or "").strip()
                if v:
                    rec[key] = v
            out.append(rec)
        return {"ctparks_coastal_v1": out}

    # --- New York DEC lands --------------------------------------------
    def s_nydec():
        """NYS DEC Lands: 3,232 parcels, ~4M acres. NY's DEEP_Property.

        Two fields on this layer look useful and are not:

        PUBLICUSE is 'Y' on all 3,232 rows. It reads like an access flag
        and discriminates nothing, so testing it would stamp every parcel
        as public on evidence that does not exist -- the same shape as the
        bug that once rendered a reservation as "You can go here". It is
        deliberately not fetched. ('Y' is also a FOURTH vocabulary here,
        after "True"/"False"/"Unknown", "Yes"/"No" and "YES"/"NO".)

        MANAGE_BY is null on all 3,232 rows. The field exists and is
        empty; the managing agency has to come from CATEGORY instead.

        ADMINISTRATIVE parcels are DEC offices and depots, not places
        anyone visits, so they are dropped here rather than downstream.
        """
        rows = []

        def one(f):
            a, c = f["attributes"], point_of(f)
            nm = str(a.get("FACILITY") or "").strip()
            if not nm or not c:
                return
            cat = str(a.get("CATEGORY") or "").strip()
            if cat == "ADMINISTRATIVE":
                return
            rec = {"n": nm, "cat": cat, "lat": round(c["y"], 5),
                   "lng": round(c["x"], 5)}
            cls = str(a.get("CLASS") or "").strip()
            if cls and cls not in ("N/A", "UNCLASSIFIED", "None"):
                rec["cls"] = cls
            if a.get("ACRES"):
                rec["a"] = round(a["ACRES"])
            if a.get("COUNTY"):
                rec["county"] = a["COUNTY"]
            u = str(a.get("URL") or "").strip()
            if u.startswith("http"):
                rec["url"] = u
            rows.append(rec)

        paged("https://services6.arcgis.com/DZHaqZm9cxOD4CWM/arcgis/rest/"
              "services/NYS_DEC_Lands/FeatureServer/0/query",
              "1=1", "CATEGORY,FACILITY,CLASS,COUNTY,ACRES,URL", one)
        return {"nyparks_dec_v1": rows}

    # --- town parks ----------------------------------------------------
    def s_municipal():
        muni = []

        def mu(f):
            a, c = f["attributes"], point_of(f)
            if not a.get("name") or not c:
                return
            lat = round(c["y"], 5)
            rec = {"n": a["name"], "lat": lat, "lng": round(c["x"], 5)}
            ac = acres_of(a.get("Shape__Area"), lat)
            if ac >= 1:
                rec["a"] = ac
            w = a.get("website")
            if w and str(w).startswith("http"):
                rec["w"] = w
            muni.append(rec)

        paged(OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
              "leisure='park' AND name IS NOT NULL AND "
              "(access IS NULL OR access NOT IN ('private','no'))",
              "name,access,website,Shape__Area", mu)
        return {"ctparks_municipal_v3": muni}

    # --- greens, rec grounds, forests ----------------------------------
    def s_landuse():
        lu = []

        def lf(f):
            a, c = f["attributes"], point_of(f)
            if not a.get("name") or not c:
                return
            lat = round(c["y"], 5)
            lu.append({"n": a["name"], "lat": lat, "lng": round(c["x"], 5),
                       "k": a.get("landuse"), "op": a.get("operator") or "",
                       "a": acres_of(a.get("Shape__Area"), lat)})

        paged(OSM6 + "OSM_NA_Landuse/FeatureServer/0/query",
              "landuse IN ('recreation_ground','village_green','forest') AND "
              "name IS NOT NULL AND (access IS NULL OR access NOT IN ('private','no'))",
              "name,landuse,operator,Shape__Area", lf)
        return {"ctparks_landuse_v1": lu}

    # --- preserves (raw; classified later by buildplaces) --------------
    def s_preserves():
        pres = []

        def pf(f):
            a, c = f["attributes"], point_of(f)
            if not c:
                return
            w = a.get("website")
            pres.append({"n": a.get("name") or "", "op": a.get("operator") or "",
                         "lat": round(c["y"], 5), "lng": round(c["x"], 5),
                         "w": w if w and str(w).startswith("http") else None})

        paged(OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
              "leisure='nature_reserve' AND (access IS NULL OR access NOT IN ('private','no'))",
              "name,operator,website,Shape__Area", pf)
        return {"ctparks_preserve_raw_v1": pres}

    # --- cemeteries ----------------------------------------------------
    def s_cemeteries():
        cem = []

        def cf(f):
            a, c = f["attributes"], point_of(f)
            if not a.get("name") or not c:
                return
            rec = {"n": a["name"], "lat": round(c["y"], 5), "lng": round(c["x"], 5)}
            w = a.get("website")
            if w and str(w).startswith("http"):
                rec["w"] = w
            cem.append(rec)

        paged(OSM6 + "OSM_NA_Landuse/FeatureServer/0/query",
              "landuse='cemetery' AND name IS NOT NULL AND "
              "(access IS NULL OR access NOT IN ('private','no'))",
              "name,website,Shape__Area", cf)
        return {"ctparks_cem_v2": cem}

    # --- museum / historic grounds (POINT layer) -----------------------
    def s_museums():
        mus = []

        def mf(f):
            a, c = f["attributes"], point_of(f)
            if not a.get("name") or not c:
                return
            w = a.get("website")
            mus.append({"n": a["name"], "lat": round(c["y"], 5), "lng": round(c["x"], 5),
                        "h": a.get("historic") or "", "op": a.get("operator") or "",
                        "w": w if w and str(w).startswith("http") else None})

        paged(OSM6 + "OSM_NA_Tourism/FeatureServer/0/query",
              "tourism='museum' AND name IS NOT NULL AND historic IS NOT NULL",
              "name,historic,operator,website", mf, centroid=False)
        return {"ctparks_museum_v1": mus}

    # --- facilities ----------------------------------------------------
    def s_facilities():
        fac = []

        def ff(f):
            c = point_of(f)
            if c:
                fac.append([round(c["y"], 5), round(c["x"], 5),
                            f["attributes"].get("leisure") or "",
                            f["attributes"].get("sport") or ""])

        paged(OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
              "leisure IN ('pitch','track','swimming_pool','playground','dog_park',"
              "'sports_centre','fitness_station','beach_resort') AND "
              "(access IS NULL OR access NOT IN ('private','no'))",
              "leisure,sport", ff)
        return {"ctparks_fac_v1": fac}

    # --- public parking (POINT layer — no centroid support) ------------
    def s_parking():
        park = []

        def pk(f):
            c = point_of(f)
            if c:
                park.append([round(c["y"], 5), round(c["x"], 5)])

        paged(OSM6 + "OSM_NA_POIs/FeatureServer/0/query",
              "amenity='parking' AND (access IS NULL OR access NOT IN "
              "('private','no','customers','permit'))",
              "OBJECTID", pk, centroid=False)
        return {"ctparks_park_v1": park}

    # --- named water ---------------------------------------------------
    def s_water():
        wtr = []

        def wf(f):
            a, c = f["attributes"], point_of(f)
            if not c or not a.get("name"):
                return
            lat = round(c["y"], 5)
            k = math.cos(math.radians(lat))
            area = (a.get("Shape__Area") or 0) * k * k
            if area < 2000:
                return
            kind = (a.get("water") or a.get("waterway") or "").lower()
            wtr.append([lat, round(c["x"], 5), a["name"],
                        round(math.sqrt(area / math.pi)), kind])

        # Ask for the type tags, but fall back if this mirror doesn't expose
        # them — a bad outFields list makes the whole query error out.
        try:
            paged(OSM6 + "OSM_NA_Water/FeatureServer/0/query", "name IS NOT NULL",
                  "name,Shape__Area,water,waterway", wf)
        except Exception:                               # noqa: BLE001
            wtr.clear()
            paged(OSM6 + "OSM_NA_Water/FeatureServer/0/query", "name IS NOT NULL",
                  "name,Shape__Area", wf)
        return {"ctparks_wtr_v1": wtr}

    # --- PAD-US named places -------------------------------------------
    def s_padus():
        pad = []

        def padf(f):
            a, c = f["attributes"], point_of(f)
            if not a.get("Unit_Nm") or not c:
                return
            if a.get("Own_Name") == "TRIB" or a.get("Mang_Name") == "TRIB":
                return
            pad.append({"n": a["Unit_Nm"].strip(), "own": a.get("Own_Name") or "UNK",
                        "acc": a.get("Pub_Access") or "UK", "des": a.get("Des_Tp") or "",
                        "a": round(a.get("GIS_Acres") or 0),
                        "lat": round(c["y"], 5), "lng": round(c["x"], 5)})

        paged(PADUS, "Unit_Nm<>'Unknown' AND Pub_Access<>'XA'",
              "Unit_Nm,Own_Name,Mang_Name,Pub_Access,Des_Tp,GIS_Acres", padf)
        return {"ctparks_padusplaces_v1": pad}

    # --- trail coverage grid -------------------------------------------
    def s_trailgrid():
        cells = set()

        def tf(f):
            g = f.get("geometry") or {}
            for path in g.get("paths") or []:
                for pt in path:
                    cells.add(math.floor(pt[1] / TRAIL_CELL) * 1000000
                              + (math.floor(pt[0] / TRAIL_CELL) + 500000))

        # Goes through paged() rather than paging the whole region itself.
        # This section kept its own loop and so missed the adaptive tiling
        # entirely — it was still asking one rectangle for ~139,000 ways
        # and was the last section the OSM mirror refused after everything
        # else started succeeding.
        paged(OSM6 + "OSM_NA_Trails/FeatureServer/0/query",
              "highway IN ('path','track','bridleway')", "", tf,
              centroid=False, page=2000, simplify=("0.004", "4"))

        # The Blue-Blazed system is ~825 miles that OpenStreetMap often hasn't
        # tagged as paths. It was already being drawn on the map but wasn't
        # counted as evidence of a way in, which left real hiking land sitting
        # in the unverified pile.
        try:
            bb = post(DEEP + "BlueBlazedHikingTrails/FeatureServer/0/query",
                      {"where": "1=1", "outSR": "4326", "returnGeometry": "true",
                       "maxAllowableOffset": "0.0002", "geometryPrecision": "5",
                       "resultRecordCount": "1000", "outFields": ""})
            added = 0
            for f in bb.get("features") or []:
                for path in (f.get("geometry") or {}).get("paths") or []:
                    for pt in path:
                        cells.add(math.floor(pt[1] / TRAIL_CELL) * 1000000
                                  + (math.floor(pt[0] / TRAIL_CELL) + 500000))
                        added += 1
            print(f"  blue-blazed vertices folded into trail grid: {added:,}",
                  flush=True)
        except Exception as e:                          # noqa: BLE001
            print(f"  blue-blazed trail grid skipped: {e}", flush=True)

        return {"ctparks_trailgrid_v2": sorted(cells)}

    sections = [
        ("DEEP wildlife/hatchery/flood land", ["ctparks_stateextra_v1"], s_stateextra),
        ("boat launches", ["ctparks_boat_v2"], s_boats),
        ("coastal access sites", ["ctparks_coastal_v1"], s_coastal),
        ("New York DEC lands", ["nyparks_dec_v1"], s_nydec),
        ("town parks", ["ctparks_municipal_v3"], s_municipal),
        ("greens and rec grounds", ["ctparks_landuse_v1"], s_landuse),
        ("preserves", ["ctparks_preserve_raw_v1"], s_preserves),
        ("cemeteries", ["ctparks_cem_v2"], s_cemeteries),
        ("museum grounds", ["ctparks_museum_v1"], s_museums),
        ("facilities", ["ctparks_fac_v1"], s_facilities),
        ("public parking", ["ctparks_park_v1"], s_parking),
        ("named water", ["ctparks_wtr_v1"], s_water),
        ("PAD-US places", ["ctparks_padusplaces_v1"], s_padus),
        ("trail grid", ["ctparks_trailgrid_v2"], s_trailgrid),
    ]
    # --only exists so one source can be exercised on its own. The full
    # attribute pass is ~13 minutes across eight services, which is long
    # enough that the alternative is testing a hand-copied version of the
    # fetcher rather than the fetcher — and this project has already been
    # burned once verifying tiles with the same broken decoder that made
    # them.
    if only:
        want = {s.strip() for s in only.split(",") if s.strip()}
        sections = [s for s in sections if s[0] in want or set(s[1]) & want]
        if not sections:
            raise SystemExit(f"--only matched no section: {sorted(want)}")

    for name, keys, fn in sections:
        run_section(cache, stale, prev, name, keys, fn)

    for k, v in cache.items():
        tag = "  (STALE — last refresh's copy)" if k in stale else ""
        print(f"  {k}: {len(v):,}{tag}", flush=True)
    return cache, stale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="raw")
    ap.add_argument("--prev", default=None,
                    help="previous baked.json to degrade to per section "
                         "(default: data/baked.json when it exists)")
    ap.add_argument("--skip-geometry", action="store_true")
    ap.add_argument("--only-attributes", action="store_true")
    ap.add_argument("--only", default=None,
                    help="run only these attribute sections (comma separated, "
                         "by section name or cache key); writes "
                         "baked-partial.json, never baked.json")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    prev = {}
    prev_path = args.prev
    if prev_path is None and os.path.exists(os.path.join("data", "baked.json")):
        prev_path = os.path.join("data", "baked.json")
    if prev_path:
        try:
            prev = json.load(open(prev_path)).get("cache") or {}
            print(f"fallback data: {prev_path} ({len(prev)} sections)", flush=True)
        except Exception as e:                      # noqa: BLE001
            print(f"::warning::previous baked.json unreadable ({e}) — "
                  "sections have no fallback this run", flush=True)

    print("Attributes and place lists:", flush=True)
    cache, stale = fetch_attributes(args.out, prev, args.only)
    doc = {"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "cache": cache}
    if stale:
        doc["stale"] = stale
    # A partial run must not land on baked.json. buildplaces.py would read
    # it, find eleven of twelve sections missing, and build a near-empty
    # places.json without anything failing — the silent-success trap.
    name = "baked-partial.json" if args.only else "baked.json"
    with open(os.path.join(args.out, name), "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    if args.only:
        print(f"\npartial run — wrote {args.out}/{name}, "
              "NOT baked.json; do not feed this to buildplaces.py", flush=True)

    if not (args.only or args.skip_geometry or args.only_attributes):
        print("\nGeometry for tiles:", flush=True)
        fetch_geometry(args.out)
    print("\ndone")


if __name__ == "__main__":
    main()
