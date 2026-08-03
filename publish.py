#!/usr/bin/env python3
"""
Apply the knowledge base to the existing dataset. Seconds, not an hour.

Why this exists
---------------
The monthly refresh takes about 65 minutes, and almost all of it is work
that only matters when the *sources* change: 13 minutes pulling eight
services, 25 minutes sampling elevation and land cover, 25 minutes
encoding tiles.

Correcting a fact about a park needs none of that. The boundary hasn't
moved, the elevation hasn't changed, the geometry is identical. All that
changed is something we now know about a place that already exists.

So this reads the dataset that's already committed, re-applies
verified.json over it, re-derives status, and writes it back. No network
calls, no rasters, no tiles.

    python3 publish.py --data data

Run it as often as you like. The full refresh stays for picking up land
that genuinely is new.
"""

import argparse
import json
import os
import sys

from buildplaces import verify_all, norm
from dedupe import dedupe
from verifyplaces import apply_verified


def merge_additions(places, data_dir):
    """
    Fold hand-added places (data/additions.json) into the dataset.

    Creating a place needs no network, no rasters and no tiles, so it
    belongs on the fast path — before this, a hand-added place waited up
    to a month for the full refresh to exist at all. The refresh still
    merges additions itself; when it does, dedupe finds this record
    already here (same name, same spot, same deterministic id) and the
    two collapse into one. What the fast path canNOT provide is a
    boundary (`shaped`) or elevation — those still arrive with the next
    full refresh, so a place added here may honestly sit amber with
    "no mapped boundary" until then.
    """
    path = os.path.join(data_dir, "additions.json")
    if not os.path.exists(path):
        return 0
    try:
        doc = json.load(open(path))
    except Exception as e:                          # noqa: BLE001
        print(f"  additions.json unreadable: {e}", flush=True)
        return 0
    have = {(norm(p["name"]), p.get("town")) for p in places}
    added = 0
    for a in doc.get("places") or []:
        if (norm(a["n"]), a.get("town")) in have:
            continue
        attrs = {"trails": bool(a.get("trails")), "parking": bool(a.get("parking")),
                 "manual": True}
        if a.get("source"):
            attrs["researched"] = True
            attrs["sources"] = a["source"]
        if a.get("checked"):
            attrs["checked"] = a["checked"]
        rec = {"name": a["n"], "type": a.get("type", "preserve"),
               "subtype": a.get("t"), "lat": a["lat"], "lng": a["lng"],
               "town": a.get("town"), "attrs": attrs}
        for src_k, dst_k in (("a", "acres"), ("url", "url"), ("fee", "fee"),
                             ("agency", "agency"), ("note", "note")):
            if a.get(src_k) is not None:
                rec[dst_k] = a[src_k]
        places.append(rec)
        added += 1
        print(f"  + hand-added place: {a['n']} ({a.get('town')})", flush=True)
    return added

# Rebuilt in the browser from the source facts, so they don't belong in
# the file. Same list verifyplaces strips — kept in sync deliberately.
DROP = ("access", "accessLabel", "accessWhy", "steward", "kind", "statusWhy")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--in", dest="src", default=None)
    ap.add_argument("-o", "--out", default=None)
    args = ap.parse_args()

    src = args.src or os.path.join(args.data, "places.json")
    out = args.out or src

    doc = json.load(open(src))
    places = doc["places"]
    print(f"  {len(places):,} places loaded", flush=True)

    before = sum(1 for p in places if p.get("status") == "park")

    merge_additions(places, args.data)

    # Dedup needs no network and no rasters — it works purely on the
    # records in hand, so it belongs on the fast path. Idempotent: once
    # the duplicates are merged, later runs find nothing to do.
    # It also stamps ids on anything merge_additions just appended.
    places, merged = dedupe(places)

    audit = apply_verified(places, os.path.join(args.data, "verified.json"))
    audit["researched_places"] = sum(
        1 for p in places if (p.get("attrs") or {}).get("researched"))
    with open(os.path.join(args.data, "research-audit.json"), "w") as fh:
        json.dump(audit, fh, indent=1)

    # Re-derive the park test from the updated facts, then strip the
    # derived fields back out so the file stays source-facts-only.
    verify_all(places)
    for p in places:
        for k in DROP:
            p.pop(k, None)
        a = p.get("attrs") or {}
        for k in ("accessNote", "visitable"):
            a.pop(k, None)

    after = sum(1 for p in places if p.get("status") == "park")
    print(f"  verified parks: {before:,} -> {after:,} ({after-before:+,})",
          flush=True)
    print(f"  research applied to {audit['matched']} named places, "
          f"{audit['rule_hits']:,} by rule", flush=True)

    with open(out, "w") as fh:
        json.dump({"built": doc.get("built"), "places": places}, fh,
                  separators=(",", ":"))
    print(f"  -> {out} ({os.path.getsize(out)/1024/1024:.2f} MB)", flush=True)

    # Bump dataVersion, or browsers keep serving the copy they already
    # have and the publish is invisible. The badge reads this too, so a
    # stale date in the corner is the tell that this step didn't run.
    if os.path.exists("config.js"):
        import re
        import time
        s = open("config.js").read()
        stamp = time.strftime("%Y%m%d")
        s2 = re.sub(r'dataVersion:\s*"[^"]*"', f'dataVersion: "{stamp}"',
                    s, count=1)
        if s2 != s:
            open("config.js", "w").write(s2)
            print(f"  dataVersion -> {stamp}", flush=True)

    # Keep the README's headline honest. A stale count in the README has
    # already misled a session into wrong conclusions about the dataset —
    # generated numbers belong to the pipeline, not to hand-editing.
    if os.path.exists("README.md"):
        import re
        import time
        s = open("README.md").read()
        line = (f"*{len(places):,} places · updated "
                f"{time.strftime('%B %-d, %Y')}*")
        s2 = re.sub(r"\*[\d,]+ places · updated [^*]+\*", line, s, count=1)
        if s2 != s:
            open("README.md", "w").write(s2)
            print(f"  README -> {line}", flush=True)

    # Same guard as the full refresh: research that stops applying is
    # invisible in the output, so it has to fail loudly here too.
    lost = audit.get("unmatched") or []
    dead = audit.get("dead_rules") or []
    for u in lost:
        print(f"::error::Research LOST — nothing matches {u['name']!r}")
    for r in dead:
        print(f"::error::Rule {r['id']!r} matched nothing: {r['match']}")
    return 1 if (lost or dead or audit.get("error")) else 0


if __name__ == "__main__":
    sys.exit(main())
