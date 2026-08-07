# EveryPark — working notes

An interactive map of every publicly accessible outdoor place in Connecticut
and New York. Free to host, no server, no database.

- **Live:** https://everypark.starrysidekick.com
- **Repo:** `StarrySidekick/EveryPark` (GitHub Pages from `main`)
- **Owner:** Timothy

---

## Read this first

Five rules. Breaking any of them has already cost real work.

1. **Never hand-edit `data/places.json`.** It is regenerated from scratch and
   anything typed into it is destroyed on the next run.
2. **`data/verified.json` is the only file meant to be edited by hand.** It is
   never regenerated. Research goes here or it does not survive.
3. **Use the publish workflow, not the refresh workflow.** Publish is ~30
   seconds. Refresh is ~65 minutes and depends on eight external services all
   cooperating. Refresh is only for picking up genuinely new land.
4. **Never push a local `places.json` over the repo's copy.** This clobbered
   the Action's enriched output once and had to be restored from a commit.
5. **A claim without a number is not a result.** Almost every bug in this
   project produced output that looked completely reasonable.

---

## The park definition

Timothy's words: *"a park can be physically reasonably accessed, is legal to
walk and interact with, and is free to use. if its not free, put them in a
different category for now."*

Three tests, all must pass:

- **Physical** — mapped trail, parking, sports, playground, beach, pool, or an
  explicit `reachable` flag from a cited rule
- **Legal** — not excluded (members-only, tribal reservation, closed in PAD-US)
- **Free** — `feeState` of `free` or `parking`; paid entry is a separate bucket

Anything failing a test renders **amber (unverified)**, never green. Amber is
honest uncertainty, not a defect. Do not make things green by asserting facts
we have not checked — see "Failure modes" below, this has happened.

**Cemeteries stay in the dataset** (Timothy, 2026-08-02): walkable public
green space, purple-coded, filterable off. Settled — don't re-litigate.

---

## Two states

New York was added 2026-08-07. Connecticut behaviour is unchanged and was
held to that by measurement at every step: 0 CT places changed town, 0 CT
places lost, CT still settles at 45%, and the research audit still matches
52 of 52.

**`data/municipalities.geojson` is the region.** 1,164 polygons — CT's 169
towns plus NY's 995 towns and cities. It replaces `towns.geojson` on the
build side (`app.js` still reads the old CT-only file). Three things it
decides:

- **What is in scope.** `REGION_BBOX` in `fetchsources.py` is a rectangle
  that necessarily overhangs New Jersey, Pennsylvania, Massachusetts and
  Vermont; an envelope cannot follow a state line. `Builder.add` drops any
  place landing in no municipality, so the polygons are the real filter.
  Anything added that bypasses `Builder.add` must do its own state check.
- **Which state a place is in.** Records now carry `state`. Without it
  dedupe merges Greenwich CT with Greenwich NY — both exist, 35 miles apart.
- **Which rules may speak for it.** See below.

**NY villages are deliberately excluded.** A village sits *inside* a town,
so both polygons contain the point and a first-match scan returns whichever
is earlier in the file — Lake Placid or North Elba for the same park,
depending on nothing. Towns and cities alone tile the state: across 300
random upstate points, zero returned more than one match.

**Municipality misses snap to the nearest boundary within 3 km.** Town
lines stop at the shore, so islands and boat launches sit outside every
polygon — nine current places including three McKinney refuge island units
and Greenwich Point, seven of them verified parks. Rejecting on containment
alone would have deleted them silently. The snap measures distance to the
nearest *vertex*, not the bounding box: the envelope version sent four
Connecticut places 30 km across Long Island Sound to Southold, whose box
runs the length of the North Fork.

### Rules are scoped by state

`verified.json` rules key on `type` / `subtype` / `agency` — fields that say
nothing about where a place is. Unscoped, `{"type": "state"}` cited to
`portal.ct.gov` settles New York's Forest Preserve, and
`{"agency": "City or town"}` cited to *Leydon v. Greenwich* settles New York
municipal land. Measured before the fix: **a Connecticut citation on 1,712
New York places, making NY read 82% verified against Connecticut's 45%.**

