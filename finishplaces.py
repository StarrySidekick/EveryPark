#!/usr/bin/env python3
"""
Replay the two passes that run after enrich() finishes: trail proximity
and PAD-US access ratings. Mirrors applyTrailAccess() and loadPadus() in
app.js exactly — see scoreAccess() and classify() there.

    python3 finishplaces.py places.json baked.json ep-padus.geojson -o places.json
"""

import argparse
import json
import math

TRAIL_CELL = 0.0015
PADUS_MATCH_M = 500

STEWARD_BY_TYPE = {
    "state": "State of Connecticut (DEEP)",
    "national": "Federal government",
    "town": "Town or city",
    "preserve": "Land trust or non-profit",
    "cemetery": "Cemetery association or town",
}
KIND_BY_TYPE = {"state": "State Park", "national": "Federal Land", "town": "Town Park",
                "preserve": "Preserve", "cemetery": "Cemetery"}
ACCESS_LABEL = {"open": "Open to all", "permission": "Open by permission",
                "closed": "Closed to the public", "unknown": "Access unverified"}
ACCESS_WORD = {"OA": "Open", "RA": "Restricted", "XA": "Closed", "UK": "Unknown",
               "Open Access": "Open", "Restricted Access": "Restricted",
               "Closed": "Closed", "Closed Access": "Closed", "Unknown": "Unknown"}
OWNER_WORD = {
    "NPS": "National Park Service", "FWS": "US Fish & Wildlife Service",
    "USFS": "US Forest Service", "USACE": "US Army Corps of Engineers",
    "DOD": "US Department of Defense", "SDC": "State conservation agency",
    "SPR": "State parks agency", "SFW": "State fish & wildlife agency",
    "SDNR": "State natural resources agency", "OTHS": "State government",
    "CITY": "City or town", "CNTY": "County", "REG": "Regional agency",
    "NGO": "Non-profit / land trust", "PVT": "Private owner",
    "JNT": "Jointly owned", "UNK": "Unknown owner",
}


def park_radius_m(p):
    acres = p.get("a") or p.get("acres") or 0
    if not acres:
        return 120.0
    return min(2200.0, max(90.0, math.sqrt(acres * 4047 / math.pi)))


def trail_near(lat, lng, radius_m, cells):
    span = min(6, math.ceil(radius_m / 111000 / TRAIL_CELL))
    i0 = math.floor(lat / TRAIL_CELL)
    j0 = math.floor(lng / TRAIL_CELL)
    for i in range(i0 - span, i0 + span + 1):
        for j in range(j0 - span, j0 + span + 1):
            if i * 1000000 + (j + 500000) in cells:
                return True
    return False


def dist_m(a_lat, a_lng, b_lat, b_lng):
    dy = (a_lat - b_lat) * 111000
    dx = (a_lng - b_lng) * 111000 * math.cos(math.radians(a_lat))
    return math.hypot(dx, dy)


def classify(p):
    """Port of classify() in app.js."""
    A = p.setdefault("attrs", {})
    official = A.get("officialAccess")

    if official == "Open":
        p["access"] = "open"
    elif official == "Closed":
        p["access"] = "closed"
    elif official == "Restricted":
        p["access"] = "permission"
    elif p["type"] in ("state", "national", "town"):
        p["access"] = "open"
    elif p["type"] in ("preserve", "cemetery"):
        p["access"] = "permission"
    else:
        p["access"] = "unknown"

    A["visitable"] = bool(A.get("trails") or A.get("parking") or A.get("sports")
                          or A.get("playground") or A.get("beach") or A.get("pool"))
    if not A["visitable"] and p["access"] != "closed" and not official:
        p["access"] = "unknown"

    p["accessLabel"] = ACCESS_LABEL[p["access"]]
    if p["access"] == "open":
        if official == "Open":
            why = "Officially open (USGS PAD-US)."
        elif p["type"] == "state":
            why = "State land — public by default."
        elif p["type"] == "national":
            why = "Federal land — public by default."
        else:
            why = ("Municipal land — Connecticut town parks must admit "
                   "non-residents.")
    elif p["access"] == "permission":
        why = ("Privately held but customarily open. You're here by the owner's "
               "permission, not by legal right — Connecticut's Recreational Use "
               "Statute is what makes this common. Respect posted signs.")
    elif p["access"] == "closed":
        why = "Recorded as closed to public access."
    else:
        why = ("We found no trail, parking or facility here, and no official "
               "rating. It may still be open — we just can't confirm it.")
    p["accessWhy"] = why

    p["steward"] = (A.get("officialOwner") or p.get("agency")
                    or STEWARD_BY_TYPE.get(p["type"]) or "Unknown")
    p["kind"] = (p.get("subtype") or p.get("t")
                 or KIND_BY_TYPE.get(p["type"]) or "Public land")


