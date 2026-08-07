# Start here — EveryPark

Written 2026-08-06, when this project moved from Claude Cowork to Claude Code.

`CLAUDE.md` in the repo root is the engineering memory: architecture,
pipeline, failure modes, conventions. Claude Code reads it automatically.
**This file is the other half** — the decisions, the current state, and
what to do next. Read both before touching anything.

---

## What this is

An interactive map of every publicly accessible outdoor place in
Connecticut. Static site, no server, no database, free to host.

- **Live:** https://everypark.starrysidekick.com
- **Repo:** `StarrySidekick/EveryPark`, GitHub Pages from `main`
- **Now:** `v0.43.0` · deployed dataset still 7,727 places (CT only) until
  the next refresh; the pipeline currently builds CT 9,266 + NY 2,172
- **~2,900 CT places unverified; New York is 100% unverified by design**

**The goal, in Timothy's words:** *find a park near me, verified that it's
a good park, go there and get all the info, a usable map for hiking and
doing various activities there.*

Read against that sentence: **find** works, **trust** is at 63%, **get
there** has just started, **use it there** is beginning. That ordering
decides priority.

---

## Deploying (this changed)

Previous sessions ran in a cloud sandbox whose git proxy refused every
push to this repo, so ten deploys went through the GitHub web uploader
driven by browser automation. That is over. In Claude Code:

```bash
git add -A && git commit && git push
```

Two things that were true then and are still true now:

- **Bump BOTH `siteVersion` in `config.js` and `?v=NN` in `index.html`**
  on every code change. The header badge shows `siteVersion · dataVersion`
  and is the proof a deploy reached the browser. Confirming needs a
  **hard reload** — Pages can serve the old build for a minute.
- **Never pipe `git push` in a success check.** `if git push | sed ...`
  tests *sed's* exit code, always 0, so a rejected push reports success.
  Use `git push ; [ ${PIPESTATUS[0]} -eq 0 ]`.

---

## The five rules (from CLAUDE.md, repeated because they matter)

1. **Never hand-edit `data/places.json`.** Regenerated from scratch.
2. **`data/verified.json` is the only file meant to be hand-edited.**
   Research goes there or it does not survive.
3. **Use `publish.yml`, not `refresh-data.yml`.** 30 seconds vs 65
   minutes and eight external services.
4. **Never push a local `places.json` over the repo's copy.**
5. **A claim without a number is not a result.** Almost every bug in this
   project produced output that looked completely reasonable.

---

## Decisions that should not be re-litigated

- **The ground can never be green.** Green means "verified, you can go."
  A turf-green basemap made verified parks stop reading as parks.
- **Districts are a second class, not widened "public."** Open land is
  ground you may *enter* — access is a real, researchable question. A
  public way is ground you may *pass through* — access was never in
  doubt. Districts carry no access colour, stay out of the parks count,
  out of Random, out of `verified.json`.
- **Cemeteries stay** (purple, filterable).
- **Rules are stated, never inferred.** No recorded hours prints "No
  posted hours recorded", not silence and not an assumption.
- **No emoji anywhere** — code, data, comments, UI.
- **Google review counts are unavailable to this project.** The field
  exists (`userRatingCount`), but Maps Platform terms §14.2 forbid using
  Places content "in conjunction with a non-Google map", and this is
  Leaflet + Protomaps. Caching rules block baking it in. No open dataset
  has an equivalent. Checked 2026-08-05.

---

## Testing — run these before pushing any `iso.js` change

Five Playwright harnesses in `tools/isotest/`. Every invariant in
`VISUALS.md` has been broken at least once by an edit that looked
correct.

| Harness | Guards |
|---|---|
| `check.mjs` | Render invariants — tree stability across motion LOD, brown rim, gap-free smooth mesh |
| `lodbench.mjs` | Motion detail, both branches, via the `__lodBudgetMs` seam |
| `parts.mjs` | Multi-piece split loses no rings; holes drawn, not bitten out |
| `gestures.mjs` | Zoom anchoring, twist, and drag buttons — arithmetically |
| `shotui.mjs` | Chrome layout, by screenshot |

Setup, which the sandbox needed and a real machine mostly won't:

```bash
python3 -m http.server 8123      # serve the REPO ROOT
bash tools/isotest/scratch.sh    # build the offline copy at /tmp/eptest
node tools/isotest/check.mjs
```

`scratch.sh` needs `/tmp/epui/vendor` populated with leaflet and
protomaps-leaflet. On a machine with network, plain `npm pack` works.

Last green: `treeRatio 0.964 · smoothHoles 0 · brownRim 45122`.

---

## Traps that have cost real time

- **`document.hidden` invalidates in-browser measurement.** Chrome
  throttles rAF and deprioritises raster in a background tab. This cost
  two separate investigations: a round of frame timings reporting
  200–320 ms for scenes that render in single digits, and an attempt to
  watch an animation that never ran. The renderer itself now refuses to
  make LOD decisions while hidden.