Rules now carry `states`, defaulting to `["CT"]`. Every existing rule
behaves exactly as before. A rule that genuinely travels says so:

```json
"states": ["CT", "NY"]
```

**No NY rules exist yet.** New York settles at 0% and renders amber, which
is honest — nobody has cited New York law. Writing them is real research
(6 NYCRR Part 190, Article XIV of the NY Constitution for Forest Preserve)
and each one turns hundreds of places green, so they get reviewed before
they land.

### NY sources

| Source | What | Count |
|---|---|---|
| `NYS_DEC_Lands` | Forest Preserve, State Forests, WMAs — NY's `DEEP_Property` | 3,232 |
| PAD-US | already national; carries OPRHP state parks | 13,903 NY public+named |
| OSM | already national, now inside `REGION_BBOX` | ~8,200 NY parks |

PAD-US already holds Letchworth (14,416 ac), Bear Mountain (5,477) and
Jones Beach (6,048), so **no separate OPRHP fetcher is needed** — `dedupe()`
handles the parcel fragmentation.

Two `NYS_DEC_Lands` fields look useful and are not. **`PUBLICUSE` is `'Y'`
on all 3,232 rows** — it reads like an access flag and discriminates
nothing, so testing it stamps every parcel public on evidence that does not
exist. It is also a *fourth* vocabulary, after the trails layer's
`"True"/"False"/"Unknown"`, the access points' `"Yes"/"No"` and coastal's
`"YES"/"NO"`. **`MANAGE_BY` is null on all 3,232.**

`Municipal_Parks` (71) and `Town_County_Parks` (17) on the NYS GPO host are
**not** inventories — the `VISIBLE`/`IMAGE_URL`/`TYPEID` schema is ArcGIS
Map Notes, hand-placed story-map annotations. Promising names, no data.

CT-tuned name filters produce NY false positives: `MEMBERS_ONLY` rejects
"Wilmurt Club Road Primitive Area", a DEC Forest Preserve parcel on a road
that happens to contain "Club". Expect more of this shape.

`gisservices.dec.ny.gov` is materially less reliable than CT DEEP — it
answered once then timed out at 60 s. Anything pulled from it needs the
`run_section` degradation path. The layers above are on the GPO host
(`services6.arcgis.com/DZHaqZm9cxOD4CWM`), which has been solid.

---

## Architecture

Static site plus batch ETL. No server, no database, no runtime API calls.

### What the browser loads

| File | Job |
|---|---|
| `index.html` | Skeleton, filter chips, legend, guide |
| `config.js` | All tunable knobs: colours, categories, exclusions, versions |
| `app.js` | The application (~2,600 lines) |
| `vectorlayers.js` | Tile rendering and polygon clicks |
| `styles.css` | Presentation |

### Two rendering systems — important

**Points** come from `places.json` (clustered markers, all filtering and status
logic). **Polygons** come from `everypark.pmtiles` via HTTP range requests.

`setPlaceResolver()` bridges them: click a polygon, look up the place record,
render the real card. **When that lookup fails it falls through to a
tile-attribute card that has been through none of the verification.** That
fallback once rendered an Indian reservation as "You can go here." It now says
"Unverified." If a popup looks visually different from the others, it came
from this path.

### Data files

```
data/places.json          the dataset — GENERATED, never hand-edit
data/verified.json        the knowledge base — HAND-WRITTEN, never generated
data/research-audit.json  proof the knowledge base applied — generated
data/everypark.pmtiles    geometry (~14 MB) — generated
data/baked.json           last refresh's source pull — generated; the
                          per-section fallback when an endpoint is down
```

### Record shape

```json
{ "id": "998bcdd1c1", "name": "Clatter Valley Park", "type": "town",
  "subtype": "Town Open Space", "lat": 41.54224, "lng": -73.38805,
  "acres": 115, "town": "New Milford",
  "agency": "New Milford Parks & Recreation",
  "aka": ["Town Of New Milford (Clatter Valley)", "Clatter Valley"],
  "attrs": { "trails": true, "water": true, "waterType": "lake",
             "elev": 72, "relief": 30, "cover": "mostly wooded",
             "researched": true, "sources": ["..."], "checked": "2026-08-02" },
  "feeState": "free", "status": "park" }
```

