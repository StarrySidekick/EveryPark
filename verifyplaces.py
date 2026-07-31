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

from buildplaces import attach_geometry, verify_all


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    data = json.load(open(args.src))
    places = data["places"]
    print(f"  {len(places):,} places in", flush=True)

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
