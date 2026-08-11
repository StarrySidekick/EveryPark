#!/usr/bin/env python3
"""
Add elevation and land cover to every place.

These two matter because, unlike everything else on the map, they don't
depend on anyone having mapped the place. Trails, playgrounds and parking
only exist as data if a volunteer walked in and tagged them, which is why
half our verified parks carry a single fact. Elevation and land cover are
sampled from rasters that blanket the whole state, so every park gets them
— including the remote preserves that currently show nothing.

  elevation   USGS 3DEP, sampled at up to 9 points across each place.
              Gives mean height and relief (max - min), which is a decent
              proxy for how hilly somewhere is.

  land cover  USGS NLCD via MRLC's WMS. One small image per place, then
              count the pixels by class. That gives a real composition —
              62% deciduous forest, 20% grassland — rather than whatever
              a single centre point happened to land on, and answers the
              "open field or dense forest?" question directly.

    python3 enrichraster.py --in data/places.json -o data/places.json
"""

import argparse
import io
import json
import math
import os
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import requests

DEP = ("https://elevation.nationalmap.gov/arcgis/rest/services/"
       "3DEPElevation/ImageServer/getSamples")
NLCD = "https://www.mrlc.gov/geoserver/mrlc_display/wms"
NLCD_LAYER = "NLCD_2021_Land_Cover_L48"
MERC = 20037508.342789244

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "EveryPark/1.0 (+https://everypark.starrysidekick.com)"

# NLCD classes. `open` is the answer to "can I walk across it or is it
# thick?" — forest and woody wetland are closed, fields and grass are open.
NLCD_CLASS = {
    11: ("Open water", "water"),
    12: ("Ice / snow", "open"),
    21: ("Developed, open space", "open"),
    22: ("Developed, low intensity", "developed"),
    23: ("Developed, medium intensity", "developed"),
    24: ("Developed, high intensity", "developed"),
    31: ("Barren / rock", "open"),
    41: ("Deciduous forest", "closed"),
    42: ("Evergreen forest", "closed"),
    43: ("Mixed forest", "closed"),
    51: ("Dwarf scrub", "open"),
    52: ("Shrub / scrub", "open"),
    71: ("Grassland", "open"),
    72: ("Sedge", "open"),
    73: ("Lichens", "open"),
    74: ("Moss", "open"),
    81: ("Pasture / hay", "open"),
    82: ("Cultivated crops", "open"),
    90: ("Woody wetland", "closed"),
    95: ("Herbaceous wetland", "open"),
}

# The standard NLCD colour table, so the image can be decoded even if the
# server hands back RGB rather than a paletted image.
NLCD_RGB = {
    (70, 107, 159): 11, (209, 222, 248): 12, (222, 197, 197): 21,
    (217, 146, 130): 22, (235, 0, 0): 23, (171, 0, 0): 24,
    (179, 172, 159): 31, (104, 171, 95): 41, (28, 95, 44): 42,
    (181, 197, 143): 43, (147, 204, 147): 51, (204, 184, 121): 52,
    (223, 223, 194): 71, (209, 209, 130): 72, (163, 204, 81): 73,
    (130, 186, 157): 74, (220, 217, 57): 81, (171, 108, 40): 82,
    (184, 217, 235): 90, (108, 159, 184): 95,
}


def merc(lon, lat):
    lat = max(min(lat, 85.05), -85.05)
    x = lon * MERC / 180.0
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * (MERC / math.pi)
    return x, y


def radius_m(acres):
    if not acres:
        return 120.0
    return min(2200.0, max(90.0, math.sqrt(acres * 4047 / math.pi)))


def sample_points(p):
    """Centre, plus a ring, scaled to how big the place is."""
    r = radius_m(p.get("acres"))
    lat, lng = p["lat"], p["lng"]
    pts = [(lng, lat)]
    if (p.get("acres") or 0) < 5:
        return pts
    dlat = r / 111320.0
    dlng = r / (111320.0 * max(0.2, math.cos(math.radians(lat))))
    for f in (0.55, 0.85):
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            pts.append((lng + dx * dlng * f, lat + dy * dlat * f))
    return pts[:9]


