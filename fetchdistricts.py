#!/usr/bin/env python3
"""Build data/districts.json — the "places to wander" layer.

A second class of walkable place: ground you may PASS THROUGH rather than
ground you may enter. See claude/walkable-places-plan.md in the project
for why these are deliberately not parks and never carry an access
colour.

Source: the National Register of Historic Places polygon layer, NPS.
Federal, authoritative, queryable, citable — the same calibre of source
as the rest of the pipeline.

Two field quirks that cost a round trip when this was written:
  * `State` holds the full name in caps — 'CONNECTICUT', not 'CT'
  * `ResType` is lowercase — 'district', not 'District'
Both silently return zero rows rather than erroring, which is exactly the
kind of confident-looking nothing this project keeps getting bitten by.

This writes its OWN file rather than joining places.json. Districts are
410 polygons, they need visual iteration, and a full refresh costs 65
minutes — so they stay out of the tile archive until there is a reason.
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

NRHP = ("https://mapservices.nps.gov/arcgis/rest/services/cultural_resources/"
        "nrhp_locations/MapServer/1/query")

# Connecticut, with a little slack. Used only as a sanity filter: the
# State field does the real work.
CT_BOX = (-73.80, 40.90, -71.70, 42.10)

PAGE = 200


def fetch_page(offset, timeout=90):
    params = {
        "where": "State='CONNECTICUT' AND ResType='district'",
        "outFields": "RESNAME,City,County,CertDate,NRIS_Refnum,Is_NHL",
        "returnGeometry": "true",
        "outSR": "4326",
        # About 8 m — plenty for a district boundary drawn at town zoom,
        # and it keeps the whole layer small enough to ship as one file.
        "maxAllowableOffset": "0.00008",
        "geometryPrecision": "5",
        "resultOffset": str(offset),
        "resultRecordCount": str(PAGE),
        "f": "json",
    }
    req = urllib.request.Request(
        NRHP,
        data=urllib.parse.urlencode(params).encode(),
        headers={"User-Agent": "EveryPark/1.0 (+https://everypark.starrysidekick.com)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.load(r)
    if "error" in j:
        raise RuntimeError(j["error"].get("message", "service error"))
    return j


def rings_of(geom):
    """ArcGIS rings -> GeoJSON polygon coordinates, outer rings only.

    Holes are dropped deliberately: a dashed outline with no fill has
    nothing to show through a hole, and keeping them doubles the size.
    """
    out = []
    for ring in geom.get("rings", []):
        if len(ring) < 4:
            continue
        out.append([[round(x, 5), round(y, 5)] for x, y in ring])
    return out


def in_ct(rings):
    w, s, e, n = CT_BOX
    for ring in rings:
        for x, y in ring:
            if w <= x <= e and s <= y <= n:
                return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default="data/districts.json")
    args = ap.parse_args()

    feats, offset = [], 0
    while True:
        for attempt in (1, 2, 3):
            try:
                j = fetch_page(offset)
                break
            except Exception as exc:                       # noqa: BLE001
                if attempt == 3:
                    print(f"::error::NRHP fetch failed at offset {offset}: {exc}")
                    return 1
                print(f"  retry {attempt} at offset {offset}: {exc}", flush=True)
                time.sleep(5 * attempt)

        batch = j.get("features", [])
        if not batch:
            break
        for f in batch:
            a = f.get("attributes") or {}
            rings = rings_of(f.get("geometry") or {})
            if not rings or not in_ct(rings):
                continue
            name = (a.get("RESNAME") or "").strip()
            if not name:
                continue
            feats.append({
                "name": name,
                "town": (a.get("City") or "").strip(),
                "county": (a.get("County") or "").strip(),
                "ref": (a.get("NRIS_Refnum") or "").strip(),
                "landmark": (a.get("Is_NHL") or "").strip().lower() == "yes",
                "rings": rings,
            })
        print(f"  {offset + len(batch):>4} rows fetched, {len(feats)} kept", flush=True)
        if not j.get("exceededTransferLimit") and len(batch) < PAGE:
            break
        offset += len(batch)

    if not feats:
        print("::error::no districts returned — check the State/ResType "
              "field values, they fail silently rather than erroring")
        return 1

    feats.sort(key=lambda d: (d["town"], d["name"]))
    doc = {
        "kind": "districts",
        "source": "National Register of Historic Places (NPS)",
        "sourceUrl": NRHP.rsplit("/query", 1)[0],
        "checked": time.strftime("%Y-%m-%d"),
        "note": ("Designated historic districts. These are places to walk "
                 "THROUGH, not land to enter — they carry no access colour."),
        "districts": feats,
    }
    with open(args.out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    import os
    print(f"{len(feats):,} districts -> {args.out} "
          f"({os.path.getsize(args.out) / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
