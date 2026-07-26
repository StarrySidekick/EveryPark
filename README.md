# EveryPark — Complete Documentation
### Interactive map of every public outdoor place in Connecticut
**Live:** [everypark.starrysidekick.com](http://everypark.starrysidekick.com)
**Repo:** `StarrySidekick/EveryPark` · **Hosting:** GitHub Pages (free)
*Last updated July 25, 2026 — 4,991 places mapped*

---

## 1. What this is

A single-page map of every place in Connecticut you can legally go outdoors: state parks and forests, federal land, town parks, land trust preserves, and cemeteries. It shows real property boundaries over satellite imagery, draws actual trail lines, and — unusually for a park map — tells you whether a place can *actually be entered*, since a lot of protected land has no trail, no parking and no realistic way in.

**Guiding rule:** anyone can go, even if it costs money. Paid-but-open (state park out-of-state parking, ferry to an island, a permit you can buy) stays. Exclusive-entry (country clubs, beach associations, HOA land) goes.

**Second rule — areas, not lines.** Trail corridors like the Appalachian Trail are excluded as *destinations*, because a line isn't a place. Trails still render as context.

---

## 2. Architecture at a glance

Everything is static files on GitHub Pages. There is no server, no database, no API key, and no cost. All the live data is fetched by the visitor's browser directly from public GIS services and cached locally for a week.

```
Browser loads index.html
   ├── config.js ......... every setting worth changing
   ├── app.js ............ all logic
   ├── styles.css
   ├── icons/*.svg ....... marker graphics
   └── data/
        ├── state.json ......... 139 state parks/forests/reserves (baked in)
        ├── national.json ...... 11 federal sites (baked in)
        ├── additions.json ..... places missing from OpenStreetMap
        ├── towns.geojson ...... 169 town boundaries
        └── coast.json ......... 3,107 coastline points

Then at runtime the browser fetches, in order:
   1. DEEP Property ......... wildlife areas, flood control, hatcheries
   2. OSM leisure=park ...... town parks
   3. OSM landuse .......... town greens, rec areas, forests
   4. OSM nature_reserve .... land trust preserves & open space
   5. OSM landuse=cemetery .. cemeteries
   6. Enrichment ........... sports, water, parking, historic
   7. Trail grid ........... access scoring (slowest, runs last)
```

Loading is **progressive**: the map is usable in a couple of seconds, and the slower layers fill in behind it. Everything lands in `localStorage` and is reused for 7 days.

---

## 3. Data sources

| Source | What we take | Notes |
|---|---|---|
| **CT DEEP Property** (ArcGIS) | State parks, forests, scenic reserves, wildlife areas, flood control, hatcheries, natural + historic preserves | 9 of 13 categories. Authoritative. |
| **National Park Service** | Weir Farm, Coltsville | Hand-curated |
| **US Fish & Wildlife** | 4 Stewart B. McKinney refuge units | Hand-curated, verified against fws.gov |
| **US Army Corps of Engineers** | 5 flood-control reservoirs | Hand-curated |
| **OpenStreetMap** via Esri's live mirrors | Town parks, preserves, cemeteries, greens, rec areas, trails, water, parking | Updated continuously by OSM contributors |
| **USGS 3DEP** | Elevation / terrain relief | 1-metre resolution, free, no key. Slow — on demand only. |
| **Esri World Imagery** | Satellite basemap | Free, no key |
| **CARTO Voyager** | Street basemap | Free |
| **HandsOnDataViz** | 169 town boundary polygons | Used for town lookup + borders |

The OSM layers we query:

- `OSM_NA_Leisure` — parks, nature reserves, pitches, playgrounds, pools
- `OSM_NA_Landuse` — cemeteries, recreation grounds, village greens, forest
- `OSM_NA_Trails` — 30,334 `highway=path` segments
- `OSM_NA_Water` — named water bodies
- `OSM_NA_POIs` — public parking
- `OSM_NA_Highways` — used for diagnostics

---

## 4. The five layers

| Layer | Colour | What's in it | On by default |
|---|---|---|---|
| **State** | green 🌲 | 139 DEEP properties + 122 wildlife/flood/hatchery areas | ✅ |
| **Federal** | brown 🏔️ | 11 sites: 2 NPS, 4 refuge units, 5 Army Corps reservoirs | ✅ |
| **Town** | blue 💧 | Municipal parks, open space, greens, recreation areas | ✅ |
| **Preserves** | teal 🍃 | Land trusts, conservancies, Audubon, nature preserves | ✅ |
| **Cemeteries** | purple 🪦 | ~1,370, with colonial burying grounds flagged historic | ❌ off |

Preserves are sub-classified by who runs them, read from the OSM `operator` tag:
**Land Trust Preserve** (Winchester, Greenwich, Avalonia, Nature Conservancy…) · **Nature Preserve** (nonprofits without "trust" in the name) · **Town Open Space** (folded into the Town layer).

---

## 5. Can you actually go there?

The feature that makes this different from other park maps. Three signals, in priority order:

1. **🥾 Trails mapped** — a trail from the 30,334-segment network falls inside the place. Strongest evidence.
2. **🅿️ Parking nearby** — public parking within 400 m. You can at least reach it.
3. **Facilities on site** — ball fields, playground, pool, beach imply access.

Nothing at all → **⚠️ "No mapped trail or parking — access unverified."**

The wording is deliberate: it means *we found no evidence*, not that it's closed. **Of 4,991 places, only about half show evidence of being usable.** Half the "public land" in Connecticut is effectively paper preserves.

The **🚶 Visitable** filter shows only places that pass.

**How the trail test works:** every trail vertex is collapsed into a ~165 m grid cell, and we cache the set of occupied cells. Testing a place is then an instant lookup rather than a geometry operation. Fetching full trail geometry statewide froze the browser — the working version asks the server to simplify heavily, fetches pages four at a time, and runs *after* the map is already interactive.

---

## 6. What's on the map

**Basemaps** — Satellite (default) with a switcher, bottom right, for Street map.

**Boundary polygons** — real property shapes appear at zoom 12+, colour-coded by layer, loaded per viewport. Over satellite this is what makes public vs. private legible at a glance.

**Trail lines** — yellow dashed, zoom 13+, full detail, loaded per viewport, drawn *beneath* park polygons so shapes stay readable. Hover for the trail name.

**Filters** — five layer toggles plus attribute chips: Visitable, Water, Trails, Sports, Playground, Historic. All combine with each other and with search.

**Popups** show type badge, town, acreage, feature tags, the access verdict, fee information, and Directions + Official site links.

**Terrain** — click any place and USGS elevation is sampled across it, returning e.g. *"Steep · 110 m relief."* Takes a few seconds and updates the popup in place. Too slow to run for every place, which is why it's on demand.

**🔎 Find gaps** — inverts the trail analysis to find trail networks with no listed place nearby. A worklist of possible missing parks.

---

## 7. Fees, by layer

| | What visitors pay |
|---|---|
| **State parks** | Free parking for CT-registered vehicles (Passport to the Parks, since 2018). Out-of-state $7–22. Camping and special facilities extra. |
| **Federal** | NPS and refuge units free. Ferries to islands cost extra. Army Corps day use free; West Thompson camping charges. |
| **Preserves** | Free. |
| **Town parks** | Usually free; shoreline town beaches charge non-residents heavily ($45–70/day in some towns). Not yet captured per-town. |

**Legal background:** *Leydon v. Greenwich* (2001) established that every municipal park and beach in Connecticut must admit non-residents — but towns may charge them more. Under the public trust doctrine, the shore below mean high water is public everywhere, even in front of private beach associations.

---

## 8. Customising it

Nearly everything lives in **`config.js`** and needs no coding:

| Setting | What it does |
|---|---|
| `siteTitle`, `tagline` | Header text |
| `icons` | Marker graphics — drop an SVG/PNG in `icons/` and point to it |
| `colors` | Per-layer colour, used by markers, badges and polygons |
| `basemaps` | Add/remove/reorder; first is default |
| `overlays.minZoom`, `fillOpacity` | When park shapes appear, how solid |
| `trailLines` | Colour, weight, dash pattern, zoom threshold |
| `townBorders` | Colour, weight, opacity |
| `access.parkingRadiusM` | How close parking must be to count |
| `terrain.enabled` | Turn terrain lookups off |
| `stateExtra.legends` | Which DEEP categories to include |
| `extraLanduse.kinds` | Which OSM landuse types count as places |
| `municipal.cacheDays` | How long visitors keep cached data |

**Adding a place OSM doesn't have** — edit `data/additions.json`:

```json
{ "n": "Deer Pond Farm", "type": "preserve", "t": "Audubon Sanctuary",
  "town": "Sherman", "lat": 41.55352, "lng": -73.52329, "a": 850,
  "url": "https://ctaudubon.org/locations/deer-pond-farm/",
  "fee": "Free admission", "agency": "Connecticut Audubon Society",
  "note": "15 miles of trails…", "trails": true, "parking": true }
```

**Keeping a place that looks private but isn't** — add its lowercase name to the `ALLOW` set in `app.js` (Westport's Longshore Club Park is the existing example).

