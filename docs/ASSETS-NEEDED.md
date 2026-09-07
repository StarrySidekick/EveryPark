# Icons wanted

Timothy draws the art. This is the list to draw from, so that sitting down in
Procreate does not start with working out what is missing.

Every icon below is either **already drawn in code and would be better by hand**,
or **not drawn at all and currently shows nothing**. Both are listed, because
replacing a placeholder and filling a hole are the same sitting.

**Keep this file current.** When one lands, move it to Done at the bottom with
the date. When the app grows a new glyph, add a row here in the same commit.

---

## The house rules for an icon here

These are not style preferences, they are what the code already assumes.

- **Everything is drawn. No emoji, anywhere** — in code, data, comments or UI.
  Emoji render differently on every platform and carry their own colour, which
  is the one rule this project has about icons. The verdict glyphs were emoji
  once and were replaced for exactly that reason.
- **A card icon is a 24×24 stroke drawing with no fill**, rendered at **13×13**.
  `stroke-width: 2`, round caps, round joins, `stroke="currentColor"`. Look at
  `FEAT_SVG` in `app.js` for the convention. Two pixels of stroke on a 13px
  render is heavy, so **anything with more than about five strokes turns to mud**
  — draw for the 13px, not for the 24 grid.
- **No icon carries its own colour.** `currentColor` means the card decides, so
  the same glyph reads on a green verdict, an amber one, and in dark mode. An
  icon with a colour baked in will look wrong in three places out of four.
- **A map mark is a filled `Path2D` drawn on canvas at about 26px** (`MARK_PX`),
  not an SVG element. Marks were divIcons once and it cost 30fps across 260 of
  them, so they must stay canvas paths. See the failure table in `CLAUDE.md`.
- **A 3D sprite is drawn straight onto the viewer's canvas** and can be raster.
  Different constraint from the card icons; see "How to hand these over".

---

## 1. Card and legend icons — 15 exist, all hand-replaceable

These are the ones a visitor reads most. All fifteen are currently geometric
code drawings in `FEAT_SVG` (`app.js`), which are legible but generic.

| Key | What it means | Where it shows | Current drawing | Priority |
|---|---|---|---|---|
| `trail` | mapped walking trails | card, legend | a wandering line with a dot | **high** — the most-shown icon on the map |
| `water` | waterfront of any kind | card | three wave lines | **high** |
| `wooded` | tree cover, from NLCD | card, mark | — | **high** |
| `field` | open ground, from NLCD | card, mark | — | **high** |
| `parking` | a public car park | card | — | **high** — this is what decides whether you can actually go |
| `beach` | swimmable shore | card | parasol over a shoreline | medium |
| `pool` | a public pool | card | ladders over waves | medium |
| `sports` | courts and pitches | card | a circle quartered | medium |
| `playground` | play equipment | card | a slide as a triangle | medium |
| `dog` | dogs allowed or a dog park | card | five ellipses as a paw | medium |
| `historic` | a historic site | card | a colonnade | medium |
| `relief` | elevation change worth noting | card | — | low |
| `ticket` | costs money to enter | card | — | low |
| `mixed` | mixed land cover | card | — | low |
| `arrow` | "Directions" link | card | — | low — it is chrome, not content |

## 2. Verdict glyphs — 4, and they carry the most weight

These say whether a person can actually go, which is the entire claim the map
makes. They deserve the most care and the least cleverness.

| Key | Means | Note for drawing |
|---|---|---|
| `open` | free, legal, reachable | currently a tick. Must read instantly and read *positive*. |
| `permission` | open by the owner's permission, not by right | currently a zigzag. **Must not read as a lesser tick** — it is a different kind of answer, not a weaker yes. |
| `closed` | genuinely not open to the public | currently a circle with a slash. |
| `unknown` | not checked | currently a shield with an exclamation. **Must not read as "bad"** — amber is honest uncertainty, not a defect, and roughly 9,000 places wear it. |

## 3. Map marks — 6, canvas paths

Filled silhouettes at ~26px, drawn thousands at a time. **Simple, solid,
readable at a glance and at small size**; no interior detail, since it will not
survive.

`wooded` · `field` · `mountain` · `sports` · `beach` · `grave`

## 4. The 3D viewer — 11 sprites, and this is where the effort is going

The isometric view "with more detail per park" is the priority, and these are
what stands on the island. Currently each is a small code drawing.

`baseball` · `basketball` · `tennis` · `pickleball` · `soccer` · `volleyball` ·
`playground` · `pool` · `dogpark` · `track` · `parking`

**Isometric, matching the viewer's projection.** They sit on a grid of ground
cells and are snapped to the nearest cell, so they want a consistent footprint
and a consistent light direction across the set. Season and time of day change
the scene's palette around them, so a sprite that fights the palette will fight
it four ways.

## 5. Not drawn at all — the buildings around a park

The viewer already fetches sixteen kinds of public building near a park and has
nothing distinct to draw for them. This is the largest genuine hole, and it is
what would make the surroundings read as a place rather than as blocks.

`library` · `townhall` · `museum` · `community_centre` · `arts_centre` ·
`theatre` · `post_office` · `school` · `college` · `university` ·
`place_of_worship` · `fire_station` · `police` · `courthouse` · `hospital` ·
`clinic`

**These do not all need to be distinct.** A believable grouping is worth more
than sixteen bespoke buildings: civic (townhall, courthouse, post office),
learning (library, school, college, university), culture (museum, arts centre,
theatre, community centre), emergency (fire, police, hospital, clinic), and
worship on its own. **Five or six buildings would cover the set honestly.**

## 6. The five categories have colours but no glyphs

Each category has a swatch and no mark of its own, so the legend is colour-only,
which is the one encoding a colourblind reader cannot use.

| Category | Swatch | Wants |
|---|---|---|
| State land | `#1b5e20` | something that reads state, not federal |
| Federal land | `#6d4c41` | distinct from state at 13px |
| Town or city | `#1565c0` | |
| Land trust / non-profit | `#00838f` | |
| Cemetery | `#5e35b1` | there is already a `grave` mark; these may be the same drawing |

---

## Priority, if only one sitting

1. **The four verdict glyphs.** Most weight per pixel, and they carry the claim.
2. **The five high-priority card icons** (trail, water, wooded, field, parking).
3. **The five or six grouped buildings**, which is what makes the 3D view read
   as somewhere real.
4. The rest of the card icons, then the sports sprites.

---

## How to hand these over

Two different targets, and the difference matters:

- **Card icons, verdict glyphs and category marks want vector.** They render at
  13px in `currentColor` and must take the card's colour, which a PNG cannot do.
  **Procreate exports raster**, so these need either a trace to SVG paths
  afterwards, or drawing the shape in Procreate as reference and cutting the
  path by hand. A clean, high-contrast black-on-white export at large size is
  the most useful thing to hand over — say 1024×1024 on the same 24-unit grid,
  one icon per file, named by its key from the tables above.
- **3D sprites and buildings can stay raster.** The viewer draws onto a canvas
  and can blit a bitmap. Transparent PNG, one per kind, named by key, at roughly
  4× the size it renders so it holds up on a dense-pixel screen.

Either way: **one file per icon, named exactly by the key in these tables**, so
wiring them up is mechanical rather than a guessing game about which drawing is
which.

---

## Done

Nothing yet. When one lands, move its row here with the date it went in.