def post(url, data, tries=3, timeout=90):
    last = None
    for a in range(tries):
        try:
            r = SESSION.post(url, data=data, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as e:                      # noqa: BLE001
            last = e
            time.sleep(1.0 * (a + 1))
    raise RuntimeError(str(last))


# ------------------------------------------------------------ elevation
def fetch_elevation(places, workers=4, batch=80):
    """
    One request per batch of points. getSamples takes a multipoint, so a
    few hundred requests covers every place rather than tens of thousands.
    """
    jobs = []                        # (place index, number of points)
    flat = []
    for i, p in enumerate(places):
        pts = sample_points(p)
        jobs.append((i, len(pts)))
        flat.extend(merc(x, y) for x, y in pts)

    values = [None] * len(flat)

    def grab(start):
        chunk = flat[start:start + batch]
        geom = {"points": [[round(x, 1), round(y, 1)] for x, y in chunk],
                "spatialReference": {"wkid": 102100}}
        try:
            r = post(DEP, {"geometry": json.dumps(geom),
                           "geometryType": "esriGeometryMultipoint",
                           "returnFirstValueOnly": "true",
                           "returnCatalogItems": "false", "f": "json"})
            for k, s in enumerate(r.json().get("samples") or []):
                # The field is locationId, not sampleId. Reading the wrong
                # key silently discarded every value and left elevation at
                # 0% coverage. Fall back to response order if it's absent.
                sid = s.get("locationId", s.get("sampleId", k))
                v = s.get("value")
                if v in (None, "", "NoData"):
                    continue
                try:
                    values[start + int(sid)] = float(v)
                except (ValueError, IndexError, TypeError):
                    pass
        except Exception as e:                      # noqa: BLE001
            print(f"    elevation batch @{start} failed: {e}", flush=True)

    starts = list(range(0, len(flat), batch))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(grab, starts))

    done = 0
    cur = 0
    for i, n in jobs:
        vals = [v for v in values[cur:cur + n] if v is not None]
        cur += n
        if not vals:
            continue
        A = places[i].setdefault("attrs", {})
        A["elev"] = round(sum(vals) / len(vals))
        if len(vals) > 1:
            rel = round(max(vals) - min(vals))
            if rel > 0:
                A["relief"] = rel
        done += 1
    return done


