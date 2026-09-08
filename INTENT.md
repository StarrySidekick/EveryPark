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

**2. The app should show how sure the data is. — Already shipped, 2026-08-25.**

This note was written as if still open; checked 2026-09-08 and it isn't. Every
green pin already carries `p.evidence` (`cited` / `official` / `inferred`),
derived from `attrs.researched` and `attrs.officialAccess` in `classify()`
(`app.js`), shown as its own line on the card (`ev-official`/`ev-inferred`
styling, "Checked by hand" / "Rated open... PAD-US, not independently checked"
/ "Presumed public... unconfirmed"), filterable as three chips in the legend,
and counted — see `docs/SCOPE-AND-DATA.md` §1 for the tallies this was built to
make visible (`cf3be19`, "Say what each green pin is standing on").

What that work does NOT cover, and what's still actually open: `verified.json`
§4's separate idea of an **honest candidate tier** — a promising, boundary-and-
elevation-having but stewardless place (1,949 of them, 10+ acres, no steward on
record) shown as *promising* rather than flattened into the same amber as a
parcel nobody can identify at all. That's a fourth bucket among the unverified,
not another split of the green ones, and nobody has decided what it should say
or look like. Left here rather than decided for him.

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
