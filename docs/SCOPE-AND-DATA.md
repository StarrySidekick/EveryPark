# Scope and data confidence — an assessment

Written 2026-08-24, answering four questions Timothy raised: whether the
data can be trusted, whether the 3D goal survives contact with the data,
whether this can go national, and what to do about obscure town and trust
land.

Every number here was measured against `data/places.json` as committed at
`ae755e6`. Nothing is estimated except where it says so.

**Headline: the dataset is much bigger than the notes say.** `CLAUDE.md`
and `START-HERE.md` both describe 7,727 places. There are **24,805** —
CT 8,016 and NY 16,789. Those two docs need updating; every percentage
either of them quotes is now wrong.

---

## 1. Can the data be trusted?

Partly, and the map cannot currently tell you which part.

15,897 places render green. Sorted by what the green actually rests on:

| Evidence behind a green pin | Count | Share |
|---|---:|---:|
| Cited research in `verified.json` | 4,762 | 30% |
| PAD-US `Pub_Access = Open Access` | 7,007 | 44% |
| Inferred from a mapped feature only | 4,128 | 26% |

The third tier is a pin that is green because a source drew a soccer
field, a playground or a trail inside it. No one has asserted that the
public may enter, and nothing was cited. That inference is usually right
and is not a bad default — but it is an inference, and the map presents
it in exactly the same green as a CT DEEP regulation.

**The failure mode already in the table is recurring through a different
field.** `CLAUDE.md` records that NY once read 82% verified against CT's
45% because unscoped CT rules settled 1,712 NY places. `states` fixed
that for rules. But split the current green by state:

| | Cited research | PAD-US rating | Inferred |
|---|---:|---:|---:|
| CT | 61% | 11% | 28% |
| NY | 12% | 63% | 25% |

New York reads 60% verified against Connecticut's 72% — close enough to
look like the same quality of dataset. It is not. Connecticut's green is
mostly research; New York's green is mostly one column of a national
aggregate that nobody on this project has audited. The colour is
identical and the footing is not.

That is the same shape of bug as the one already fixed: a number that
looks reasonable, produced by evidence that does not say what the display
implies.

### Two structural gaps underneath it

- **There is no per-record provenance.** `attrs` carries `fromPadus` and,
  for researched places, `sources`. Nothing else records which of the
  eight fetchers contributed a record or a field. When a place is wrong
  there is no way to ask which source made it wrong, and no way to
  measure a source's error rate.
- **Status is binary where evidence is tiered.** `park` / `unverified`
  cannot express "cited regulation" versus "PAD-US says so" versus "there
  is a ballfield here". Amber was designed as honest uncertainty; the
  problem is that green is now doing three different jobs.

### How bad is the inference, really?

A name-pattern test over the 11,135 uncited green places flags 3.0% as
looking like a school, club, church, campus or housing authority — 331
places. That is a floor, not an estimate: most false positives will not
announce themselves in the name. The honest statement is that the error
rate of tier 3 is **unmeasured**, and measuring it needs a hand-checked
random sample, which is a half-day of work and has never been done.

---

## 2. Does the 3D goal survive the data problem?

Better than expected. The geometry half is essentially finished:

| Prerequisite | Coverage |
|---|---:|
| Boundary polygon (`shaped`) | 24,747 / 24,805 — **100%** |
| Elevation (`elev`) | 24,805 — **100%** |
| Land cover (`cover`, `openPct`) | 24,664 — **99%** |
| Relief (`relief`) | 12,178 — **49%** |

Only 58 places in the whole dataset are point-only and therefore cannot
be drawn at all. **The "go there and explore it in 3D" goal is not
data-blocked.** It is blocked by the viewer needing six live services
before it draws — which is already item 3 in `START-HERE.md` as pre-baked
terrain — and by `relief` being half-populated, which is a rerun of
`enrichraster.py`, not a research problem.