`id` is assigned **once** and never recomputed. Research binds to it.
`aka` holds names absorbed during dedup so old references still resolve.

---

## The two workflows

### `publish.yml` — the fast path (use this)

~30 seconds. No network, no rasters, no tiles. Runs `publish.py`, which:
dedupes, applies `verified.json`, re-derives status, bumps `dataVersion`,
commits.

Triggers on manual dispatch **or** any push touching `data/verified.json` —
so editing the knowledge base publishes itself.

### `refresh-data.yml` — the full rebuild (avoid unless needed)

~65 minutes: 13 min fetching 8 services, 25 min elevation and land cover,
25 min tiles. Monthly cron `17 6 1 * *` plus manual dispatch with a
`skip_tiles` option.

Only needed when *sources* change. Correcting a fact about an existing place
needs none of it.

Both share `concurrency: everypark-data` so they can never write to `data/`
at the same time.

### Pipeline stages

```
fetchsources.py   8 services -> raw/          (network, slow, fragile)
buildplaces.py    raw -> places.json          (classify, acreage, exclusions)
dedupe.py         merge same-place records, assign ids
verifyplaces.py   apply verified.json, run the park test
enrichraster.py   USGS 3DEP elevation + NLCD land cover
maketiles.py      MVT encode -> pmtiles (staged: stage/stage/.../pack)
publish.py        the fast path: dedupe + verify + version bump only
```

---

## Adding research

Timothy says a fact; write it into `verified.json`; publish. Two entry types:

**`places`** — one named place. Match on `id` (best), or `name`+`town`, or
`at: [lat, lng]` as a coordinate anchor. Always include an `at` anchor: names
change upstream, locations don't.

**`rules`** — match on `type` / `subtype` / `agency`, so one cited regulation
settles hundreds of places at once. Ten rules currently cover ~3,400 places
(CT state land, WMAs, cemeteries, municipal open space under
*Leydon v. Greenwich*, and named land trusts).

**Every entry requires `source` and `checked`.** A claim without a citation is
a guess, and guesses are what this file exists to replace.

Two verdict flags, the positive and negative of the same research:
`reachable: true` = cited proof the public can walk in free (settles the
physical test without a mapped trail). `private: true` = cited proof a
place is members-only (community beach association, club land) — it fails
the legal test, hides the pin, and the card explains why. Added 2026-08-02
when two Candlewood tax-district beaches turned out to be wrongly green.

Deliberately **not** rule-covered: the generic 246-place "Non-profit / land
trust" bucket. TNC states some preserves are closed to protect at-risk
species, so blanket-asserting access there would be a confident lie.

---

## Failure modes — read before debugging

Every one of these produced output that looked fine.

| What happened | Root cause | Guard now in place |
|---|---|---|
| Elevation 0% coverage | read `sampleId`; API sends `locationId` | — |
| Tiles mirrored per tile | y-flip; **verified with the same broken decoder** | — |
| Every state park vanished | global name filter applied a per-source rule | rules split by scope |
| Acreage wrong twice | parcel-under-centroid, then name-summing across sources | scoped to one layer |
| Research silently stopped applying | bound to name strings | ids + `aka` + anchors + failing audit |
| Research landed on wrong record | 665 locations had duplicate records | `dedupe.py` |
| Publishing twice gave two answers | merging renames records, creating new matches | iterate to fixed point |
| Ids drifted between runs | recomputed after research renamed a place | `setdefault`, assign once |
| Run #4 lost 38 min of work | I pushed to `main` mid-run; push rejected | rebase-and-retry loop |
| Run #5 died at 12 min | one OSM endpoint returned "Invalid query parameters" | per-section guard degrades to last refresh's `data/baked.json`; `::warning::` annotation; fatal only when no fallback exists |
| Preserves named "Non-profit / land trust" | read `officialOwner` (category) before `agency` (name) | precedence fixed |
| Reservation shown as "You can go here" | tile-fallback popup asserted access unconditionally | now "Unverified" |
| Map panning dropped to ~30 fps with 250 ms stalls | 260 divIcon marks destroyed and rebuilt on every `moveend`, over a full 7,727-record scan | marks draw on ONE canvas in `overlayPane` + a 0.02° grid index; **do not put marks back into the DOM** |
| NY read 82% verified against CT's 45%, with no NY rules written | rules key on `type`/`subtype`/`agency`, which say nothing about state; CT law settled 1,712 NY places | `states` on every rule, defaulting to `["CT"]` |
| Four CT places jumped 30 km across Long Island Sound to Southold | offshore snap measured distance to the bounding BOX; Southold's box runs the length of the North Fork | snap measures distance to the nearest boundary vertex |
| Coastal parks described by one access point as if it were the whole park | 141 sites applied one at a time; the last overwrote the first and doubled the citation | grouped per place, applied once, facilities unioned |
| All 357 coastal sites would read as fee-charging | `Fee` is the string `"NO"`, which is truthy | flags collapsed to a list of only the YES ones, at the fetcher |