def score_access(p):
    """Port of scoreAccess() in app.js."""
    A = p.setdefault("attrs", {})
    A["visitable"] = bool(A.get("trails") or A.get("parking") or A.get("sports")
                          or A.get("playground") or A.get("beach") or A.get("pool"))
    A["accessNote"] = ("Trails mapped" if A.get("trails")
                       else "Parking nearby, no mapped trail" if A.get("parking")
                       else "Facilities on site" if A["visitable"]
                       else "No mapped trail or parking")
    classify(p)


def centroid(geom):
    xs, ys = [], []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for i in c or []:
                walk(i)

    walk(geom.get("coordinates"))
    if not xs:
        return None
    return sum(ys) / len(ys), sum(xs) / len(xs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("places")
    ap.add_argument("baked")
    ap.add_argument("padus")
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    data = json.load(open(args.places))
    places = data["places"]
    cells = set(json.load(open(args.baked))["cache"]["ctparks_trailgrid_v2"])
    print(f"  {len(places):,} places, {len(cells):,} trail cells")

    # --- pass 1: trails -------------------------------------------------
    got = 0
    for p in places:
        if trail_near(p["lat"], p["lng"], park_radius_m(p) + 150, cells):
            p.setdefault("attrs", {})["trails"] = True
            got += 1
        score_access(p)
    print(f"  trails: {got:,} places")

    # --- pass 2: PAD-US ratings ----------------------------------------
    pad = json.load(open(args.padus))["features"]
    grid = {}
    kept = 0
    for f in pad:
        pr = f.get("properties") or {}
        c = centroid(f.get("geometry") or {})
        if not c or not pr.get("Pub_Access"):
            continue
        lat, lng = c
        grid.setdefault((round(lat / 0.01), round(lng / 0.01)), []).append(
            (lat, lng, pr.get("Pub_Access"), pr.get("Own_Name")))
        kept += 1
    print(f"  {kept:,} PAD-US areas indexed")

    tagged = 0
    for p in places:
        gi, gj = round(p["lat"] / 0.01), round(p["lng"] / 0.01)
        best = None
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for (lat, lng, acc, own) in grid.get((gi + di, gj + dj), []):
                    d = dist_m(p["lat"], p["lng"], lat, lng)
                    if d <= PADUS_MATCH_M and (best is None or d < best[0]):
                        best = (d, acc, own)
        if not best:
            continue
        word = ACCESS_WORD.get(best[1], best[1])
        if not word:
            continue
        A = p.setdefault("attrs", {})
        A["officialAccess"] = word
        if best[2]:
            A["officialOwner"] = OWNER_WORD.get(best[2], best[2])
        if word == "Open":
            A["visitable"] = True
            A["accessNote"] = "Open to the public (USGS PAD-US)"
        elif word == "Closed":
            A["visitable"] = False
            A["accessNote"] = "Closed to public access (USGS PAD-US)"
        elif word == "Restricted":
            A["accessNote"] = "Restricted access (USGS PAD-US) — check before visiting"
        classify(p)
        tagged += 1
    print(f"  PAD-US ratings applied to {tagged:,} places")

    json.dump({"built": data["built"], "places": places},
              open(args.out, "w"), separators=(",", ":"))
    print(f"  wrote {args.out}")


if __name__ == "__main__":
    main()
