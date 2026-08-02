#!/usr/bin/env python3
"""
List the places most worth researching by hand, biggest first.

The automated sources leave ~4,400 places unverified, almost all for the
same reason: nothing is mapped inside them. But a large, named, town-owned
open space is very likely a real park — the data just doesn't know it. This
ranks those so the manual pass starts where it pays off most.

    python3 researchqueue.py --in data/places.json -n 40
"""

import argparse
import json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default="data/places.json")
    ap.add_argument("-n", type=int, default=40)
    ap.add_argument("--town", help="only this town")
    args = ap.parse_args()

    places = json.load(open(args.src))["places"]
    q = [p for p in places
         if p.get("status") == "unverified"
         and (p.get("acres") or 0) >= 5
         and not (p.get("attrs") or {}).get("researched")]
    if args.town:
        q = [p for p in q if (p.get("town") or "").lower() == args.town.lower()]

    # Bigger and better-named first: a 90-acre "... Park" is a safer bet
    # than a two-acre easement with a surname for a name.
    def score(p):
        s = float(p.get("acres") or 0)
        nm = p["name"].lower()
        if any(w in nm for w in ("park", "preserve", "forest", "green",
                                 "conservation", "open space", "trail")):
            s *= 2.0
        return s

    q.sort(key=score, reverse=True)
    print(f"{len(q):,} unverified places over 5 acres. Top {args.n}:\n")
    print(f"{'acres':>7}  {'town':16} name")
    for p in q[:args.n]:
        print(f"{round(p.get('acres') or 0):>7}  {(p.get('town') or '?')[:16]:16} {p['name'][:52]}")


if __name__ == "__main__":
    main()