---

## 9. Deploying an update

```bash
python3 deploy.py --repo StarrySidekick/EveryPark --source <folder> \
                  --token-file <path-to-token>
```

**Always bump the version number** in `index.html` (`?v=17` → `?v=18`) on the three asset links. GitHub Pages caches assets for ~10 minutes, and without the bump visitors keep running old code — this cost real debugging time before it was fixed.

Allow **2–5 minutes** for the Pages build plus CDN propagation.

**Custom domain:** a `CNAME` file in the repo holds `everypark.starrysidekick.com`, and a matching CNAME record in Squarespace DNS points to `starrysidekick.github.io`.

---

## 10. Known limitations

**Access reflects what OSM has mapped, not ground truth.** A real but unmapped trail reads as "unverified." Since preserves are exactly where mapping is thinnest, treat that flag as *needs checking*, not *don't go*.

**Only 1,647 of 30,334 paths in Connecticut are named.** Many are residential shortcuts and driveways, so the gap finder produces false positives. Investigate clusters that are large, wooded and away from housing.

**One pin per property.** A 16,000-acre state forest gets a single marker at its centroid; its polygon shows the true extent.

**Town beach fees aren't captured.** They vary by town, season and residency, and live on 169 separate town websites.

**"Prettiness" doesn't exist yet.** No dataset covers it — that's an editorial layer you'd write.

