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
    town:     { file: "icons/town.svg",     size: 24 }
  },

  // ---- COLORS -------------------------------------------------------
  // Used for filter chips, list badges, and marker clusters.
  colors: {
    state:    "#2e7d32",   // green
    national: "#8d5524",   // brown
    town:     "#1565c0",   // blue
    accent:   "#0f4c3a",   // header / highlights
    clusterText: "#ffffff"
  },

  // ---- BASEMAP ------------------------------------------------------
  // Swap the map background by changing `url`. Free options:
  //  Carto Voyager (default):
  //    https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png
  //  Carto Positron (minimal light):
  //    https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png
  //  Carto Dark:
  //    https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png
  //  OpenStreetMap classic:
  //    https://tile.openstreetmap.org/{z}/{x}/{y}.png
  //  OpenTopoMap (terrain):
  //    https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png
  basemap: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
  },

  // ---- TOWN BORDER STYLE -------------------------------------------
  townBorders: {
    show: true,
    color: "#9aa5a0",
    weight: 1,
    opacity: 0.5
  },

  // ---- MUNICIPAL PARKS LIVE DATA -----------------------------------
  // Town parks are pulled live from OpenStreetMap (via Esri's mirror)
  // and cached in the visitor's browser for `cacheDays` days.
  municipal: {
    enabled: true,
    cacheDays: 7,
    serviceUrl: "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Leisure/FeatureServer/0/query"
  },

  // Map start position (Connecticut)
  mapCenter: [41.55, -72.7],
  mapZoom: 9
};
