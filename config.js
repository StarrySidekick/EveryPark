/* ============================================================
   CT PARKS EXPLORER — CUSTOMIZATION FILE
   Edit this file to change the look of the site.
   No coding knowledge needed for most tweaks.
   ============================================================ */

const CONFIG = {

  // Site title shown in the header and browser tab
  siteTitle: "Connecticut Parks Explorer",
  tagline: "Every state, national & town park in one map",

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
      label: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
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

  // ---- PARK BOUNDARY OVERLAYS ---------------------------------------
  // Actual park shapes appear when zoomed in to `minZoom` or closer.
  overlays: {
    enabled: true,
    minZoom: 12,
    fillOpacity: 0.28,
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
    cacheDays: 7,
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
      "https://gis1.usgs.gov/arcgis/rest/services/padus4/Public_Access/MapServer/0",
      "https://gis1.usgs.gov/arcgis/rest/services/padus3/Public_Access/MapServer/0",
      "https://gis1.usgs.gov/arcgis/rest/services/padus4/Manager_Name/MapServer/0"
    ],
    matchRadiusM: 500
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
