#!/usr/bin/env python3
"""
Give every place a stable identity, then merge the records that describe
the same ground.

Why this exists
---------------
Eight sources each name the same piece of land differently. DEEP calls it
"Weir Farm State Park", PAD-US calls it "Weir Farm", OpenStreetMap has a
third spelling. Nothing reconciled them, so one park became three records
sitting on the same coordinates, and 665 locations statewide carried two
or more differently-named entries.

That is not just cosmetic. Research in verified.json binds by *name*, so
a correction lands on whichever record happens to match and the other two
stay yellow — which is exactly what happened to Clatter Valley. Roughly
one correction in eight was attaching to a record nobody clicks.

The fix is two things:

  1. A stable `id` per place, derived from where it is and what it's
     called at its core. Research binds to the id, so a source
     re-spelling a name no longer breaks the link.

  2. A merge pass that combines records by *geography plus name
     relatedness*, not by exact string.

What it will not do
-------------------
Merge on proximity alone. Quaddick State Park and Thompson Poor Farm
Cemetery share a centroid to three decimals and are entirely different
places; a cemetery inside a state forest is normal. Names must actually
be related before anything is combined, and a type mismatch blocks the
merge outright. When two records disagree on a fact, the one carrying
more evidence wins rather than whichever happened to sort first.
"""

import hashlib
import math
import re

# Words that carry no identity — they're what the sources disagree about.
# "Weir Farm" vs "Weir Farm State Park" is one place; the difference is
# entirely in this list.
FILLER = {
    "park", "parks", "state", "town", "city", "of", "the", "at", "area",
    "areas", "preserve", "preserves", "reserve", "open", "space", "land",
    "lands", "trust", "conservation", "forest", "recreation", "scenic",
    "memorial", "historic", "historical", "management", "wildlife",
    "nature", "center", "and", "a", "property", "properties", "parcel",
    "public", "natural", "site", "reservation", "sanctuary", "green",
    "commons", "common", "inc", "llc", "wma", "field", "fields",
}

# Merging across these is always wrong even when names look alike.
INCOMPATIBLE = {("cemetery", "state"), ("cemetery", "town"),
                ("cemetery", "preserve"), ("cemetery", "national")}

MERGE_M = 400.0          # how close two centroids must be to be considered
NEAR_M = 1200.0          # generous limit when one polygon clearly contains
                         # the other's pin and names match strongly


def norm_tokens(name):
    """The identity-bearing words of a name, lowercased and sorted."""
    words = re.findall(r"[a-z0-9]+", (name or "").lower())
    core = [w for w in words if w not in FILLER and len(w) > 1]
    return set(core or words)


def core_key(name):
    return " ".join(sorted(norm_tokens(name)))


def place_id(name, lat, lng):
    """
    Deterministic id: identity words plus location to ~1 km.

    Coarse rounding on purpose. A boundary being redrawn moves a centroid
    by tens or hundreds of metres, and the id has to survive that or the
    research bound to it detaches — which is the bug this whole module
    exists to stop.
    """
    seed = f"{core_key(name)}|{round(lat, 2)}|{round(lng, 2)}"
    return hashlib.sha1(seed.encode()).hexdigest()[:10]


def metres(lat1, lng1, lat2, lng2):
    k = math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lat1 - lat2) * 111320.0, (lng1 - lng2) * 111320.0 * k)


def related(a, b):
    """
    Are these two names describing the same place?

    One name's identity words containing the other's is the common case:
    {weir, farm} vs {weir, farm}. Partial overlap has to be strong — a
    single shared word like "hollow" or "brook" is not enough, because
    Connecticut has dozens of each.
    """
    ta, tb = norm_tokens(a), norm_tokens(b)
    if not ta or not tb:
        return False
    if ta == tb or ta <= tb or tb <= ta:
        return True
    shared = ta & tb
    if not shared:
        return False
    # Jaccard, but require at least two shared identity words so that
    # "Bigelow Hollow" and "Nipmuck Hollow" never collapse together.
    return len(shared) >= 2 and len(shared) / len(ta | tb) >= 0.6


# Things that live *inside* a place. A record named after one of these
# describes a facility, not the property, so it should never end up as
# the name of the merged place when a property name is available.
SUBFEATURE = re.compile(
    r"\b(boat launch|launch|trailhead|trail head|parking|access|landing|"
    r"pier|dock|ramp|entrance|picnic area|campground|overlook)\b", re.I)

# A bare parcel reference is worse than any real name.
PARCEL_ISH = re.compile(r"\b(parcel|lot|tract|property|acquisition)\b", re.I)


def better_name(cand, cur, cand_acres=0, cur_acres=0):
    """Should `cand` replace `cur` as the merged place's name?"""
    if not cand:
        return False
    if not cur:
        return True
    cs, us = bool(SUBFEATURE.search(cand)), bool(SUBFEATURE.search(cur))
    if cs != us:
        return us                    # whichever is NOT a sub-feature wins
    cp, up = bool(PARCEL_ISH.search(cand)), bool(PARCEL_ISH.search(cur))
    if cp != up:
        return up
    # Name the containing property, not the piece inside it. Hammonasset
    # Natural Area Preserve sits within Hammonasset Beach State Park, and
    # going by name length alone renamed the park after the preserve.
    # Whichever record covers more ground is the one people mean.
    if cand_acres and cur_acres and abs(cand_acres - cur_acres) > 1:
        return cand_acres > cur_acres
    # Tie on size: prefer the more specific name, usually the longer one —
    # "Fort Griswold Battlefield State Park" over "Fort Griswold".
    return len(cand) > len(cur)


