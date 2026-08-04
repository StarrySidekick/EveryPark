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
- **Decorations are video-game SPRITES (v0.28.0, Timothy's spec).** Trees,
  boulders, headstones, reeds and bushes paint AFTER every terrain
  column, sorted far-to-near — their full face is always shown; the
  ground never eats a sprite while the view turns. (Before this, trees
  on away-facing slopes sank into the hillside mid-rotation.) The known
  trade: a sprite whose ground is hidden behind a ridge stands on the
  silhouette instead of vanishing — accepted.
- **NLCD ground classes (v0.28.0).** Per-cell land cover from MRLC's WMS
  (same raster the pipeline samples for the cover label): wetlands get a
  swampy tint + marsh reeds (class 95), scrub gets olive tint + low
  bushes (51/52), barren reads as sand, grassland/pasture as meadow,
  crops warm tan, developed grey. Tints blend 55/45 into the height
  palette BEFORE season/time-of-day so relief shading stays readable and
  autumn still turns. Forest classes carry no tint. Without a canopy
  mask, no trees are invented on marsh/sand/crops/pavement. If mrlc.gov
  refuses cross-origin reads the whole thing silently degrades to the
  uniform palette — that is the designed fallback, not a bug. The
  harness serves a canned NLCD raster so every class renders offline.
- **The island rim is one continuous earth-brown ring** — the wall colour
  (`WALL`), never terrain green — at rest and mid-spin, in blocky and
  smooth and satellite modes alike. (Broken in v0.26.1: rim edge tests
  keyed on the full-res `edge[]` mask, which coarse anchors miss.)
- **Trees and the hiker are INDEXED PIXEL ART (v0.32.0).** Authored in
  `tools/sprites/author.py`, which renders them magnified so the pixels
  can be looked at; the shapes live in `iso.js` as strings where each
  character names a palette slot, NES-style. One conifer covers all four
  seasons via `PIX_SEASON` palette swap — do not add per-season copies.
  Four tree variants (conifer, broadleaf, slim, bush) each keep their own
  proportions and height factor (`PIX_TREE_SCALE`); sharing one atlas
  cell size drew every bush as tall as a pine. The outline slot stays
  near-black in every season — a constant dark edge is what makes the art
  read at 20 px tall. `imageSmoothingEnabled` MUST be false around every
  blit or the pixels turn to mush. The hiker is a four-frame walk cycle
  with no vertical bob: a pixel sprite moving by fractions of a pixel
  just shimmers. Boulders and headstones are pixel art too, via
  `propAtlas` (one palette, rebuilt only when the light changes).
  Cemetery stone is biased BLUE because cemeteries open at dusk and a
  neutral grey came out salmon once tinted.
- **The Pixel/Classic toggle must keep working.** `classicTrees` and
  `classicHiker` are the pre-v0.32 drawn look, kept deliberately. Both
  atlases expose the same `cells` shape so the draw code never branches
  on which is in use — only the atlas and a per-variant scale differ.
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
- Zoom: wheel and pinch, capped at 9x.
- **Landscape names** (v0.27.0): GNIS summits/ridges/gaps/cliffs and
  lakes/reservoirs/falls, max 8 per park, drawn LAST (never hidden by
  terrain). Uppercase monospace with a paper-coloured halo; water names
  in lake-blue ink, land names in forest ink; a 1px tick pins each name
  to its cell. Greedy spacing skips a name that would overlap one
  already placed. The harness feeds two canned names (Test Hill,
  Mirror Lake) so this pass renders offline.

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
- Every inside cell gets a quad. A corner that falls off the island takes
  a fill height that depends ONLY on that corner (the mean of its inside
  neighbours, memoised) — never on which cell is asking. When it returned
  the asking cell's own height, the two quads either side of a shoreline
  corner placed it at two different heights and the mesh tore. That was
  the smooth-mode stitching.
- Rim walls appear wherever the neighbouring QUAD (one stride away) is
  missing — not wherever `edge[]` says.

## Motion LOD (perf) — the rules that keep it invisible

- **Anchors sit on a FIXED lattice** (multiples of `st`), and only the
  ORDER of the walk follows the rotation. When the start cell depended on
  the walk direction, stride 2 put anchors on even cells going one way
  and odd cells going the other, so crossing a quadrant while rotating
  flipped the parity of the whole grid and every column and tree jumped a
  cell. Measured with `flipdiff.mjs`: mean abs pixel difference across
  the quadrant boundary was 8.30 vs 7.45 for an identical rotation
  elsewhere; after the fix, 7.48 vs 7.45. (Only shows when GRID is even —
  at odd GRID the two lattices coincide, which is why the first A/B
  looked clean.)
- **Decorations stand at their OWN cell's height**, at every stride.
  Borrowing the anchor block's height tied each tree to whichever block
  owned it, so the forest stepped up and down as the stride changed.
- Dropping the stride entirely is NOT an option: measured 12 fps at
  stride 2 vs 4.6 fps at stride 1 on a wooded 90 m-relief park.

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
