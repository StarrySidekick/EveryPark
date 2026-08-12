# EveryPark

An interactive map of every publicly accessible outdoor place in Connecticut.
Live at **[everypark.starrysidekick.com](http://everypark.starrysidekick.com)**.
Repo `StarrySidekick/EveryPark`, hosted free on GitHub Pages.

*24,705 places · updated August 12, 2026*
<!-- The line above is stamped automatically by publish.py and the
     refresh workflow. Don't edit it by hand. -->

The map answers three questions at a glance:

| Question | How it's shown |
|---|---|
| **Can I go there?** | Green fill = public land. The popup says whether that's by right or by the owner's permission. |
| **Who runs it?** | Border and pin-ring colour: state green, federal brown, town blue, land trust teal, cemetery purple. |
| **What kind of place is it?** | The pin's icon, plus filter chips for trails, water, sports, playground, historic and parking. |

## How it works

Everything is precomputed. The site fetches **no live data** — no ArcGIS, no
OpenStreetMap, no USGS — and does no classification, enrichment or deduplication
in the browser. A visit costs about **290 KB and a third of a second**.

Two generated artefacts do the work:

**`data/places.json`** (~2 MB, ~245 KB gzipped) — every place, already
classified and enriched: access, steward, kind, acreage, town, and what's
actually there. Only source facts are stored; anything derivable (the access
label, its explanation, the steward, the access note) is recomputed on load by
the same functions the build uses. That keeps ~2.9 MB out of the download and
means changing the wording is a code edit, not a rebuild.

**`data/everypark.pmtiles`** (13.6 MB) — every boundary and trail, pre-cut into
map tiles across zooms 6–14 and packed into one file. The browser pulls only the
tiles on screen using HTTP range requests, so panning costs kilobytes.

## Publishing — the one rule

**Data flows only through the Actions.** Edit `data/verified.json` (or code),
commit, push — `publish.yml` applies it and deploys in about ninety seconds.
A local deploy must never touch `data/`: it bypasses the workflows'
concurrency lock and has already clobbered Action-enriched output once.
If a local push is ever needed, it is for site code (HTML/JS/CSS) only.

## Rebuilding the data

```bash
# 1. Fetch raw geometry — open in a browser, downloads ep-*.geojson
#    http://everypark.starrysidekick.com/tiles.html

# 2. Build the tile archive (staged, so each step is a short run)
python3 maketiles.py stage ep-*.geojson --zooms 6 7 8 9
python3 maketiles.py stage ep-*.geojson --zooms 10 11
python3 maketiles.py stage ep-*.geojson --zooms 12
python3 maketiles.py stage ep-*.geojson --zooms 13
python3 maketiles.py stage ep-*.geojson --zooms 14
python3 maketiles.py pack -o data/everypark.pmtiles

# 3. Build the place list
python3 buildplaces.py --raw <dir with baked.json + ep-padus.geojson> \
                       --data data -o data/places.json

# 4. Bump CONFIG.dataVersion in config.js, or browsers keep the old copy
```

`build.html` regenerates `baked.json`, the raw pull that the place builder reads.

## What counts as public

The rule: **paid-but-open-to-anyone stays; exclusive-entry goes.** A town beach
charging non-residents is public. A members-only lake association is not.

**Cemeteries stay** (decided 2026-08-02): they are walkable public green
space, purple-coded and filterable off. This was a deliberate call — do not
re-litigate it without a new reason.

Excluded automatically:

- Members-only land — clubs, HOAs, beach and lake associations, sportsmen's and
  rod-and-gun clubs, scout reservations
- **Conservation easements on private land.** An easement restricts what the
  owner may build; it is not a right of way. PAD-US records these under the
  owner's name, which is why they arrive called "44 Sunny Ridge Road, LLC".
- Land owned by a private individual under an agricultural, ranch or
  forest-stewardship easement — protected, but it's somebody's farm
- Tribal reservations and burial grounds (CGS ch. 824: no entry without the
  tribe's written permission)
- Places recorded as closed to public access
- Linear features with no surface area — a trail on its own isn't a destination

Land trusts stay even when PAD-US calls them "restricted". That rating means
there's no legal *right* of access, not that you're unwelcome; under
Connecticut's Recreational Use Statute (CGS §§52-557f–i) they commonly permit
walking. Upland Pastures in Sherman is the case that established this.

## Sources

| Source | Provides |
|---|---|
| CT DEEP Property | State parks, forests, wildlife areas, boat launches |
| National Park Service / USFWS / USACE | Federal land |
| OpenStreetMap (via Esri mirrors) | Town parks, preserves, cemeteries, greens, trails, facilities, water |
| USGS PAD-US | Official access ratings, owner and manager names, and land nothing else records |
| CFPA | Blue-Blazed trail system (~825 miles) |
| USGS 3DEP | Elevation, sampled when a popup opens |
| `data/additions.json` | Hand-added places the other sources miss |

## Deduplication

Each piece of ground should be drawn once, by whichever source describes it
best. Priority: DEEP → town parks → cemeteries → greens → preserves → PAD-US.
Anything substantially covered by a better source is dropped.

Area overlap alone isn't enough: one sprawling PAD-US unit against the many
small DEEP parcels that compose it never crosses the threshold on any single
parcel, so name matching runs alongside it. In the place list, the same name in
the same town is treated as one place however far apart the parcels sit — the
Quinebaug Fish Hatchery arrived six times otherwise.

## Files

```
index.html          markup, filter chips, legend
config.js           all customisation: colours, sources, dataVersion
app.js              map, markers, popups, filtering, search
vectorlayers.js     vector tile rendering, hover, click
buildplaces.py      builds data/places.json from raw sources
maketiles.py        builds data/everypark.pmtiles
tiles.html          browser page that downloads raw geometry
build.html          browser page that rebuilds baked.json
data/               places.json, everypark.pmtiles, towns.geojson, additions.json
```

## Traps worth remembering

- **`y_coord_down` must be set when encoding tiles.** The encoder flips the y
  axis by default and `to_tile_coords` already emits y-down coordinates. Miss it
  and every shape is mirrored inside its own tile — subtle at zoom 14, wildly
  wrong at zoom 9. Verifying with the default decoder hides the bug, because it
  flips the same way.
- **`maxDataZoom` must match the archive's top zoom.** Without it the renderer
  looks for tiles that don't exist past zoom 14 and draws nothing — the map goes
  blank exactly when you zoom in to look at something.
- **Point layers reject `returnCentroid`.** OSM's POIs and Tourism layers are
  point geometry; the query succeeds but every feature comes back with no
  centroid and is skipped silently. `pointOf()` handles both shapes now.
- **Clip everything to Connecticut before tiling.** One PAD-US record for the
  Appalachian Trail corridor spans fourteen states, so its bounding box claims
  thousands of tiles.
- **Don't use `cache: "force-cache"` for the dataset.** It will happily return a
  stale 404 from before the file existed, silently dropping the map back to the
  slow live path.
- Protected open-space parcels (POSM) aren't in the archive — that layer wasn't
  fetched. Re-run its row in `tiles.html` to add it.
