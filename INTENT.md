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

**2. ~~The app should show how sure the data is.~~ — already done, and done
before this file was written.** Checked 2026-09-13: `p.evidence` (`cited` /
`official` / `inferred`) has been on every green pin since 2026-08-25
(`cf3be19`, "Say what each green pin is standing on") — a stated basis on the
card (`basisHtml()` in `app.js`), three filter chips, and a test seam
(`window.__epEvidence`). This item was carried over stale from the audit that
asked for it; the gradient it wanted is live. What is NOT done, and is a real
next step if this is revisited: `docs/SCOPE-AND-DATA.md` §1 still wants an
honest *candidate* tier above plain "inferred" for the 1,949 stewardless
places over 10 acres with boundaries and elevation but no citation — those
are not equivalent to a quarter-acre parcel nobody can identify, and the map
currently treats them the same.

**3. The 3D isometric view, with more detail per park.** This is where he wants
the effort. It is the centrepiece, not a novelty beside the map. A north
arrow and scale bar landed 2026-09-13 (the view "rotates freely with nothing
to say which way is north" — noted in `docs/START-HERE.md` §4 — is fixed);
still open there: the context margin (parks currently end in a cliff),
pre-baked terrain, and adjacency between neighbouring parks.

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