- **A test of an adaptive system must outlast its warm-up.**
  `lodbench.mjs` passed vacuously twice by hashing a probe frame.
- **`arc()` has no timeout of its own.** Every caller must bound it. A
  hung ArcGIS request used to leave the island bare with nothing saying
  why. Showing progress is what made it findable.
- **Aggregate counts cannot detect "everything moved one cell."** See
  `tools/isotest/flipdiff.mjs`.
- **Serve PMTiles with `tools/mapmock/serve.py`**, not the stock
  `http.server` — it ignores HTTP Range and the map comes up blank.

---

## Where things stand

### Recently shipped (v0.36 → v0.41)

Lore ribbon with live CT DEEP rules and activities · proper naming from
DEEP's `PROPERTY` field · holes drawn as excluded grey · multi-piece
parks with arrows · streaming dressing with raced Overpass mirrors ·
keyed loading mark · bounded fetches · adaptive motion detail at a fixed
20 m block · desktop pan and rotate · two-finger twist · zoom anchored to
the viewer · marks fading during zoom · smaller pixel trees · a real
satellite drape · DEEP access points labelled on the terrain.

### The CT DEEP integration, verified

Two services, live, keyless, CORS-enabled, citable to the agency:

| Check | Result |
|---|---|
| `DEEP_Trails_Set` layer 3 | 13,873 segments, **13,842 Constructed** |
| `DEEP_Property_Access_Locations` layer 0 | **385 points**, ~35 activity flags |
| Sleeping Giant, live | 300 segments, 22 real blazes, access point with official LINK |

Three traps found while integrating, each of which would have printed
confident nonsense:

1. **31 segments statewide are `TRAILSTAT = 'Potential'`** — trails that
   do not exist. Filter them.
2. **The two services use different vocabularies.** Trails are the
   strings `"True"/"False"/"Unknown"`; access points are `"Yes"/"No"`.
   Neither is a boolean, neither is truthy-safe.
3. **A park is rarely unanimous**, because rules are per segment. State
   them *with scope* — "on every marked trail here" vs "on some trails
   here". That difference is the one that gets someone in trouble.

### Known limitation to fix first

**The DEEP trail query is by bounding box, so it over-captures.** At
Sleeping Giant it also pulls in the Farmington Canal Trail passing
nearby, and that name appears under WHAT'S HERE. The activities page is
*not* affected — it joins on `PROPERTY` name match, which is why that one
is trustworthy.

Fix: test each returned segment against the boundary rings rather than
the envelope. **Do this before drawing blazed trail lines**, or the new
feature inherits the same error visually.

---

## New York — added 2026-08-07, half done

The pipeline builds **CT 9,266 + NY 2,172** places today. Read that NY
number as provisional: it comes from the *old* Connecticut bounding box
plus DEC lands. A full `refresh-data.yml` with the widened `REGION_BBOX`
picks up the 13,903 PAD-US NY units and ~8,200 NY OSM parks on top.

**Done and measured:**

- `data/municipalities.geojson` — CT 169 towns + NY 995 towns/cities, the
  region gate and the source of each record's new `state` field
- `NYS_DEC_Lands` fetched and consumed — 3,215 parcels, 2,983 places,
  3.77M NY acres including High Peaks Wilderness at 274,745
- Rules scoped by state, defaulting to CT

**Connecticut was held still throughout, by measurement, not by hope:**
0 towns changed, 0 places lost, still 45% settled, research audit still
52 of 52 with no dead rules.

**Not done:**

1. ~~**NY access rules.**~~ Six landed 2026-08-07 — Forest Preserve, its
   detached parcels, State Forest, WMA, Unique Area, Multiple Use Area —
   scoped `"states": ["NY"]` and settling **1,155 of 2,085 NY places
   (55%)**. Deliberately NOT covered: Tidal Wetland, Special Use,
   Educational, Conservation Easement, Leased Access, Fishing Access and
   Waterway Access. Nothing found supports a public-entry claim for
   those, so they stay amber.

   **What the citations do and do not carry.** DEC publishes no blanket
   "open to the public, free" statement the way CT DEEP does. Its
   rules-for-use page only says "Anyone enjoying State Forests… must
   observe the following rules" — presupposing public use, not granting
   it. Free rests on the structured `Fee: Free` field on each unit's own
   DEC place page. If that reading is ever challenged, these six rules
   are where to look first.

   **Do not cite the per-record `URL` field as a rule source.** 15% of a
   40-URL sample were dead: the layer stores legacy
   `www.dec.ny.gov/outdoor/NNNNN.html` links, most of which 302 three
   times into the new `/places/` scheme and some of which 404. They are
   fine as a place's own link, useless as the evidence a rule rests on.
