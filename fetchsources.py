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

CT_BBOX = "-73.75,40.95,-71.77,42.06"
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


def count(url, where):
    j = post(url, {"where": where, "geometry": CT_BBOX,
                   "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                   "returnCountOnly": "true"})
    return j.get("count", 0)


def paged(url, where, out_fields, per_feature, geometry=False, page=1000,
          centroid=True, offset=GEOM_OFFSET, workers=3):
    """
    Page through a layer. Polygon layers answer returnCentroid; point
    layers reject it outright and hand back a plain geometry instead —
    getting that wrong fails silently, returning features that are all
    skipped, so callers pass centroid=False for point layers.
    """
    total = count(url, where)
    if not total:
        return 0
    offsets = list(range(0, total, page))
    got = [0]

    def grab(off):
        p = {"where": where, "geometry": CT_BBOX,
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
        j = post(url, p)
        feats = j.get("features") or []
        for f in feats:
            per_feature(f)
        got[0] += len(feats)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(grab, offsets))
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


def fetch_attributes(outdir):
    cache = {}

    # --- other DEEP land: wildlife areas, hatcheries, flood control ----
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
    cache["ctparks_stateextra_v1"] = [v for v in best.values() if v["a"] >= 5]

    # --- boat launches -------------------------------------------------
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
    cache["ctparks_boat_v2"] = boats

    # --- town parks ----------------------------------------------------
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
    cache["ctparks_municipal_v3"] = muni

    # --- greens, rec grounds, forests ----------------------------------
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
    cache["ctparks_landuse_v1"] = lu

    # --- preserves (raw; classified later by buildplaces) --------------
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
    cache["ctparks_preserve_raw_v1"] = pres

    # --- cemeteries ----------------------------------------------------
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
    cache["ctparks_cem_v2"] = cem

    # --- museum / historic grounds (POINT layer) -----------------------
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
    cache["ctparks_museum_v1"] = mus

    # --- facilities ----------------------------------------------------
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
    cache["ctparks_fac_v1"] = fac

    # --- public parking (POINT layer — no centroid support) ------------
    park = []

    def pk(f):
        c = point_of(f)
        if c:
            park.append([round(c["y"], 5), round(c["x"], 5)])

    paged(OSM6 + "OSM_NA_POIs/FeatureServer/0/query",
          "amenity='parking' AND (access IS NULL OR access NOT IN "
          "('private','no','customers','permit'))",
          "OBJECTID", pk, centroid=False)
    cache["ctparks_park_v1"] = park

    # --- named water ---------------------------------------------------
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
    cache["ctparks_wtr_v1"] = wtr

    # --- PAD-US named places -------------------------------------------
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
    cache["ctparks_padusplaces_v1"] = pad

    # --- trail coverage grid -------------------------------------------
    cells = set()

    def tf(f):
        g = f.get("geometry") or {}
        for path in g.get("paths") or []:
            for pt in path:
                cells.add(math.floor(pt[1] / TRAIL_CELL) * 1000000
                          + (math.floor(pt[0] / TRAIL_CELL) + 500000))

    total = count(OSM6 + "OSM_NA_Trails/FeatureServer/0/query",
                  "highway IN ('path','track','bridleway')")
    offsets = list(range(0, total, 2000))

    def grab(off):
        j = post(OSM6 + "OSM_NA_Trails/FeatureServer/0/query",
                 {"where": "highway IN ('path','track','bridleway')",
                  "geometry": CT_BBOX, "geometryType": "esriGeometryEnvelope",
                  "inSR": "4326", "outSR": "4326", "outFields": "",
                  "returnGeometry": "true", "maxAllowableOffset": "0.004",
                  "geometryPrecision": "4", "resultOffset": str(off),
                  "resultRecordCount": "2000"})
        for f in j.get("features") or []:
            tf(f)

    with ThreadPoolExecutor(max_workers=3) as ex:
        list(ex.map(grab, offsets))

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

    cache["ctparks_trailgrid_v2"] = sorted(cells)

    for k, v in cache.items():
        print(f"  {k}: {len(v):,}", flush=True)
    return cache


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="raw")
    ap.add_argument("--skip-geometry", action="store_true")
    ap.add_argument("--only-attributes", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    print("Attributes and place lists:", flush=True)
    cache = fetch_attributes(args.out)
    with open(os.path.join(args.out, "baked.json"), "w") as fh:
        json.dump({"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   "cache": cache}, fh, separators=(",", ":"))

    if not (args.skip_geometry or args.only_attributes):
        print("\nGeometry for tiles:", flush=True)
        fetch_geometry(args.out)
    print("\ndone")


if __name__ == "__main__":
    main()
