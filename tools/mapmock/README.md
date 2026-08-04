# Top-down map style previews

`mock.html` renders the REAL `data/everypark.pmtiles` through the same
protomaps paint-rule structure the live site uses, with only the palette
and turf texture swapped. Style decisions get made by looking, not by
imagining.

```bash
python3 tools/mapmock/serve.py 8124 .        # from the repo root
# then open http://127.0.0.1:8124/tools/mapmock/mock.html?v=a&z=13
```

`?v=a|b|c` picks the variant, `?z=` the zoom, `?lat=&lng=` the centre.

**Use `serve.py`, not `python3 -m http.server`.** The stock server ignores
HTTP Range requests, and PMTiles is read by byte range — the map comes up
blank and empty, with no error, which looks exactly like a styling bug.

## What the previews established (2026-08-04)

- **The ground cannot be green.** Green means "you can go here" in this
  map's colour code. On a turf-green basemap (variants b/c) park fills
  stop reading as parks — the semantic collapses. The golf-course feel
  has to come from texture, palette and type, not from a green field.
- **One screen-space overlay beats per-polygon patterns.** A single div
  over the map with `mix-blend-mode` textures the basemap AND the
  polygons at once, with no paint-rule changes. protomaps' own
  `PolygonSymbolizer` does support `pattern`, but it is applied once per
  rule and overrides per-feature fill — and splitting a dataLayer into
  several rules has already broken tile loading in this codebase once
  (see the comment in `vectorlayers.js`).
- A conic-gradient makes a true checkerboard; the usual
  two-linear-gradient trick makes diagonal argyle diamonds.
