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
import math
import os
from collections import defaultdict

from buildplaces import attach_geometry, verify_all, norm
from dedupe import dedupe


# Fields a research entry may set directly on the place attributes.
# `private` is the negative counterpart of `reachable`: a cited finding
# that a place is members-only (community beach, club land). It fails the
# legal test in verify_all and hides the pin — the polygon stays, and the
# card explains. Without it, research proving a place is NOT public had
# no way to flow into the data.
VERIFIED_ATTRS = ("trails", "parking", "water", "waterName", "waterType",
                  "sports", "sportList", "playground", "historic", "beach",
                  "pool", "dogpark", "reachable", "private")

# How far a coordinate anchor may sit from a place and still be considered
# the same place, in metres. Generous enough to survive a centroid moving
# when a boundary is redrawn, tight enough not to grab the next park over.
ANCHOR_M = 600.0


def metres_between(lat1, lng1, lat2, lng2):
    k = math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lat1 - lat2) * 111320.0, (lng1 - lng2) * 111320.0 * k)


def apply_verified(places, path):
    """
    Overlay hand-researched facts on top of what the GIS could work out.

    The automated sources only know what somebody mapped. Plenty of real
    town parks have no trail tagged inside them and come out unverified —
    Clatter Valley in New Milford is 100 acres with hiking trails, a pond
    and a pavilion, and OpenStreetMap knows none of it. A web search
    settles it in seconds, so this puts that research back into the data.

    Returns an audit dict. Research that silently stops applying is the
    real risk here — not the file being deleted, but an upstream rename
    quietly turning an entry into a no-op. So every entry is accounted
    for, and the caller writes the tally somewhere the build can fail on.
    """
    audit = {"entries": 0, "matched": 0, "unmatched": [],
             "rules": 0, "rule_hits": 0, "dead_rules": []}
    if not os.path.exists(path):
        audit["error"] = f"{path} is missing"
        return audit
    try:
        doc = json.load(open(path))
    except Exception as e:                          # noqa: BLE001
        print(f"  verified.json unreadable: {e}", flush=True)
        audit["error"] = str(e)
        return audit
    entries = doc.get("places") or []
    audit["entries"] = len(entries)

    index, by_id, aka_index = {}, {}, {}
    for i, p in enumerate(places):
        index.setdefault((norm(p["name"]), p.get("town")), i)
        index.setdefault((norm(p["name"]), None), i)
        if p.get("id"):
            by_id.setdefault(p["id"], i)
        # Names absorbed during the merge still resolve, so an entry
        # written against the old name keeps working.
        for alt in (p.get("aka") or []):
            aka_index.setdefault(norm(alt), i)

    # Category rules first: one cited regulation can settle hundreds of
    # places. Name-matched entries run afterwards so they can override.
    rules = doc.get("rules") or []
    audit["rules"] = len(rules)
    rule_hits = 0
    for rule in rules:
        m = rule.get("match") or {}
        this_rule = 0
        for p in places:
            if any(p.get(k) != v for k, v in m.items()):
                continue
            this_rule += 1
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
        # A rule matching nothing means the upstream field it keys on has
        # changed shape. The citation is still good; the match is dead.
        if this_rule == 0:
            audit["dead_rules"].append({"id": rule.get("id"), "match": m})
            print(f"  RULE MATCHED NOTHING: {rule.get('id')!r} {m}", flush=True)
    audit["rule_hits"] = rule_hits
    if rule_hits:
        print(f"  {rule_hits:,} places settled by category rule", flush=True)

    hits = 0
    for e in entries:
        m = e.get("match") or {}
        # id first: it's the only key that survives an upstream rename
        # and a dedup merge. Name and coordinate are fallbacks for
        # entries written before ids existed.
        i = by_id.get(m.get("id")) if m.get("id") else None
        if i is None:
            i = index.get((norm(m.get("name", "")), m.get("town")))
        if i is None:
            i = index.get((norm(m.get("name", "")), None))
        if i is None:
            for alt, j in aka_index.items():
                if alt == norm(m.get("name", "")):
                    i = j
                    break
        if i is None and m.get("at"):
            # Name lookup failed. Names change upstream; locations don't.
            # Fall back to the nearest place to the recorded coordinate,
            # which survives a rename, a re-spelling or a town correction.
            alat, alng = m["at"]
            best, bestd = None, ANCHOR_M
            for j, p in enumerate(places):
                d = metres_between(alat, alng, p["lat"], p["lng"])
                if d < bestd:
                    best, bestd = j, d
            if best is not None:
                i = best
                print(f"  {m.get('name')!r} matched by coordinate anchor "
                      f"-> {places[i]['name']!r} ({bestd:.0f} m)", flush=True)
        if i is None:
            audit["unmatched"].append({"name": m.get("name"),
                                       "town": m.get("town")})
            print(f"  RESEARCH LOST — no match for: {m.get('name')!r}",
                  flush=True)
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
    audit["matched"] = hits
    return audit


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

    # Merge duplicates BEFORE research is applied, so a correction lands
    # on the one surviving record instead of one of three copies. This
    # also stamps a stable id on every place, which is what verified.json
    # should bind to — names change upstream, ids don't.
    places, _merged = dedupe(places)

    audit = apply_verified(places, os.path.join(args.data, "verified.json"))
    if audit.get("matched"):
        print(f"  {audit['matched']} places corrected by research", flush=True)

    # Written every run so the workflow can fail loudly when research
    # stops applying. Losing a citation silently is the one failure this
    # pipeline can't detect by looking at the output — the file still
    # looks fine, it's just quietly missing what somebody proved.
    audit["researched_places"] = sum(
        1 for p in places if (p.get("attrs") or {}).get("researched"))
    with open(os.path.join(args.data, "research-audit.json"), "w") as fh:
        json.dump(audit, fh, indent=1)
    if audit.get("unmatched") or audit.get("dead_rules"):
        print(f"  !! {len(audit['unmatched'])} entries and "
              f"{len(audit['dead_rules'])} rules matched nothing", flush=True)

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