What *is* shared with problem 1 is the **content** half. The lore ribbon
falls back to the record we already hold, and for an obscure town parcel
that record is a name, an acreage and a cover class. So the 3D experience
is strong for the places that already have research and thin for exactly
the places section 4 is about. That is one problem, not two.

---

## 3. Can this go national?

Not on this architecture, and the ceiling is closer than it looks.

Places per 1,000 sq mi: **CT 1,446, NY 308**. Extrapolated to the
3.53M sq mi of the lower 48:

| Basis | Projected US places |
|---|---:|
| NY rate (mixed urban and wilderness) | ~1,090,000 |
| Area-weighted CT+NY blend | ~1,460,000 |
| CT rate (dense Northeast) | ~5,100,000 |

Against that, the current numbers:

- `places.json` is **11.9 MB** for two states, 480 bytes per record. At
  one million places that is **457 MB**, parsed on the main thread. The
  parse cost was already flagged as the real constraint (1,406 ms at 4x)
  when the file was 4 MB.
- `everypark.pmtiles` is **93 MB** for two states, already past GitHub's
  100 MiB per-file limit and already moved to object storage.
- `refresh-data.yml` runs at **`timeout-minutes: 350`** against GitHub's
  360-minute hard ceiling. For two states. There is no headroom left at
  all — the notes already say "360 is a wall, not a setting".

**Three states does not fit.** Not eventually, not with tuning — the
refresh job has under 3% of its budget remaining.

### The part that does scale, and the part that doesn't

Rules scale well. 20 rules settle 4,822 places, ~241 each, and the unit
of research is a *regulation*, not a place. Federal land is one rule set
for the whole country. Each state's land agency is roughly six rules —
that was exactly the NY shape. So ~50 states x ~8 rules plus federal is
in the low hundreds of rules for the classes that have a governing
agency. That is years of work but it is finite and it compounds.

The municipal and land-trust tail does not scale, and section 4 is about
why.

### Recommendation: the Northeast, not the nation

Do not choose between "two states carefully" and "fifty states". The
cheapest real expansion is already sitting in the raw data.

Commit `ae755e6` found **800 places physically inside states we do not
map** — NJ 412, MA 165, RI 103, VT 73, PA 47 — pulled in by
`REGION_BBOX` and then rejected. Those places are *already fetched*.
Turning a neighbouring state on costs a wider bbox and a handful of
rules, not a new pipeline.

That makes RI, MA, VT, NJ and PA the natural next step, and it is the
right test: **eight states is enough to force the sharding architecture
that fifty states would need, while still being recoverable if it goes
wrong.** Specifically it forces:

- per-state `places-XX.json` shards with a spatial index, so the browser
  parses the state you are looking at
- the refresh split into one job per state, which turns a 350-minute job
  bumping a hard ceiling into fifty 7-minute jobs that can fail
  independently
- provenance per record, because with eight source states you can no
  longer hold in your head which fetcher produced what

Decide that fork deliberately now. Discovering it at state six, mid-run,
against a 360-minute wall, is how 38 minutes of work got lost once
already.

---

## 4. The obscure tail — town land, easements, trusts

This is the most valuable content in the project and the least tractable,
and the numbers say why.

8,908 places are unverified. Of those, **5,627 have no steward recorded
at all** — 2,940 cemeteries, 2,055 town parcels, 625 preserves. All but
five have boundaries; 1,949 are 10 acres or more. These are real places
with real geometry and no one to ask about them.

They spread across **974 towns**, and the distribution is genuinely flat:

| Towns | Share of the stewardless tail |
|---|---:|
| Top 10 | 10% |
| Top 25 | 16% |
| Top 50 | 23% |
| Top 100 | 34% |

Contacting the hundred busiest town halls in two states clears a third of
it. There is no shortcut hiding in the shape of this data.

### But two rules would clear most of New York

Connecticut solved this class twice with single citations:

