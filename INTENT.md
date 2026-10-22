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

## 2026-10-22: a guide to each park, proven on ten

Timothy, 2026-10-22: *"a comprehensive guide to each verified state park or
local park ... it relies on the efficacy of the data that this park is real
and can actually be visited ... navigate everything in a way that it feels
fun and interactive and mysterious without having to like take a picture of
the park map."*

Three things follow, in this order:

1. **Accuracy first.** A guide that sends someone down a trail that is not
   there is worse than the map with no guide. *"making sure all the data is
   as accurate as it possibly can be."*
2. **A start mode in the 3D view.** *"start at the beginning of wherever you
   are in order to begin your route."* You arrive at a lot or a trailhead,
   the viewer puts you there, and the route reads as the blazes you will
   actually see on the trees.
3. **The 3D view is the guide.** Not a picture beside a list of facts.

**Proven on a test set of ten Connecticut state parks before it goes wide**
(`data/testset.json`, audit in `docs/TESTSET.md`). Whatever has to be true
for those ten is the template for the rest.

**Offline is deferred.** It already works for the map; offline *guides*
come when this becomes an installable app. Not a goal for the test set.

## What is next

**1. Depth over breadth, on land that can actually be verified.**

Focus on parks where a public-access claim is genuinely checkable and richer
detail can be gathered: state parks, known non-profit parks, local parks.
**Easements and shaky-provenance spots are deprioritised** — not deleted, not
hidden, just not where the effort goes.

The reason is the release: when a stranger opens this, a green pin has to mean
they can really go there. Breadth that dilutes that is worth less than nothing.

**2. The app should show how sure the data is.**

This follows directly from the above and Timothy asked for it. The ingredients
already exist — `attrs.researched`, `attrs.sources`, `attrs.checked`, the
rule-versus-place distinction, the amber/green split, `dormant_rules` — but a
reader currently gets a binary where the data supports a gradient.

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
