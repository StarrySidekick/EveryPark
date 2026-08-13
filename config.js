/* ============================================================
   CT PARKS EXPLORER — CUSTOMIZATION FILE
   Edit this file to change the look of the site.
   No coding knowledge needed for most tweaks.
   ============================================================ */

const CONFIG = {

  // Site title shown in the header and browser tab
  siteTitle: "Every Park",
  tagline: "",

  // ---- THE VISUAL SYSTEM ---------------------------------------------
  // Three things encoded at once, so the map answers all three questions
  // without you having to click anything:
  //   FILL   green  = you can go here (solid = open, softer = by permission)
  //   BORDER colour = who owns and maintains it
  //   ICON   glyph  = what kind of place it is
  visual: {
    publicFill: "#5f9c52",        // green: verified — you can go. Includes
                                  // by-permission land; that nuance lives
                                  // on the card, not in the colour.
    // Amber: probably — public or land-trust ground with a legal basis
    // for access, but our research can't 100% confirm a way in yet.
    probablyFill: "#e0a03f",
    // Cemeteries fill purple — the colour of their category — instead of
    // park green; the border still says who owns/runs the ground.
    cemeteryFill: "#8464c9",
    // Grey: unverified — we have no data either way. Deliberately not
    // amber: amber now means "probably yes, by permission", and claiming
    // that for a place with no evidence would be a confident lie.
    unverifiedFill: "#9aa398",
    unverifiedBorder: "#66716b",
    fillOpen: 0.55,
    // Open and open-by-permission look identical: for a walker the
    // practical answer is the same, and the popup explains the nuance.
    fillPermission: 0.55,
    borderWeight: 2.4,            // an ink line on parchment, not a highlighter
                                  // over a photograph — imagery needed 3.1
    // Border colour by owner — brightened so the outline carries at a
    // glance. These are also the marker ring colours.
    owner: {
      state:    "#24603a",        // vivid forest green
      national: "#8a5426",        // warm saddle brown
      town:     "#1f5c96",        // vivid blue
      preserve: "#0f6f7d",        // vivid teal
      cemetery: "#5f3f9e"         // vivid purple
    }
  },

  // ---- HOVER HIGHLIGHT ------------------------------------------------
  // Drawn as its own pass on top of everything else: a white casing, the
  // owner's colour over it, and a brighter fill. Turn the numbers up for a
  // heavier effect, down for a subtler one.
  hover: {
    fill: "#c8f5cf",       // the shape brightens to this while hovered
    fillOpacity: 0.88,     // vs 0.55 normally — a clear, obvious change
    stroke: "#ffffff",     // white outline reads against any imagery
    width: 6               // vs ~1.9 normally
  },

  // ---- MARKER ICONS -------------------------------------------------
  // Each park type points to an image file in the icons/ folder.
  // To use your own graphics: drop a .svg or .png in icons/ and
  // change the path here. Recommended size ~64x64 (rendered at `size`).
  icons: {
    state:    { file: "icons/state.svg",    size: 30 },
    national: { file: "icons/national.svg", size: 32 },
    town:     { file: "icons/town.svg",     size: 24 },
    cemetery: { file: "icons/cemetery.svg", size: 24 },
    preserve: { file: "icons/preserve.svg", size: 26 }
  },

  // ---- COLORS -------------------------------------------------------
  // Used for filter chips, list badges, and marker clusters.
  colors: {
    state:    "#2e7d32",   // green
    national: "#8d5524",   // brown
    town:     "#1565c0",   // blue
    cemetery: "#6b5b8e",   // purple
    preserve: "#00796b",   // teal
    accent:   "#0f4c3a",   // header / highlights
    clusterText: "#ffffff"
  },

  // ---- BASEMAPS ------------------------------------------------------
  // First entry is the default. A switcher control lets visitors flip.
  // labelsUrl (optional) draws place names on top of imagery.
  basemaps: [
    {
      // THE DEFAULT: no photo at all. A flat parchment ground, the mown
      // checkerboard over it, and the park polygons carrying the colour.
      // The 3D viewer's palette, seen from above. `ground` instead of
      // `url` is what marks a basemap as drawn rather than fetched.
      //
      // Why the ground is NOT green, though the site is about grass:
      // green means "verified — you can go here" in this map's colour
      // code. On a green field the verified parks stop reading as parks.
      // The turf character comes from texture, not hue.
      label: "Field guide",
      ground: "#e6e2cf",
      turf: true,
      // Layers that make the drawn ground legible without a photograph.
      // All three are ordinary cached raster tiles, so they need no CORS
      // co-operation — the browser loads them as images.
      shadeUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}",
      shadeOpacity: 0.42,
      // Without this every lake in Connecticut simply vanished: the
      // vector tiles carry no water layer, so on parchment nobody was
      // doing the job the photograph used to do.
      waterUrl: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}",
      roadsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      attribution: "Relief and hydrography: USGS · Boundaries: CT DEEP, OpenStreetMap, USGS PAD-US"
    },
    {
      // USGS's national imagery basemap is built on NAIP: one leaf-on
      // survey, consistent across all of Connecticut at every zoom —
      // no mixed-season patchwork. Native tiles stop at z16; Leaflet
      // upsamples beyond that (maxNativeZoom).
      label: "Satellite (NAIP)",
      url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
      attribution: "Imagery &copy; USGS The National Map (NAIP)",
      maxNativeZoom: 16,
      roadsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      labelsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
    },
    {
      // Esri CLARITY, not Esri World Imagery. Both are Esri, both stay
      // sharp to z19 where NAIP hard-404s above z16 — but World Imagery
      // is a visibly seasonal patchwork and Clarity is not.
      //
      // Measured 2026-08-10, twelve wooded Connecticut tiles at z13,
      // standard deviation of mean green across them (lower = one season
      // everywhere rather than a quilt of acquisition dates):
      //
      //     USGS NAIP      mean green 142.1   SD  7.8    consistent
      //     Esri World      mean green  84.7   SD 13.9    patchy
      //     Esri Clarity    mean green 103.5   SD  7.5    consistent
      //
      // So Clarity is as seasonally even as NAIP and stays sharp three
      // zoom levels further in. Clarity is often an older vintage; that
      // is the trade, and it is the right one here (Timothy, 2026-08-10:
      // "even if it's outdated by a year, i dont mind").
      label: "Satellite (sharp, one season)",
      url: "https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Imagery &copy; Esri Clarity, Maxar, Earthstar Geographics",
      roadsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
      labelsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
    },
    {
      label: "Street map",
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
    }
  ],

  // ---- TOWN BORDER STYLE -------------------------------------------
  townBorders: {
    show: true,
    color: "#ffffff",
    weight: 1,
    opacity: 0.45
  },

  // ---- WHAT THE CATEGORIES MEAN --------------------------------------
  // Shown in the Guide panel and linked from every popup, so the reasoning
  // behind a classification is readable rather than implied. Edit freely —
  // `what` is the definition, `why` explains how a place lands here, and
  // `access` is the legal position.
  categories: [
    {
      id: "state", label: "State land", swatch: "#1b5e20",
      what: "Land owned by a state government. In Connecticut that is CT DEEP — state parks, state forests, wildlife management areas, fish hatcheries, flood-control land and boat launches. In New York it is DEC and State Parks — the Adirondack and Catskill Forest Preserve, state forests, wildlife management areas and unique areas.",
      why: "Classified from each state's own property layer — CT DEEP's in Connecticut, NYS DEC Lands in New York — which is the authoritative record of what that state owns. The sub-label (State Park, State Forest, Forest Preserve, Wildlife Management Area…) comes straight from the agency's own category for that parcel.",
      access: "Public by default, though the rules differ by state and each place's own card is what states them. In Connecticut some parks charge for parking rather than entry — CT-registered vehicles park free under Passport to the Parks, out-of-state vehicles pay. Wildlife management areas in both states are open, but are working conservation land rather than developed parks, and are hunted in season."
    },
    {
      id: "national", label: "Federal land", swatch: "#6d4c41",
      what: "Land owned by the federal government: the National Park Service, US Fish & Wildlife Service, and the Army Corps of Engineers. In Connecticut this is a short list, plus the Appalachian Trail's protective corridor.",
      why: "Taken from a hand-checked list of federal sites, and from ownership codes in USGS PAD-US. The Appalachian Trail corridor appears because the NPS owns that land outright — it is genuinely public, though often only a narrow strip with private property either side.",
      access: "Public by default. Individual refuges and historic sites keep their own hours, and a few have seasonal closures for nesting birds."
    },
    {
      id: "town", label: "Town or city", swatch: "#1565c0",
      what: "Municipal land: town and city parks, greens, recreation areas, town open space and the grounds of historic sites the town maintains.",
      why: "Mostly from OpenStreetMap, filtered to places tagged as publicly accessible, plus municipally owned land recorded in PAD-US. Town greens and recreation grounds are tagged as land use rather than as parks, so they're pulled in separately.",
      access: "Open to everyone. In Connecticut, town parks may not shut out non-residents — settled in Leydon v. Greenwich (2001), which struck down a residents-only beach rule. That is Connecticut case law and does not carry to New York, where a handful of municipalities do restrict beaches to residents. Towns in both states may charge non-residents more, and often do at beaches."
    },
    {
      id: "preserve", label: "Land trust / non-profit", swatch: "#00838f",
      what: "Nature preserves and open space held by land trusts, conservancies, Audubon, universities and similar non-profits.",
      why: "From OpenStreetMap's nature reserves, classified by who operates them, and from PAD-US records where a non-profit owns the land. Water-company watershed land is excluded because it needs a permit, and members-only organisations are excluded entirely.",
      access: "Usually open, but by the owner's permission rather than by legal right. Connecticut's Recreational Use Statute (CGS §§52-557f–i) protects landowners who allow free public recreation, which is why so much of this land is walkable. Respect posted signs — permission can be withdrawn."
    },
    {
      id: "cemetery", label: "Cemetery", swatch: "#5e35b1",
      what: "Municipal and non-profit burying grounds, including Connecticut's colonial-era ancient burying grounds.",
      why: "From OpenStreetMap, excluding anything tagged private. Ones with historic naming — 'burying ground', 'ancient' — are labelled as historic burying grounds.",
      access: "Open during daylight, and they are quiet public green space as well as places of burial. Tribal burial grounds are excluded from this map entirely: they are not visitor destinations."
    }
  ],

  // What's deliberately left off the map, and why. Also shown in the Guide.
  // ---- WHAT KIND OF PLACE IS IT --------------------------------------
  // The other legend answers "who runs it". This one answers "what IS
  // it, and can I usually go?", because the sub-label on a card is a
  // land-management term and most of them do not mean what they sound
  // like. A wildlife management area is open to walk in; a watershed
  // protection area usually is not without a permit; a conservation
  // easement is not a place at all. Ordered roughly by how many places
  // carry each label.
  //
  // `go` is deliberately hedged where the honest answer is hedged. This
  // panel explains a category; the card for an individual place is what
  // states that place's rules, and only when they have been checked.
  kinds: [
    { label: "Nature Preserve / Wildlife Sanctuary", go: "Usually yes, on foot",
      what: "Land held to protect habitat rather than to be used. Trails are often unsurfaced and unsigned, and there may be none at all.",
      note: "Dogs, bikes and horses are restricted more often than in a park. Some preserves close areas seasonally for nesting or to protect a rare species." },
    { label: "Land Trust Preserve", go: "Usually yes, by the owner's permission",
      what: "Owned by a private non-profit land trust, not by the public. Most welcome visitors on foot and say so on their own website.",
      note: "Access is by the owner's goodwill rather than by legal right, and can be withdrawn. This map only turns a land trust green where that trust publishes an open-to-the-public policy we can cite." },
    { label: "Town Open Space / Local conservation area", go: "Usually yes",
      what: "Municipal land kept undeveloped — woods, fields, river frontage. Rarely has facilities beyond a pull-off and a trail.",
      note: "In Connecticut, municipal open space is open to residents and non-residents alike under Leydon v. Greenwich." },
    { label: "Local park / Recreation area", go: "Yes",
      what: "The developed municipal park: playing fields, playgrounds, courts, picnic tables, mown grass.",
      note: "A few town beaches and pools charge non-residents. Paying is fine; belonging is not — anywhere that admits only members is off this map entirely." },
    { label: "State Park", go: "Yes",
      what: "Connecticut's developed state land: swimming, camping, picnicking, marked trails, staffed in season.",
      note: "Entry is free. Some charge for PARKING rather than entry — Connecticut-registered vehicles park free under Passport to the Parks, out-of-state vehicles pay." },
    { label: "State Forest", go: "Yes",
      what: "Working forest owned by the state and managed for timber, water and wildlife as well as recreation. Big, quiet, lightly signed, and often crossed by unpaved forest roads.",
      note: "Open to hunting in season, which is worth knowing before you walk one in autumn. Expect active logging in places." },
    { label: "Wildlife Management Area", go: "Yes, but know what it is",
      what: "Land bought and managed specifically for wildlife and for hunting, fishing and wildlife watching. It is not a developed park: usually no toilets, no marked loop, no mown grass.",
      note: "Open to the public year-round, but hunting is the primary use on much of it. Wear blaze orange in season." },
    { label: "Watershed protection area", go: "Often NOT without a permit",
      what: "Land a water company owns around a reservoir to keep the drinking water clean. Aquarion, the MDC and the South Central Regional Water Authority hold most of it.",
      note: "The most misread label on this map. Some of it is open, some is open only to permit holders, and some is closed outright — and the rule differs by company and by reservoir. Never assume; check the company's own page." },
    { label: "Flood Control Area", go: "Usually yes",
      what: "Army Corps of Engineers land behind a dam, kept empty so it can flood. Often doubles as informal open space with a trail or a boat ramp.",
      note: "Can be closed without notice when water is high." },
    { label: "Boat Launch / Water Access", go: "Yes, for getting to the water",
      what: "A ramp, carry-in path or fishing access point rather than somewhere to spend an afternoon.",
      note: "Some launches charge a seasonal or daily fee for trailered boats." },
    { label: "Coastal Access Site", go: "Yes",
      what: "A point on the Connecticut shoreline that DEEP records as publicly reachable — a beach, pier, walkway or overlook. Many are a single strip of walkway rather than an open space.",
      note: "Facilities and parking are recorded per site and vary enormously; a few charge." },
    { label: "Cemetery / Historic Burying Ground", go: "Yes, in daylight",
      what: "Kept on the map because they are walkable public green space and often the oldest designed landscape in a town. Filterable off if you would rather not see them.",
      note: "Daylight hours, quiet behaviour, and paths rather than plots." },
    { label: "Town Green", go: "Yes",
      what: "The historic common at the centre of a New England town. Small, mown, usually ringed by a road.",
      note: "Public since the town was laid out." },
    { label: "Scenic Reserve / Unique Area", go: "Usually yes",
      what: "Land protected for a particular feature — a gorge, a ridge, a stand of old trees, a waterfall.",
      note: "Often steep or fragile, with the trail kept deliberately narrow." },
    { label: "University Land", go: "Sometimes",
      what: "Forest and field owned by a college, often used for teaching and research.",
      note: "Varies completely by institution. Some run open trail networks; others allow no public entry at all." },
    { label: "Conservation easement", go: "No — this is not a place to visit",
      what: "A legal restriction on what a private owner may build. The land underneath stays private.",
      note: "Listed only so you understand why a name you recognise as a neighbour's farm appears in protected-land data. It confers no right of way." }
  ],

  exclusions: [
    ["Members-only land", "Golf and country clubs, yacht clubs, sportsmen's and rod-and-gun associations, beach and lake associations, homeowners' associations, scout reservations. The test is whether anyone can get in — paying is fine, belonging is not."],
    ["Conservation easements on private land", "An easement restricts what an owner may build. It is not a right of way, and the land underneath stays private. These are recorded under the owner's name, which is why they arrive called things like '44 Sunny Ridge Road, LLC'."],
    ["Private working land", "Farms, ranches and woodlots under agricultural or forest-stewardship easements. Protected, but somebody's livelihood rather than somewhere to visit."],
    ["Tribal reservations and burial grounds", "Connecticut's reservations are sovereign land. Under CGS chapter 824 nobody may enter without the tribe's written permission."],
    ["Land recorded as closed", "Places USGS records as closed to public access."],
    ["Trails on their own", "A trail is a line, not a destination. The Blue-Blazed system is drawn as a layer, but individual paths don't get their own pins."]
  ],

  // ---- THE DATASET ---------------------------------------------------
  // data/places.json is every public place, already classified, enriched
  // and deduplicated. Nothing is fetched from a live service at runtime.
  //
  // Rebuild it with:
  //   python3 buildplaces.py --raw <dir with baked.json + ep-padus.geojson>
  //                          --data data -o data/places.json
  //
  // Bump dataVersion whenever you regenerate it, otherwise browsers will
  // keep serving the copy they already have.
  dataVersion: "20260813",

  // Shown in the top-right corner. Bumped by hand on every code change,
  // so there's visible proof of which build is actually loaded rather
  // than guessing whether a cached copy is being served.
  siteVersion: "v0.50.0",

  // ---- VECTOR TILES --------------------------------------------------
  // Every boundary and trail, pre-cut into map tiles and packed into one
  // file. The map reads only the tiles for what's on screen, using HTTP
  // range requests, so nothing is fetched from a live service as you pan.
  //
  // Regenerate after changing the source data:
  //   1. open tiles.html and download the ep-*.geojson files
  //   2. python3 maketiles.py stage ep-*.geojson --zooms 6 7 8 9 10 11
  //      python3 maketiles.py stage ep-*.geojson --zooms 12 13
  //      python3 maketiles.py stage ep-*.geojson --zooms 14
  //   3. python3 maketiles.py pack -o data/everypark.pmtiles
  //
  // Set enabled:false to fall back to the old live per-viewport fetching.
  vectorTiles: {
    enabled: true,
    url: "data/everypark.pmtiles",
    // Highest zoom the archive actually contains. Beyond this the same
    // tiles are stretched, which is why the map still draws when you zoom
    // right in. Must match --maxzoom used when building.
    maxDataZoom: 14
  },

  // ---- PUBLIC LAND — THE MAIN EVENT -----------------------------------
  // The whole point of the map: at a glance, what's public and what isn't.
  // All 491 state-owned parcels load in one request and stay visible at
  // every zoom, so the public/private pattern reads statewide. Anything
  // NOT tinted is private land.
  publicLand: {
    enabled: true,
    url: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/Connecticut_DEEP_Property/FeatureServer/0/query",
    simplify: "0.0005",
    fillOpacity: 0.42,
    weight: 0.8,
    showLegend: true
  },

  // ---- PARK BOUNDARY OVERLAYS ---------------------------------------
  // Local detail — town, preserve and cemetery shapes, loaded per view.
  overlays: {
    enabled: true,
    minZoom: 11,
    fillOpacity: 0.38,
    stateUrl: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/Connecticut_DEEP_Property/FeatureServer/0/query"
  },

  // ---- TRAIL LINES ---------------------------------------------------
  // Actual walking routes drawn under the park shapes. Loaded for the
  // current view only, so detail stays high without slowing the map.
  trailLines: {
    enabled: true,
    minZoom: 13,
    color: "#ffd24a",      // warm yellow reads well on satellite
    weight: 2,
    opacity: 0.9,
    dashArray: "5,4"
  },

  // ---- MUNICIPAL PARKS LIVE DATA -----------------------------------
  // Town parks are pulled live from OpenStreetMap (via Esri's mirror)
  // and cached in the visitor's browser for `cacheDays` days.
  municipal: {
    enabled: true,
    // How long a visitor's browser keeps the downloaded data before
    // refreshing it. Long, because this land doesn't move.
    cacheDays: 30,
    serviceUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Leisure/FeatureServer/0/query"
  },

  // ---- CEMETERIES & BURYING GROUNDS --------------------------------
  // Public land that isn't a park. Loaded live from OpenStreetMap.
  cemeteries: {
    enabled: true,
    serviceUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Landuse/FeatureServer/0/query"
  },

  // ---- PAD-US (USGS Protected Areas Database) ------------------------
  // The national inventory of protected land. Public domain. Carries an
  // official Public Access rating (Open / Restricted / Closed) plus owner
  // and manager names — the authoritative answer to "can I go here?".
  //
  // As of July 2026 USGS's own service is returning SITE_NOT_INITIALIZED
  // and Esri's hosted copy needs a token, so this is DORMANT: it probes
  // each endpoint on load, uses the first that returns Connecticut data,
  // and silently does nothing if none respond. Add endpoints here as
  // they appear — no other code changes needed.
  padus: {
    enabled: true,
    endpoints: [
      // Esri Living Atlas copy — public, no token, national coverage.
      "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Name_PADUS/FeatureServer/0",
      // USGS's own service, if it ever comes back up.
      "https://gis1.usgs.gov/arcgis/rest/services/padus4/Public_Access/MapServer/0"
    ],
    matchRadiusM: 500,
    // Draw PAD-US polygons coloured by official access level.
    showLayer: true,
    minZoom: 11,
    colors: { OA: "#2e9e4f", RA: "#e8a33d", XA: "#c0392b", UK: "#8e9a93" }
  },

  // ---- PROTECTED OPEN SPACE PARCELS ----------------------------------
  // CT DEEP's parcel-level map of protected land. It has no owner names,
  // so it can't create places on its own — but it shows the true extent
  // of protected land, including parcels nothing else has a name for.
  // Useful where a place is only a point (hand-added, or unmapped).
  protectedParcels: {
    enabled: true,
    url: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/Connecticut_Parcels_for_Protected_Open_Space_Mapping/FeatureServer/0/query",
    minZoom: 13,
    color: "#ff9800",
    weight: 1.4,
    fillOpacity: 0.14
  },

  // ---- BLUE-BLAZED HIKING TRAILS -------------------------------------
  // The CFPA system: ~825 miles, running since 1929. Much of it crosses
  // PRIVATE land by easement or landowner permission — the footpath is
  // public, the land beside it usually isn't. Drawn in blaze blue.
  blueBlazed: {
    enabled: true,
    url: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/ArcGIS/rest/services/BlueBlazedHikingTrails/FeatureServer/0/query",
    color: "#2f6fed",
    weight: 2.6,
    opacity: 0.95,
    minZoom: 9
  },

  // ---- BOAT LAUNCHES & WATER ACCESS ----------------------------------
  boatLaunches: {
    enabled: true,
    url: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/ArcGIS/rest/services/DEEP_State_Trailered_Boat_Launches/FeatureServer/0/query",
    // Canoe/kayak-only access points are a separate DEEP dataset.
    cartopUrl: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/ArcGIS/rest/services/DEEP_State_Cartop_Boat_Launches/FeatureServer/0/query"
  },

  // ---- MUSEUM & HISTORIC SITE GROUNDS --------------------------------
  museums: {
    enabled: true,
    url: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Tourism/FeatureServer/0/query"
  },

  // ---- OTHER STATE LAND ---------------------------------------------
  // DEEP owns far more than parks and forests. Wildlife Management
  // Areas alone are 30,000+ acres of public land, all open for hiking.
  stateExtra: {
    enabled: true,
    url: "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/Connecticut_DEEP_Property/FeatureServer/0/query",
    legends: ["Wildlife Area", "Wildlife Sanctuary", "Flood Control", "Fish Hatchery"],
    minAcres: 5
  },

  // ---- OTHER MUNICIPAL LAND ------------------------------------------
  // Town greens and recreation grounds are tagged as landuse, not
  // leisure, so they were invisible to the park query.
  extraLanduse: {
    enabled: true,
    url: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Landuse/FeatureServer/0/query",
    kinds: ["recreation_ground", "village_green", "forest"]
  },

  // ---- LAND TRUST PRESERVES & OPEN SPACE ---------------------------
  // Nature reserves from OpenStreetMap, split by who runs them:
  // land trusts / conservancies get their own layer; town-run open
  // space folds into the Town layer. State-run duplicates are skipped.
  preserves: {
    enabled: true,
    serviceUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Leisure/FeatureServer/0/query"
  },

  // ---- ATTRIBUTE ENRICHMENT (sports, trails, water) ----------------
  // Also pulled live from OpenStreetMap mirrors and cached in-browser.
  enrichment: {
    enabled: true,
    trailsUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Trails/FeatureServer/0/query",
    waterUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Water/FeatureServer/0/query",
    poisUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_POIs/FeatureServer/0/query"
  },

  // ---- CAN YOU ACTUALLY GO THERE? -----------------------------------
  // Plenty of preserves are legally open but have no trail, no parking
  // and no realistic way in. We check for mapped trails and public
  // parking and label each place accordingly.
  access: {
    enabled: true,
    parkingRadiusM: 400   // how close public parking must be to count
  },

  // ---- TERRAIN (on demand) ------------------------------------------
  // USGS 3DEP elevation, sampled when a popup is opened (about 2-5 s).
  // Too slow to run for every place up front, so it loads lazily.
  terrain: {
    enabled: true,
    url: "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples"
  },

  // Map start position (Connecticut)
  mapCenter: [41.55, -72.7],
  mapZoom: 9
};