# ----------------------------------------------------------- land cover
def fetch_landcover(places, workers=8, size=24):
    """
    A small NLCD image per place, then count pixels by class. One request
    each, and it yields the mix rather than a single point's class.
    """
    try:
        from PIL import Image
    except ImportError:
        print("    Pillow missing — skipping land cover", flush=True)
        return 0

    done = [0]

    def grab(i):
        p = places[i]
        r_m = radius_m(p.get("acres"))
        dlat = r_m / 111320.0
        dlng = r_m / (111320.0 * max(0.2, math.cos(math.radians(p["lat"]))))
        bbox = (f"{p['lng']-dlng:.6f},{p['lat']-dlat:.6f},"
                f"{p['lng']+dlng:.6f},{p['lat']+dlat:.6f}")
        params = {"service": "WMS", "version": "1.1.1", "request": "GetMap",
                  "layers": NLCD_LAYER, "styles": "", "srs": "EPSG:4326",
                  "bbox": bbox, "width": size, "height": size,
                  "format": "image/png"}
        # Short timeout, retried — NOT one long wait.
        #
        # This stage took 68 minutes on the first two-state refresh and
        # the reason was not work, it was dead waiting. MRLC answers a
        # 24x24 GetMap in about half a second (measured: 0.5s cold, 0.02s
        # per place across 8 workers, and a 2,200 m bbox over the
        # Adirondacks is no slower than a 200 m one). But it throttles
        # under sustained load, and the timeout was 60s: 540 of 2,499
        # requests failed that run — the log says 78.4% — and 540 dead
        # minute-long waits across 8 workers is essentially the whole
        # stage. Those 540 places also silently got no land cover.
        #
        # Three short attempts cost at most 21s instead of 60, usually
        # succeed on the second when the first was throttled, and leave
        # far fewer places unsampled.
        r = None
        for attempt in range(3):
            try:
                r = SESSION.get(NLCD, params=params, timeout=12)
                r.raise_for_status()
                break
            except Exception:                       # noqa: BLE001
                r = None
                if attempt < 2:
                    time.sleep(0.6 * (attempt + 1))
        if r is None:
            return
        try:
            # Always work in RGB. A paletted PNG's indices are GeoServer's
            # own palette, not NLCD class codes — assuming otherwise matched
            # about a fifth of pixels and put every one of them in the same
            # bucket. Nearest-colour matching also absorbs the small
            # rounding differences between published NLCD colour tables.
            img = Image.open(io.BytesIO(r.content)).convert("RGB")
            counts = Counter()
            for px in img.getdata():
                c = NLCD_RGB.get(px)
                if c is None:
                    best, bd = None, 400
                    for rgb, cls in NLCD_RGB.items():
                        d = ((px[0]-rgb[0])**2 + (px[1]-rgb[1])**2
                             + (px[2]-rgb[2])**2)
                        if d < bd:
                            best, bd = cls, d
                    c = best
                if c:
                    counts[c] += 1
            total = sum(counts.values())
            if not total:
                return
            A = p.setdefault("attrs", {})
            groups = Counter()
            for cls, n in counts.items():
                groups[NLCD_CLASS[cls][1]] += n
            land = total - groups.get("water", 0)
            if land > 0:
                openpct = round(100 * groups.get("open", 0) / land)
                A["openPct"] = openpct
                A["cover"] = ("mostly open" if openpct >= 65 else
                              "mixed" if openpct >= 30 else "mostly wooded")
            top = counts.most_common(1)[0][0]
            A["coverTop"] = NLCD_CLASS[top][0]
            if groups.get("water", 0) / total >= 0.12:
                A["water"] = True
            done[0] += 1
        except Exception:                           # noqa: BLE001
            pass

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(grab, range(len(places))))
    return done[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--limit", type=int, default=0, help="for smoke tests")
    ap.add_argument("--reuse-from", dest="reuse",
                    help="previous places.json; places already carrying "
                         "elevation and land cover are copied forward "
                         "instead of resampled")
    args = ap.parse_args()

    data = json.load(open(args.src))
    places = data["places"]
    if args.limit:
        places = places[:args.limit]
    print(f"  {len(places):,} places", flush=True)

    # Elevation and land cover are the slowest stage here and the least
    # volatile thing on the map: the ground does not move between monthly
    # refreshes. Resampling all of them cost ~25 minutes for Connecticut
    # alone, and adding New York triples the record count. Carrying the
    # known values forward means a refresh only samples what is new.
    #
    # Keyed on id, which dedupe.py assigns once and never recomputes, with
    # a coordinate fallback for records that predate an id.
    KEYS = ("elev", "relief", "openPct", "cover", "coverTop")
    todo = places
    if args.reuse and os.path.exists(args.reuse):
        prev = {}
        for q in (json.load(open(args.reuse)).get("places") or []):
            a = q.get("attrs") or {}
            if a.get("elev") is None and not a.get("cover"):
                continue
            if q.get("id"):
                prev[q["id"]] = a
            if q.get("lat") is not None:
                prev[(round(q["lat"], 5), round(q["lng"], 5))] = a
        reused = 0
        for p in places:
            src = prev.get(p.get("id"))
            if src is None and p.get("lat") is not None:
                src = prev.get((round(p["lat"], 5), round(p["lng"], 5)))
            if not src:
                continue
            A = p.setdefault("attrs", {})
            for k in KEYS:
                if k in src and A.get(k) is None:
                    A[k] = src[k]
            if A.get("elev") is not None:
                reused += 1
        # Missing EITHER sample, not just elevation. Keying only on elev
        # meant the 728 places whose land-cover request failed were
        # carried forward as "done" forever — elevation had succeeded for
        # all of them, so they never re-entered the queue and the failure
        # was permanent. coverTop is the right witness for land cover:
        # `cover` is legitimately absent on an all-water sample.
        todo = [p for p in places
                if (p.get("attrs") or {}).get("elev") is None
                or (p.get("attrs") or {}).get("coverTop") is None]
        print(f"  reused elevation/land cover for {reused:,}; "
              f"{len(todo):,} still to sample", flush=True)

    if not todo:
        print("  nothing new to sample", flush=True)
    else:
        t = time.time()
        n = fetch_elevation(todo)
        print(f"  elevation: {n:,} places ({100*n/len(todo):.1f}%) "
              f"in {time.time()-t:.0f}s", flush=True)

        t = time.time()
        n = fetch_landcover(todo)
        print(f"  land cover: {n:,} places ({100*n/len(todo):.1f}%) "
              f"in {time.time()-t:.0f}s", flush=True)

    if not args.limit:
        with open(args.out, "w") as fh:
            json.dump({"built": data.get("built"), "places": places}, fh,
                      separators=(",", ":"))
        print(f"  -> {args.out} "
              f"({os.path.getsize(args.out)/1024/1024:.2f} MB)")


if __name__ == "__main__":
    main()
