#!/usr/bin/env python3
"""
Second pass over data/places.json: attach real boundaries, then decide
what actually counts as a park.

Split from buildplaces.py only because the two together take longer than
one shell call allows; the logic lives in buildplaces and is imported.

    python3 verifyplaces.py --raw raw --in data/places.json -o data/places.json
"""

import argparse
import json
import os
from collections import defaultdict

from buildplaces import attach_geometry, verify_all, norm


# Fields a research entry may set directly on the place attributes.
VERIFIED_ATTRS = ("trails", "parking", "water", "waterName", "waterType",
                  "sports", "sportList", "playground", "historic", "beach",
                  "pool", "dogpark", "reachable")


def apply_verified(places, path):
    """
    Overlay hand-researched facts on top of what the GIS could work out.

    The automated sources only know what somebody mapped. Plenty of real
    town parks have no trail tagged inside them and come out unverified —
    Clatter Valley in New Milford is 100 acres with hiking trails, a pond
    and a pavilion, and OpenStreetMap knows none of it. A web search
    settles it in seconds, so this puts that research back into the data.
    """
    if not os.path.exists(path):
        return 0
    try:
        doc = json.load(open(path))
    except Exception as e:                          # noqa: BLE001
        print(f"  verified.json unreadable: {e}", flush=True)
        return 0
    entries = doc.get("places") or []

    index = {}
    for i, p in enumerate(places):
        index.setdefault((norm(p["name"]), p.get("town")), i)
        index.setdefault((norm(p["name"]), None), i)

    # Category rules first: one cited regulation can settle hundreds of
    # places. Name-matched entries run afterwards so they can override.
    rules = doc.get("rules") or []
    rule_hits = 0
    for rule in rules:
        m = rule.get("match") or {}
        for p in places:
            if any(p.get(k) != v for k, v in m.items()):
                continue
            A = p.setdefault("attrs", {})
            for k in VERIFIED_ATTRS:
                if k in rule and rule[k] is not False:
                    A[k] = rule[k]
            if rule.get("siteRules"):
                A["siteRules"] = rule["siteRules"]
            A["researched"] = True
            if rule.get("checked"):
                A["checked"] = rule["checked"]
            if rule.get("source"):
                A["sources"] = rule["source"]
            rule_hits += 1
    if rule_hits:
        print(f"  {rule_hits:,} places settled by category rule", flush=True)

    hits = 0
    for e in entries:
        m = e.get("match") or {}
        i = index.get((norm(m.get("name", "")), m.get("town")))
        if i is None:
            i = index.get((norm(m.get("name", "")), None))
        if i is None:
            print(f"  no match for verified entry: {m.get('name')!r}", flush=True)
            continue
        p = places[i]
        A = p.setdefault("attrs", {})
        if e.get("siteRules"):
            A["siteRules"] = e["siteRules"]
        for k in VERIFIED_ATTRS:
            if k in e:
                if e[k] is False:
                    A.pop(k, None)
                else:
                    A[k] = e[k]
        if e.get("rename"):
            p["name"] = e["rename"]
        for k in ("town", "agency", "url", "fee", "note", "acres"):
            if e.get(k) is not None:
                p[k] = e[k]
        # Provenance: the card can say this was checked by a human, and
        # anyone auditing later can follow the citation.
        A["researched"] = True
        if e.get("source"):
            src = e["source"]
            A["sources"] = src if isinstance(src, list) else [src]
        if e.get("checked"):
            A["checked"] = e["checked"]
        hits += 1
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--data", default="data")
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    data = json.load(open(args.src))
    places = data["places"]
    print(f"  {len(places):,} places in", flush=True)

    applied = apply_verified(places, os.path.join(args.data, "verified.json"))
    if applied:
        print(f"  {applied} places corrected by research", flush=True)

    shaped = attach_geometry(places, args.raw)
    print(f"  boundaries matched to {shaped:,} "
          f"({100*shaped/len(places):.1f}%)", flush=True)

    verify_all(places)
    tally = defaultdict(int)
    fees = defaultdict(int)
    for p in places:
        tally[p["status"]] += 1
        fees[p["feeState"]] += 1
    print("  status: " + "  ".join(f"{k} {v:,}" for k, v in sorted(tally.items())))
    print("  fee:    " + "  ".join(f"{k} {v:,}" for k, v in sorted(fees.items())))

    # Verifying re-derives access, steward and the rest; strip them again
    # so the file stays source-facts-only. statusWhy is likewise rebuilt in
    # the browser — it's a long sentence repeated thousands of times.
    DROP = ("access", "accessLabel", "accessWhy", "steward", "kind", "statusWhy")
    for p in places:
        for k in DROP:
            p.pop(k, None)
        a = p.get("attrs") or {}
        for k in ("accessNote", "visitable"):
            a.pop(k, None)

    with open(args.out, "w") as fh:
        json.dump({"built": data.get("built"), "places": places}, fh,
                  separators=(",", ":"))
    print(f"\n  -> {args.out} ({os.path.getsize(args.out)/1024/1024:.2f} MB)")


if __name__ == "__main__":
    main()
