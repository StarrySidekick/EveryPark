# Intent

What this is for, and what to build next. Recorded **2026-09-06** from Timothy's
own answers to a direct set of questions, so this is *stated* intent rather than
intent inferred from the code.

**Read this before choosing what to build.** Where it disagrees with the rest of
the docs about **direction**, this file is newer and wins. Where it disagrees
about **mechanics** — how the code works, what was decided deliberately, the
invariants — the other docs win, always.

When something here is done, or turns out to be wrong, **edit it**. A stale
intent file is worse than no intent file.

## What it is for

**A public tool.** Timothy intends to release this, which raises the bar on
every claim the map makes.

## What is next

**1. Depth over breadth, on land that can actually be verified.**

Focus on parks where a public-access claim is genuinely checkable and richer
detail can be gathered: state parks, known non-profit parks, local parks.
**Easements and shaky-provenance spots are deprioritised** — not deleted, not
hidden, just not where the effort goes.

The reason is the release: when a stranger opens this, a green pin has to mean
they can really go there. Breadth that dilutes that is worth less than nothing.

**2. ~~The app should show how sure the data is.~~ — done 2026-09-10.**

Correction to how this was written: the rule-versus-place distinction did NOT
already exist as an ingredient — `apply_verified()` stamped `researched: true`
identically whether a rule settled a whole class of land or a person checked
one named place, and nothing downstream could tell them apart. That was the
actual gap, not just "show what's there."

`verifyplaces.py` now stamps `citedPlace: true` for a specific place-level
entry and `citedRule: "<label>"` (the rule's own `label` field in
`verified.json` — one sentence, written once, never duplicated into app.js)
for a category rule. The card states four tiers in order of what they
actually claim, measured against the 18,736 green pins at this publish:
*Checked by hand for this place* (37), *Covered by &lt;regulation&gt; — not
independently checked for this place* (10,803), *Rated open in USGS PAD-US —
not independently checked* (4,285), *Presumed public — &lt;facility&gt; mapped,
access unconfirmed* (3,611) — 37+10,803+4,285+3,611 = 18,736. citedPlace also
lands on 23 more places that AREN'T green (a `private` finding, `citedPlace`
and `status: unverified` together), which is the "checked and found closed"
case in the next paragraph — 60 places total carry `citedPlace`. The top two
tiers also print `checked` as a real date plus "N months/years ago", and every
source URL in `attrs.sources` as a numbered, clickable citation — both existed in the
data and neither was ever shown anywhere before this. Runs on amber cards too:
a `private`-flagged place (a specific person checked it and found it
members-only) now visibly outranks a place nobody has looked at at all, which
is a real distinction the old binary couldn't make. The three-way "Verified
by" filter chips (Checked by hand / Official rating / Presumed) are untouched
— this sits inside the "Checked by hand" tier they already had, one level
deeper.

**3. The 3D isometric view, with more detail per park.** This is where he wants
the effort. It is the centrepiece, not a novelty beside the map.

## Assets: a standing job

**Timothy draws the art himself, in Procreate. Icons are the big need.**

The list lives at **[`docs/ASSETS-NEEDED.md`](docs/ASSETS-NEEDED.md)**, written
2026-09-06: every glyph the app draws, what it means, where it shows, the size
it has to survive, the house rules (drawn not emoji, 24-unit grid, stroke 2,
`currentColor`, no colour of its own), and the raster-versus-vector question
that decides how a Procreate file becomes an icon.

**Keep it current.** A landed icon moves to its Done section with a date; a new
glyph in the app gets a row in the same commit. The largest hole it found is
that the 3D viewer fetches sixteen kinds of public building and has nothing
distinct to draw for any of them.

## Deliberately not next

- **More states.** New York and Connecticut only for now. New England eventually.
  Each new state costs a rules audit and a `states`-scoping pass, not just a
  fetch; see the 1,712-place incident in `CLAUDE.md`.
