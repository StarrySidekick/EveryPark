# 3D terrain viewer — how it is supposed to look

This is the record of the viewer's intended appearance, written down after
a week of "fixed one thing, broke another." **Before pushing any change to
`iso.js`, run `check.mjs` in this folder and eyeball its screenshots
against this list.** Every line below has been broken at least once by a
change that looked correct.

## Invariants — all modes

- **The tree field never changes except with the season.** Same trees, same
  spots, same sizes whether the view is spinning, dragging, paused, or at
  any motion-LOD stride. Decorations (trees, boulders, headstones,
  facility marks) are seeded per FULL-RESOLUTION grid cell; if they follow
  the coarse LOD lattice the forest visibly reshuffles and flickers every
  time the spin starts or crosses a quadrant. (Broken in v0.26.1.)
- **The island rim is one continuous earth-brown ring** — the wall colour
  (`WALL`), never terrain green — at rest and mid-spin, in blocky and
  smooth and satellite modes alike. (Broken in v0.26.1: rim edge tests
  keyed on the full-res `edge[]` mask, which coarse anchors miss.)
- **No emojis anywhere.** Every icon is drawn (canvas sprite or inline
  SVG).
- Sky is a plain gradient. Time-of-day button top-LEFT corner, season
  top-RIGHT, both anchored to the viewport with 10px insets.
- Trails are yellow DASHED draped ribbons; roads solid grey with darker
  edge band; both always visible (drawn in a final pass, sorted by depth,
  never occluded by terrain or trees) and clipped to the island.
- Defaults on open: blocky (smooth off), sides Solid, summer, day,
  spin ON, ~10 m per block. Cemeteries open at dusk with headstones and
  ground mist.
- Zoom: wheel and pinch, capped at 5x.

## Blocky (voxel) mode

- Each column is a projected diamond top plus the TWO camera-facing side
  quads, shaded .58 (front) and .76 (side) of the top colour — the
  three-tone split is what reads as a cube. Which pair faces the camera
  follows the rotation. (When both faces were screen-aligned rects, every
  block "faced you" at all rotations — do not go back to rects.)
- Side quads must NOT self-stroke. A same-colour stroke bleeds the dark
  wall half a pixel over the lit top of the neighbouring column and draws
  a vertical hairline up every pillar (A/B verified). Abutting fills share
  exact projected corners and need no seam cover. The top diamond DOES
  stroke with its own fill — that one is fine.
- Interior step walls (against a lower neighbour) use the shaded terrain
  colour and stop at the neighbour's roof (+1px overlap). Only walls with
  NO neighbour — the rim — are brown.
- Hidden faces are culled: a neighbour at or above this block's height
  means no wall is drawn at all.

## Smooth mode (and satellite, which implies smooth)

- One continuous mesh — zero gaps between quads at rest AND mid-spin.
  Quads and their rim-wall tests must span the same stride the LOD walk
  steps (`st`), or coarse passes shatter the surface into isolated tiles
  with vertical gaps. (The v0.26.0 regression.)
- Every inside cell gets a quad; missing neighbours reuse the cell's own
  height so the mesh ends flat — no blocky fringe at the shoreline.
- Rim walls appear wherever the neighbouring QUAD (one stride away) is
  missing — not wherever `edge[]` says.

## Motion LOD (perf) — the rules that keep it invisible

- While moving: grid stride 2, render scale 0.7, then ONE full-detail
  pass on settling. The only acceptable visible difference while moving
  is overall softness — never different trees, different rim, or gaps.
- Painter's order comes free from the directional walk (step each axis in
  the sign of its rotation term); nothing is sorted per frame.
- The scene is cached per view signature and blitted; only the hiker is
  drawn per frame.

## How to run the checks

```bash
cd tools/isotest
npm install playwright     # once; chromium at /opt/pw-browsers in sandbox
python3 -m http.server 8123 --directory ../..   # serve the repo root
node check.mjs             # writes /tmp/iso-*.png, exits non-zero on failure
```

`check.mjs` verifies programmatically: no sky-coloured holes inside the
island in smooth mode, tree-pixel count within 10% between spinning and
rest, brown rim pixels present mid-spin, and no page errors. The
screenshots it writes are for eyeballing against this document.