**The pattern: silent success.** Nothing crashed, files stayed valid, the map
rendered. That is why the research guard *fails the workflow* rather than
logging — a log nobody reads is the same as no check.

### Known open issues

- **Parking coverage ~6%.** OSM has only 687 public parking points statewide;
  that source is exhausted. Would need an NLCD-adjacency heuristic.
- **~2,900 places still unverified**, mostly 641 with no recorded steward and
  246 generic land trusts. The steward tail is flat — no org covers >22.

---

## Deploying

Ordinary git. This project moved to Claude Code on 2026-08-06 and runs on a
real machine with a real credential:

```bash
git pull --rebase
git add -A && git commit -m "..." && git push
```

Pages rebuilds from `main` in a minute or two. `gh` works for triggering
workflows: `gh workflow run publish.yml`.

**Cache busting:** bump `?v=NN` on `styles.css` / `app.js` / `config.js` /
`iso.js` in `index.html` on every code change, **and** `siteVersion` in
`config.js`. The badge in the header corner shows `siteVersion · dataVersion` —
it is the proof a deploy actually reached the browser, and confirming it needs
a **hard reload**, since Pages can serve the previous build for a minute.

**Never pipe `git push` in a success check.** `if git push 2>&1 | sed ...`
tests *sed's* exit code, which is always 0, so a rejected push reports
"pushed" and the work silently stays local. Use `git push ... ; [ ${PIPESTATUS[0]} -eq 0 ]`
or capture to a file and check separately. This masked a real 403 on
2026-08-04.

**If a token is ever used explicitly:** never print it, never commit it, always
scrub `x-access-token:...@` from any output. Editing a fine-grained token's
permissions **invalidates it** — it must be regenerated.

### History, in case old notes turn up

Ten deploys (v0.32 → v0.41) went through the GitHub **web uploader** driven by
browser automation, because the previous cloud sandbox's git proxy refused
every push with *"access denied by the git proxy … not in this session's
authorized repository set"*. That was never a token problem — the proxy
declined to inject a credential at all, and no token in a URL changed it.
None of that applies now. If you find instructions about `github_token.txt`,
`x-access-token@` clone URLs, or clicking Commit by screen coordinates, they
are obsolete.

**See also `docs/START-HERE.md`** — current state, decisions already settled,
what to build next, and the traps that have cost real time.

---

## 3D viewer (iso.js)

Its intended appearance is pinned down in `tools/isotest/VISUALS.md` —
tree field stable across motion LOD, continuous brown rim, no wall
strokes, gap-free smooth mesh mid-spin. **Run `tools/isotest/check.mjs`
(offline Playwright harness, no network) before pushing any `iso.js`
change**: every invariant in that file has been broken at least once by
an edit that looked correct. `tools/isotest/shotui.mjs` is the companion
for the *chrome* — it drives the lore ribbon through its pages and opens
the terrain menu, so layout collisions show up in a screenshot.

### The lore ribbon (v0.37.0)

Game-dialogue text across the top of the stage, revealed letter by
letter. Three sources, merged in this order:

1. **OpenStreetMap tags** on the park's own polygon — the only live
   source for RULES (hours, dogs, fee), and the only *reliable* way to
   find the right Wikipedia article, since its `wikipedia`/`wikidata`
   tag is an editor's assertion rather than our guess.
2. **Wikipedia** REST summary — history, trimmed to three sentences.
3. **The record we already hold** — always available, so the panel is
   never empty. Most of the 7,727 places will only ever get this one.

Nothing is baked; baking 7,727 summaries by hand does not finish.

**The gates exist because a wrong article is worse than none.** "Memorial
Park" matches a hundred articles nationwide. A match that did NOT come
from an OSM tag must clear both a name gate (token overlap ≥ 0.5, after
dropping the words every park name contains) and a distance gate (≤ 4 km,
and it must be geotagged at all). Do not relax these to raise coverage —
coverage is what the composed fallback is for.

**Rules are stated, never inferred.** No recorded hours prints "No posted
hours recorded", not silence and not an assumption. Asserting access we
have not checked is the exact bug that once rendered a reservation as
"You can go here."

**Lore queries queue behind the dressing fetch** (`dressingReady`). Two
simultaneous Overpass calls is how you get rate-limited, and a throttled
Overpass once silently cost every road on the island.

### Motion detail (v0.37.1)

A block is **20 m by default**, rotating or not. It was 10 m, and the
renderer dropped to a doubled grid step plus 0.7 resolution the instant
the view moved — visible as the blocks growing while you drag and
snapping back on release.

The coarse step could not simply be deleted: full detail costs ~1.7-2.6x
the coarse step (measured both in the harness and live), and cost scales
with column count — a 48-cell grid renders in a few ms where a 176-cell
grid is tens. So instead, **every motion burst starts at full detail,
that frame is timed, and the viewer only coarsens for the rest of the
burst if it blew `LOD_BUDGET_MS` (22 ms).** Resolution follows the same
decision, so there is never a frame that is sharp but chunky. On hardware
that keeps up, motion is byte-identical to rest.

Two guards on that decision, both put there by evidence rather than
caution:

- **A hidden tab is not evidence.** Chrome throttles rAF and
  deprioritises raster when `document.hidden`, and a backgrounded tab
  reported 200-320 ms frames for scenes that render in single-digit ms —
  enough to latch the coarse step forever on a machine that never needed
  it. The renderer skips the decision entirely while hidden.
- **Two consecutive over-budget frames, not one.** A single slow frame is
  as likely to be a GC pause or a texture decode as a real inability to
  keep up.

**Do not try to pin absolute frame times from this sandbox** — its
browser has no GPU. And check `document.hidden` in any in-browser
benchmark; a whole round of measurements here was wrong because of it,
and looked entirely plausible while being wrong.

`tools/isotest/lodbench.mjs` asserts BOTH branches via the
`window.__lodBudgetMs` test seam: unlimited budget → the moving frame
must hash identical to the settled one; zero budget → it must differ.
A one-frame version of that test passed vacuously, because the first
moving frame is the probe and renders at full detail by design.

Two limits the 20 m default cannot beat, both reported honestly by the
slider label rather than hidden: the grid floors at 48 a side, so a very
small park lands near 10 m; and it clamps at 176, so a big forest lands
coarser than 20.

### Streaming and the loading mark (v0.38.0)

The five dressing sources already ran concurrently, but the caller
awaited **all** of them, so the island stayed bare until the slowest
answered — usually Overpass, the least important of the five. Now each
source fills its slice of one shared `raw` object and repaints as it
lands, so trails appear when trails arrive. `raw` is mutated in place
because the block-size slider's rebuild reads it later.

Overpass mirrors are **raced**, not tried in turn. Sequentially, a
rate-limited first endpoint cost its entire 12 s timeout before the
second was attempted. `Promise.any` over all three, with an inverted
`Promise.race` fallback for browsers without it.

A small spinner beside the time-of-day button says more is still coming.
It is keyed (`loading(key, on)`) because six things load at once and the
last to finish owns when it disappears — the difference between "there
are no trails here" and "the trails have not arrived yet".