def evidence(p):
    """How much this record actually knows. Used to pick a winner."""
    A = p.get("attrs") or {}
    score = sum(1 for k in ("trails", "parking", "water", "sports",
                            "playground", "historic", "beach", "pool",
                            "dogpark", "reachable") if A.get(k))
    if A.get("researched"):
        score += 20            # human research outranks everything
    if A.get("shaped"):
        score += 3             # has a real boundary
    if p.get("agency"):
        score += 2
    if p.get("acres"):
        score += 1
    return score


def merge_into(keep, drop):
    """
    Fold `drop` into `keep`, preferring whichever value is actually known.

    Facts are unioned rather than overwritten: if one source found trails
    and another didn't look, the park has trails. Acreage takes the
    larger, because the small value is nearly always one parcel of a
    property the other source has whole.
    """
    A, B = keep.setdefault("attrs", {}), drop.get("attrs") or {}
    for k, v in B.items():
        if k not in A or A[k] in (None, False, "", 0):
            A[k] = v
    for k in ("agency", "url", "town", "subtype", "fee", "note"):
        if not keep.get(k) and drop.get(k):
            keep[k] = drop[k]
    keep_acres, drop_acres = keep.get("acres") or 0, drop.get("acres") or 0
    if drop_acres > keep_acres:
        keep["acres"] = drop["acres"]
    # Name the whole place, not one facility inside it. Picking the longer
    # string turned "Lake Waramaug State Park" into "Waramaug Lake Boat
    # Launch" — the launch is a thing *in* the park, and naming the park
    # after it buries the park. A sub-feature name only wins if the other
    # side has none, and otherwise the bigger, better-evidenced record
    # keeps its own name.
    if better_name(drop.get("name"), keep.get("name"), drop_acres, keep_acres):
        keep["name"] = drop["name"]
    keep.setdefault("aka", [])
    for n in [drop.get("name")] + (drop.get("aka") or []):
        if n and n != keep["name"] and n not in keep["aka"]:
            keep["aka"].append(n)


def dedupe(places, verbose=True):
    """Merge same-place records. Returns (kept, merged_count)."""
    # Bucket by a coarse grid so this stays linear rather than comparing
    # 8,771 records against each other.
    grid = {}
    for i, p in enumerate(places):
        cell = (round(p["lat"], 2), round(p["lng"], 2))
        # Registered into a 5x5 neighbourhood (~2.2 km) because the merge
        # budget below can stretch that far for large properties.
        for dy in (-0.02, -0.01, 0, 0.01, 0.02):
            for dx in (-0.02, -0.01, 0, 0.01, 0.02):
                grid.setdefault((round(cell[0] + dy, 2),
                                 round(cell[1] + dx, 2)), []).append(i)

    gone = set()
    merged = 0
    examples = []
    for i, p in enumerate(places):
        if i in gone:
            continue
        cell = (round(p["lat"], 2), round(p["lng"], 2))
        for j in sorted(set(grid.get(cell, []))):
            if j <= i or j in gone:
                continue
            q = places[j]
            ti, tj = p.get("type"), q.get("type")
            if (ti, tj) in INCOMPATIBLE or (tj, ti) in INCOMPATIBLE:
                continue
            if not related(p.get("name"), q.get("name")):
                continue
            d = metres(p["lat"], p["lng"], q["lat"], q["lng"])
            # How far apart two centroids may sit and still be one place
            # depends on how big the place is. Two parcels of a 600-acre
            # forest have centroids hundreds of metres apart by geometry
            # alone; two 3-acre greens that far apart are separate. So
            # the budget grows with the larger property's radius.
            big = max(p.get("acres") or 0, q.get("acres") or 0)
            allow = MERGE_M + min(1800.0, math.sqrt(big * 4047 / math.pi))
            tp, tq = norm_tokens(p.get("name")), norm_tokens(q.get("name"))
            if tp <= tq or tq <= tp:
                # One name fully contains the other's identity words —
                # "Clatter Valley" inside "Town Of New Milford (Clatter
                # Valley)". That's a strong signal, so allow more slack.
                allow = max(allow, NEAR_M)
            if d > allow:
                continue
            keep, drop = (p, q) if evidence(p) >= evidence(q) else (q, p)
            merge_into(keep, drop)
            if keep is q:            # winner sits at j; carry it to i
                places[i] = q
                p = q
            gone.add(j)
            merged += 1
            if len(examples) < 8:
                examples.append(f"{drop.get('name')!r} -> {keep.get('name')!r}")

    kept = [p for i, p in enumerate(places) if i not in gone]
    for p in kept:
        p["id"] = place_id(p["name"], p["lat"], p["lng"])

    if verbose:
        print(f"  merged {merged:,} duplicate records, {len(kept):,} places remain",
              flush=True)
        for e in examples:
            print(f"    {e}", flush=True)
        ids = {p["id"] for p in kept}
        if len(ids) != len(kept):
            print(f"    !! {len(kept)-len(ids)} id collisions", flush=True)
    return kept, merged