**Still excluded:** 163 water-company reserves (permit-only — arguably should be shown with a badge), 365 OSM reserves operated by the State (assumed duplicates), DEP-owned waterbodies, State Park Trails (linear), golf courses.

---

## 11. What's next

**Approved, not yet built:** piers/boardwalks/waterfront, historic museum grounds where the grounds are free, university lands.

**Queued:** DEEP water access & boat launches (129 parcels — data already fetched, just filtered out), water-company lands with a "permit required" badge, the four known federal gaps (Great Meadows Unit in Stratford, Outer Island, Chimon Island, Thomaston Dam).

**Bigger ideas:** genre classification (beach / sports complex / nature preserve / historic site), editorial beauty ratings, town beach fee tables for the ~25 shoreline towns, and trails as their own line-rendered layer.

---

## 12. Companion documents

- **`ct-parks-research-brief.md`** — how Connecticut parks are governed at each level, fees, and where category data can come from
- **`ct-public-land-categories.md`** — every kind of public land in CT, with your approved/rejected decisions recorded
- **`ct-parks-coverage-audit.md`** — the five reasons places were missing, and what remains excluded

### Key sources
- [CGS Title 23, Ch. 447 — State Parks and Forests](https://law.justia.com/codes/connecticut/title-23/chapter-447/) · [Passport to the Parks](https://portal.ct.gov/DEEP/State-Parks/Passport-to-the-Parks)
- [Leydon v. Greenwich](https://caselaw.findlaw.com/court/ct-court-of-appeals/1156438.html)
- [CT DEEP Property layer](https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/Connecticut_DEEP_Property/FeatureServer/0)
- [USGS 3DEP Elevation](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer)
- [CT Land Conservation Council](https://ctconservation.org/find-a-land-trust/) · [USFWS McKinney NWR](https://www.fws.gov/refuge/stewart-b-mckinney) · [USACE New England](https://www.nae.usace.army.mil/Missions/Recreation/Connecticut/)
- OpenStreetMap contributors
