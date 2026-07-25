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
    cemetery: { file: "icons/cemetery.svg", size: 24 }
  },

  // ---- COLORS -------------------------------------------------------
  // Used for filter chips, list badges, and marker clusters.
  colors: {
    state:    "#2e7d32",   // green
    national: "#8d5524",   // brown
    town:     "#1565c0",   // blue
    cemetery: "#6b5b8e",   // purple
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

  // ---- ATTRIBUTE ENRICHMENT (sports, trails, water) ----------------
  // Also pulled live from OpenStreetMap mirrors and cached in-browser.
  enrichment: {
    enabled: true,
    trailsUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Trails/FeatureServer/0/query",
    waterUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Water/FeatureServer/0/query"
  },

  // Map start position (Connecticut)
  mapCenter: [41.55, -72.7],
  mapZoom: 9
};