The loader itself is absolutely centred over the stage and the canvas
keeps its box while merely `visibility: hidden`. It used to be a block
with a fixed 120px margin inserted before a `display: none` canvas, so
the stage collapsed to the spinner's size, the corner controls landed on
top of it, and the panel jumped when terrain appeared.

### Separate pieces of one place (v0.38.0)

A place is often several polygons that do not touch — a state forest in
five blocks. Drawn together they share one bounding box, so the grid
spans the gaps and each real piece is a pinhead in an ocean of nothing.
`splitParts()` groups rings and the viewer shows one at a time, with
arrows on the flanks.

- **Grouping is by bounding-box containment, not winding order.** ArcGIS
  marks holes by reversing the ring, but these sources disagree about
  that often enough that trusting it drops real land.
- **Slivers under 3% of the largest piece are merged into the nearest
  one, never dropped.** Losing mapped land is the failure mode nothing
  else in the app would report.
- Stepping between pieces reopens the viewer with `p.rings` already set,
  so the boundary is never refetched.

`tools/isotest/parts.mjs` asserts the split, the wrap in both directions,
that single-polygon places grow no arrows, and that all rings survive.

### The lore ribbon opens on request only

Hidden until the bottom-right button is pressed, and pressing it
**resumes** rather than restarts — the reveal used to replay from the
first letter, so a glance away cost you your place. The button only ever
opens; the × on the ribbon is the only thing that closes it.

### Gestures and the marks canvas (v0.39.0)

**Marks are hidden for the length of a zoom animation.** They are drawn
at layer points onto a canvas in `overlayPane`, and Leaflet animates a
zoom by putting a CSS scale on that pane — correct for geographic vector
shapes, wrong for fixed-size point icons, which swell and drift off their
polygons before `zoomend` repaints. Counter-transforming does not help;
the marks would still sit at the old zoom's positions. Redrawing every
animation frame would need intermediate state Leaflet does not expose.
So: fade out during the flight (`.ep-mark-zooming`).

**3D zoom anchors on the viewer's middle, not the island's origin.** The
scene projects around `(W/2 + panX, Hh*0.60 + panY)`, so scaling alone
made a panned island walk out of frame. Holding the projection's base
point still works out to scaling the pan by the same factor — and by the
factor **actually applied**, not the one requested, or the pan keeps
growing after the zoom clamps at 9 and the island crawls.

**Two fingers pinch, pan and twist.** The twist sign matches the
one-finger touch convention: the island follows the hand. The ±pi seam is
handled explicitly, or one frame spins it most of a full turn.

`tools/isotest/gestures.mjs` asserts all of this arithmetically — a
30-degree twist must move the target 30 degrees in the right direction,
pan must track zoom exactly across a scroll round trip and through the
clamp, and the seam must not fling. These are sign-and-algebra bugs that
look fine in a screenshot and are wrong the moment you touch them.

### Viewer chrome layout

Four corners, all 38px icons: time of day (TL), season (TR), terrain menu
+ turntable (BL), read-again + save (BR). The footer keeps only Random
and Close. The elevation readout on the canvas is bottom-**centre**: it
was bottom-left until the BL icons covered it, and centring is dpr-proof
where a fixed offset is not (icons are laid out in CSS pixels, that text
in device pixels).

`check.mjs` clicks `.iso-spin-btn` with a real Playwright click, so that
button must stay **visible**, and it finds the smooth toggle by
`.iso-tool` with textContent exactly `Smooth` — which still works from
inside the closed menu only because it clicks via `evaluate`.

## Conventions

- Comments explain **why**, not what — especially the non-obvious constraint
  that forced a decision. Several comments here record bugs that took hours.
- No emoji in code, data, comments or UI. Card glyphs come from `FEAT_SVG` /
  `VERDICT_SVG` in `app.js`; the viewer draws its own. Emoji render
  differently per platform and carry their own colour.
- Prefer editing `config.js` over code for anything visual.
- British-ish spelling in prose is fine; identifiers stay US.

## Wanted next

- Isometric 3D park view on zoom, elevation mapped onto the polygon,
  "like a video game" (elevation is already stored — the prerequisite is done)
- Timothy's own graphics and UI