2. **`app.js` knows nothing about states.** It still fetches the CT-only
   `towns.geojson`, has no state filter, and no NY town boundaries.
3. **Progressive load.** Not the download — `places.json` is 3.97 MB on
   disk but **442 KB over the wire**, so brotli already solved that. The
   cost is *parse*: 42 ms today, **1,406 ms** at 4x, blocking the main
   thread. Render CT immediately and stream NY in after, the same shape as
   the v0.38.0 dressing work.
4. **A real refresh.** Every NY number above is from a partial build.

---

## What to do next, in order

### 1. The ETL batch — the biggest blocked chunk

Everything that adds new *places* rewrites `data/places.json` through the
Actions pipeline. The previous environment had no network to ArcGIS, so
these fetchers could be written but never run. **On a real machine they
can be tested, which is the whole reason to move.**

- ~~**CT DEEP Coastal Access Sites**~~ — DONE 2026-08-06. Not the 350+ new
  places this assumed: 141 of the 357 land on 128 places already in the
  dataset, so it enriches those and adds only 43 that survive the merge.
  The value is fee/restroom/ADA/activity data on places you already have.
- ~~**DEEP boat launches**~~ — already in `fetchsources.py`, 92 trailered
  + 25 cartop = 117, matching the merged DEEP layer exactly.
- **A new access category: permit-required** — free, but you must carry
  one. Aquarion and RWA land is neither "open to all" nor "by
  permission", and the model has no room for it today.
- **Water-company recreation land** — Aquarion, MDC, RWA. ~20 places,
  each with real, unusual rules. The most distinctive content available:
  what a local knows and no app tells you.
- Then the 2023 parcel layer (as a *candidate* generator, not places) and
  the CLCC land-trust directory.

### 2. Blazed trail lines from DEEP

The largest usefulness gain left in the viewer, and the data is *already
being fetched* for the rules. `TRAILMARK` gives the real blaze — Sleeping
Giant alone has 22. A line you can match to the paint on the tree is the
most navigationally useful thing this could show. Also distinguish
`TRAILCLASS` (drawing a sidewalk like a woodland trail is misleading) and
`TRAILSURF` (decides whether a pushchair can go).

Fix the bbox over-capture first.

### 3. Pre-baked terrain

The viewer needs six live services before it draws, plus two more for the
lore. AWS `elevation-tiles-prod` (no key, USGS 3DEP underneath in CT,
explicitly cacheable) makes a CT-only z10–13 pyramid a few tens of
megabytes. Makes the viewer instant *and* is the prerequisite for
anything offline.

### 4. Then adjacency

Compute at build time which places share a boundary, and say so:
*"continues into Higby Mountain Preserve"*. **No other map tells you that
the town park behind the school connects to 400 acres of state forest.**

Also still open: the **context margin** (parks currently end in a cliff),
a scale bar and north arrow (the view rotates freely with nothing to say
which way is north), verification corroboration counts, a
report-a-problem link, and freshness ageing.

---

## Numbers nobody has measured yet

Each decides real work, and none is hard:

- **How many of the 7,727 get a HISTORY page**, and **rules coverage from
  OSM tags.** Together they decide whether the composed fallback text
  deserves more effort.
- **How many places are multi-piece, and how many pieces.** Cockaponset
  is 22. If the median big park is 5+, the arrows are load-bearing rather
  than an edge case.
- **Whether the motion budget ever trips on real hardware**, measured in
  a foreground tab.
- **Which stewards account for the biggest unverified blocks.** Publish
  "the top 20 account for N places" and a 2,900-item queue becomes a
  20-item one.

---

## How Timothy works

Visual, fast-moving, and right about diagnoses more often than not — the
marks-layer slowdown, tree-sprite occlusion, trail-lookalike district
outlines, oversized "boundary increase" districts, the motion-LOD block
doubling, multi-polygon parks, and marks drifting during zoom. Each time
from the behaviour alone, before any investigation. **When he describes a
symptom, look for the mechanism he is describing rather than testing
whether he is right.**

Batches six or seven requests per message, and they are all real. Will
volunteer to cut scope if something sounds expensive — so say plainly
when it is not. Sends "continue" rather than answering clarifying
questions when he wants momentum: ask only when getting it wrong would be
expensive, otherwise pick the sensible reading, state it, and move.

Prefers being shown over being told. Wants honest uncertainty flagged
rather than smoothed over, and measurements rather than claims — *"a
claim without a number is not a result"* is his rule, and it holds.

---

## Also in the claude.ai Project

Longer background that did not need to travel: `gis-primer.md` (a
general GIS primer), `project-assessment.md` (first-principles audit,
2026-08-02), `walkable-places-plan.md` (the full reasoning behind the
districts-as-second-class decision), and `roadmap-brainstorm.md` (the
complete design doc with a sourced appendix of every data source, its
licence, and its CORS status). Copy any of them into `docs/` if you want
them alongside the code.