- `ct-municipal-openspace`, citing *Leydon v. Greenwich* — **1,439 places**
- `cemetery-daylight` — **1,289 places**, and all 1,289 CT cemeteries are green

New York has neither. It has ten rules, all of them state-land rules —
Forest Preserve, State Forest, WMA, Unique Area, Multiple Use Area and
four OPRHP variants. Nothing covers municipal parkland and nothing covers
cemeteries. The result:

| Missing NY rule | Places it would reach |
|---|---:|
| NY municipal parkland | 3,026 |
| NY cemeteries | 2,940 |
| **Combined** | **5,966 of NY's 6,688 unverified — 89%** |

New York municipal parkland has a well-established doctrine to research:
the public trust doctrine as applied to parkland alienation, the line of
cases running through *Friends of Van Cortlandt Park v. City of New York*.
Whether it supports a public-entry claim as cleanly as *Leydon* does is
exactly the question to answer, and it is one afternoon of legal
research against a payoff of ~3,000 places.

**This is the single highest-leverage piece of work available in the
project right now.** It should be done before any new state.

### The mechanism the tail actually needs

Research alone will not finish this, in two states or fifty. The tail
needs mechanisms that scale with something other than Timothy's hours:

1. **Class-level legal doctrine** — the two rules above, then their
   equivalents in each new state. This is the only lever that moves
   thousands at a time.
2. **An honest candidate tier**, so a promising unresearched place is
   *shown* as promising rather than flattened into the same amber as a
   parcel nobody can identify. 1,949 stewardless places over 10 acres
   with boundaries and elevation are not equivalent to a quarter-acre
   fragment, and the map treats them identically.
3. **User reports.** The report-a-problem link already sitting in the
   backlog is, for this specific problem, the highest-leverage item in
   the whole roadmap — it is the only mechanism whose capacity grows with
   the audience instead of shrinking against it. A local knows the
   trailhead behind the school is open. No dataset does.

---

## What to do next, in order

1. **Update the place counts in `CLAUDE.md` and `START-HERE.md`.** Both
   say 7,727. It is 24,805. Every derived percentage in both files is
   wrong, and these are the files the next session reads first.
2. **Make evidence tier a first-class field and show it.** Not a fourth
   colour — a stated basis on the card: cited regulation / official
   access rating / inferred from mapped features. Cheap, honest, and it
   converts an invisible 26% into a filterable, countable set.
3. ~~**Hand-check a random sample of 100 tier-3 greens.**~~ Done
   2026-08-25 — `docs/tier3-sample-2026-08-25.json`, seeded and
   reproducible, drawn from the post-NY-rules tier-3 population of 3,649.
   **9% confirmed wrong** (95% CI roughly 3–15%): three fee-charging
   (Bailey Arboretum, Mohonk's Trapps Gateway, a fairground), four school
   district properties, one YMCA camp, and one **federal naval nuclear
   laboratory** rendered green off a mapped trail. 65% confirmed open,
   26% undetermined — mostly unnamed subdivision set-asides and generic
   "Village of X land" parcels no source describes. New York holds 7 of
   the 9 errors. All nine are now cited entries in `verified.json`
   (fee-charging → the paid bucket; the rest `private: true`). Two
   watch-items surfaced: Winnapaug Farm Preserve is in Westerly RI but
   carries town "Stonington", and Boughton Park (E. Bloomfield) is a live
   example of a lawful residents-only NY park.
4. **Write the two NY rules** — municipal parkland and cemeteries. 5,966
   places, 89% of New York's unverified, from two citations.
5. **Add per-record provenance** before adding any state.
6. **Then shard**: `places-XX.json` per state, refresh split per state.
   Do it while it is two states and reversible.
7. **Then the Northeast**, one state at a time, rules first, measuring
   that the existing states do not move — the discipline that held CT
   still through the NY work, which is the reason that work is trusted.

Refill `relief` on the next refresh; it is at 49% and the 3D view wants
it.
