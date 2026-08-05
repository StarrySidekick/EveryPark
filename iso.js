/* ============================================================
   EVERYPARK — ISOMETRIC TERRAIN VIEW, v3

   Opens from the 3D terrain button on a place card. Renders the real
   boundary as a Minecraft-style floating island and dresses it with
   everything we can fetch about the place:

   - Boundary: point-in-polygon against CT DEEP / OSM mirrors / PAD-US.
   - Elevation: AWS Terrain Tiles (terrarium); procedural fallback.
   - Trails (OSM + Blue-Blazed) as worn tan paths; water flattened blue.
   - Roads, buildings and parking lots from one Overpass query: roads
     asphalt grey, buildings extruded blocks, parking pads marked.
   - Sport courts from the OSM leisure layer, sport-coloured with a
     drawn sprite each.
   - A little pixel-art hiker walking the longest trail, because it's
     cute.
   - Time-of-day toggle (day / sunset / night), satellite drape toggle,
     and PNG export of the canvas.

   PROGRESSIVE: terrain draws the moment heights arrive; trails, roads,
   buildings and courts stream in when their fetches land. Everything
   is click-time only and best-effort — a failed fetch just means that
   layer doesn't appear.
   ============================================================ */

const EveryParkIso = (() => {
  const TILE = z => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/`;
  const OSM6 = "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/";
  const DEEP = "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/arcgis/rest/services/";
  const PADUS = "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/" +
                "Manager_Name_PADUS/FeatureServer/0/query";
  // Grid density scales with park size (set per open): a 2,000-acre
  // forest needs far more cells than a village green for the same detail.
  let GRID = 104;

  let raf = null;

  const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const hexRgb = h => [parseInt(h.slice(1, 3), 16),
                       parseInt(h.slice(3, 5), 16),
                       parseInt(h.slice(5, 7), 16)];
  // `rgb(...)` template literals were being built tens of thousands of
  // times a frame. The terrain palette is small and repeats heavily, so
  // memoising the strings removes most of that allocation churn.
  const colCache = new Map();
  const rgbStr = (r, g, b) => {
    const k = (((r < 0 ? 0 : r > 255 ? 255 : r) | 0) << 16)
            | (((g < 0 ? 0 : g > 255 ? 255 : g) | 0) << 8)
            | ((b < 0 ? 0 : b > 255 ? 255 : b) | 0);
    let v = colCache.get(k);
    if (v === undefined) {
      if (colCache.size > 8192) colCache.clear();
      v = `rgb(${(k >> 16) & 255},${(k >> 8) & 255},${k & 255})`;
      colCache.set(k, v);
    }
    return v;
  };

  const hash = (gx, gy) => {
    let h = (gx * 73856093) ^ (gy * 19349663);
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };

  async function arc(url, params) {
    const body = new URLSearchParams({ f: "json", ...params });
    const r = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "service error");
    return j.features || [];
  }

  // ---- Sport courts: colour code + emoji per sport ----------------
  const SPORT = [
    [/baseball|softball/, 2, "#d9c186", "baseball"],
    [/basketball/,        3, "#6b7d99", "basketball"],
    [/tennis/,            4, "#b85c48", "tennis"],
    [/pickleball/,        5, "#4f9d8b", "pickleball"],
    [/soccer|football/,   6, "#5c9e57", "soccer"],
    [/volleyball/,        7, "#c9a86b", "volleyball"],
    [/./,                 8, "#7fa06f", "pitch"]
  ];
  const KIND = { playground: [9, "#d99a4e", "playground"],
                 swimming_pool: [10, "#4fa3c9", "pool"],
                 dog_park: [11, "#a08a6b", "dogpark"],
                 track: [12, "#b0876b", "track"] };
  const COURT_COLOR = {};
  for (const [, code, col] of SPORT) COURT_COLOR[code] = col;
  for (const k in KIND) COURT_COLOR[KIND[k][0]] = KIND[k][1];

  // ---- Boundary ---------------------------------------------------
  async function fetchBoundary(p) {
    const pt = JSON.stringify({ x: p.lng, y: p.lat,
                                spatialReference: { wkid: 4326 } });
    const common = { geometry: pt, geometryType: "esriGeometryPoint",
                     inSR: "4326", outSR: "4326",
                     spatialRel: "esriSpatialRelIntersects",
                     returnGeometry: "true", maxAllowableOffset: "0.00005" };
    const sources = [
      { url: DEEP + "Connecticut_DEEP_Property/FeatureServer/0/query",
        field: "PROPERTY", label: "CT DEEP" },
      { url: OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
        field: "name", label: "OpenStreetMap" },
      { url: OSM6 + "OSM_NA_Landuse/FeatureServer/0/query",
        field: "name", label: "OpenStreetMap" },
      { url: PADUS, field: "Unit_Nm", label: "USGS PAD-US" }
    ];
    const results = await Promise.allSettled(sources.map(s =>
      arc(s.url, { ...common, outFields: s.field }).then(feats =>
        feats.filter(f => f.geometry && f.geometry.rings)
             .map(f => ({ rings: f.geometry.rings,
                          name: f.attributes && f.attributes[s.field],
                          label: s.label })))));
    const cands = results.flatMap(r => r.status === "fulfilled" ? r.value : []);
    if (!cands.length) return null;
    const area = c => Math.abs(c.rings.reduce((s2, ring) => {
      let a = 0;
      for (let i = 0; i < ring.length - 1; i++)
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      return s2 + a / 2;
    }, 0));
    const wanted = new Set([norm(p.name), ...(p.aka || []).map(norm)]);
    const named = cands.filter(c => wanted.has(norm(c.name)));
    const pool = named.length ? named : cands;
    pool.sort((a, b) => named.length ? area(b) - area(a) : area(a) - area(b));
    return pool[0];
  }

  // ---- Elevation & imagery ----------------------------------------
  function tileXY(lat, lng, z) {
    const n = 2 ** z;
    const latR = lat * Math.PI / 180;
    return { x: (lng + 180) / 360 * n,
             y: (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n };
  }
  const loadImage = url => new Promise((res, rej) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => res(im); im.onerror = rej; im.src = url;
  });

  async function sampleTiles(bbox, urlFor, maxTiles, zoom) {
    const [w, s, e, n] = bbox;
    const tl = tileXY(n, w, zoom), br = tileXY(s, e, zoom);
    const x0 = Math.floor(tl.x), y0 = Math.floor(tl.y);
    const cols = Math.floor(br.x) - x0 + 1, rows = Math.floor(br.y) - y0 + 1;
    if (cols * rows > maxTiles) throw new Error("area too large");
    const cv = document.createElement("canvas");
    cv.width = cols * 256; cv.height = rows * 256;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    await Promise.all([...Array(cols * rows)].map((_, i) => {
      const tx = x0 + (i % cols), ty = y0 + Math.floor(i / cols);
      return loadImage(urlFor(zoom, tx, ty))
        .then(im => cx.drawImage(im, (tx - x0) * 256, (ty - y0) * 256));
    }));
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    return { px, w: cv.width, h: cv.height, x0, y0, zoom };
  }

  const gridToLL = (bbox, gx, gy) => {
    const [w, s, e, n] = bbox;
    return [w + (e - w) * gx / (GRID - 1), n - (n - s) * gy / (GRID - 1)];
  };

  // Height tiles are fetched once and kept as a sample; changing the
  // block-size slider just re-reads them at the new grid — no refetch.
  async function fetchHeightSample(bbox) {
    const [w, s, e, n] = bbox;
    const spanM = Math.max((e - w) * 111320 * Math.cos(s * Math.PI / 180),
                           (n - s) * 111320);
    const z = spanM > 3000 ? 12 : spanM > 1200 ? 13 : 14;
    return sampleTiles(bbox, (zz, tx, ty) => `${TILE(zz)}${tx}/${ty}.png`, 12, z);
  }

  function heightsFrom(t, bbox) {
    const H = new Float32Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const [lng, lat] = gridToLL(bbox, gx, gy);
        const tt = tileXY(lat, lng, t.zoom);
        const ix = Math.min(t.w - 1, Math.max(0, Math.round((tt.x - t.x0) * 256)));
        const iy = Math.min(t.h - 1, Math.max(0, Math.round((tt.y - t.y0) * 256)));
        const k = (iy * t.w + ix) * 4;
        H[gy * GRID + gx] = t.px[k] * 256 + t.px[k + 1] + t.px[k + 2] / 256 - 32768;
      }
    return H;
  }

  // Imagery, in preference order:
  // 1. USGS NAIP — one consistent LEAF-ON summer survey across all of
  //    Connecticut (public domain). A season is a property of the whole
  //    dataset, so trees read as trees everywhere.
  // 2. Esri World Imagery tiles — sharper but a mixed-season mosaic.
  async function fetchSatSample(bbox) {
    const [w, s, e, n] = bbox;
    try {
      const url = "https://imagery.nationalmap.gov/arcgis/rest/services/" +
        "USGSNAIPImagery/ImageServer/exportImage?f=image&format=jpgpng" +
        `&bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=768,768`;
      const im = await loadImage(url);
      const cv = document.createElement("canvas");
      cv.width = im.width; cv.height = im.height;
      const cx = cv.getContext("2d", { willReadFrequently: true });
      cx.drawImage(im, 0, 0);
      const px = cx.getImageData(0, 0, cv.width, cv.height).data;
      // A failed export can come back as a tiny black png — reject it.
      let lit = 0;
      for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 30) lit++;
      if (lit < 10) throw new Error("blank NAIP export");
      return { mode: "linear", px, w: cv.width, h: cv.height, bbox,
               label: "NAIP (leaf-on)" };
    } catch (e) { /* fall through to Esri */ }
    const spanM = Math.max((e - w) * 111320 * Math.cos(s * Math.PI / 180),
                           (n - s) * 111320);
    const z = Math.max(13, Math.min(17, Math.round(17 - Math.log2(spanM / 700))));
    const t = await sampleTiles(bbox, (zz, tx, ty) =>
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/" +
      `MapServer/tile/${zz}/${ty}/${tx}`, 20, z);
    t.mode = "tile"; t.label = "Esri imagery";
    return t;
  }

  function satTexFrom(t, bbox) {
    const tex = new Uint8ClampedArray(GRID * GRID * 3);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        let ix, iy;
        if (t.mode === "linear") {
          const [w, s2, e2, n2] = t.bbox;
          const [lng, lat] = gridToLL(bbox, gx, gy);
          ix = Math.min(t.w - 1, Math.max(0, Math.round((lng - w) / (e2 - w) * (t.w - 1))));
          iy = Math.min(t.h - 1, Math.max(0, Math.round((n2 - lat) / (n2 - s2) * (t.h - 1))));
        } else {
          const [lng, lat] = gridToLL(bbox, gx, gy);
          const tt = tileXY(lat, lng, t.zoom);
          ix = Math.min(t.w - 1, Math.max(0, Math.round((tt.x - t.x0) * 256)));
          iy = Math.min(t.h - 1, Math.max(0, Math.round((tt.y - t.y0) * 256)));
        }
        const k = (iy * t.w + ix) * 4, o = (gy * GRID + gx) * 3;
        tex[o] = t.px[k]; tex[o + 1] = t.px[k + 1]; tex[o + 2] = t.px[k + 2];
      }
    return tex;
  }

  function proceduralHeights(p) {
    const A = p.attrs || {};
    const base = A.elev != null ? A.elev : 120;
    const relief = A.relief != null ? A.relief : 30;
    const H = new Float32Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const u = gx / GRID * 4, v = gy / GRID * 4;
        H[gy * GRID + gx] = base
          + relief * .5 * (Math.sin(u * 1.7 + 1) * Math.cos(v * 1.3)
                           + .5 * Math.sin(u * 3.1) * Math.sin(v * 2.3));
      }
    return H;
  }

  // ---- Rasterise helpers ------------------------------------------
  function insideRings(rings, x, y) {
    let inside = false;
    for (const ring of rings)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if ((yi > y) !== (yj > y) &&
            x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
    return inside;
  }

  // Scanline fill: O(rows × vertices) instead of testing every cell
  // against every edge — the per-cell version froze the tab for many
  // seconds on big multi-thousand-vertex boundaries like state forests.
  function maskFromRings(rings, bbox) {
    const M = new Uint8Array(GRID * GRID);
    const [w, s, e, n] = bbox;
    for (let gy = 0; gy < GRID; gy++) {
      const lat = n - (n - s) * gy / (GRID - 1);
      const xs = [];
      for (const ring of rings)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const yi = ring[i][1], yj = ring[j][1];
          if ((yi > lat) !== (yj > lat))
            xs.push(ring[i][0] + (ring[j][0] - ring[i][0]) * (lat - yi) / (yj - yi));
        }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const g0 = Math.max(0, Math.ceil((xs[k] - w) / (e - w) * (GRID - 1)));
        const g1 = Math.min(GRID - 1, Math.floor((xs[k + 1] - w) / (e - w) * (GRID - 1)));
        for (let gx = g0; gx <= g1; gx++) M[gy * GRID + gx] = 1;
      }
    }
    return M;
  }

  function cellOf(bbox, lng, lat) {
    const [w, s, e, n] = bbox;
    return [Math.round((lng - w) / (e - w) * (GRID - 1)),
            Math.round((n - lat) / (n - s) * (GRID - 1))];
  }

  function rasterisePaths(features, bbox, M) {
    for (const f of features) {
      const paths = (f.geometry && f.geometry.paths) || [];
      for (const path of paths)
        for (let i = 0; i < path.length - 1; i++) {
          const [x1, y1] = cellOf(bbox, path[i][0], path[i][1]);
          const [x2, y2] = cellOf(bbox, path[i + 1][0], path[i + 1][1]);
          const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
          for (let t = 0; t <= steps; t++) {
            const gx = Math.round(x1 + (x2 - x1) * t / steps);
            const gy = Math.round(y1 + (y2 - y1) * t / steps);
            if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID)
              M[gy * GRID + gx] = 1;
          }
        }
    }
  }

  // Snap a sprite to the nearest island cell so a court whose centroid
  // rounds just outside the boundary still shows.
  function snapInside(inside, gx, gy) {
    if (gx >= 0 && gy >= 0 && gx < GRID && gy < GRID && inside[gy * GRID + gx])
      return [gx, gy];
    for (let r = 1; r <= 4; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID
              && inside[ny * GRID + nx]) return [nx, ny];
        }
    return null;
  }

  // ---- Overpass: roads + buildings + parking in one query ---------
  // Which public buildings are worth naming on the ground. Ordered by
  // how much a walker cares: the library is the point of a town centre in
  // a way the fire station is not.
  const PUBLIC_AMENITY = {
    library: "library", townhall: "townhall", museum: "museum",
    community_centre: "community", arts_centre: "museum", theatre: "museum",
    post_office: "post", school: "school", college: "school",
    university: "school", place_of_worship: "worship",
    fire_station: "civic", police: "civic", courthouse: "civic",
    hospital: "civic", clinic: "civic"
  };
  const PUBLIC_RANK = { library: 0, townhall: 1, museum: 2, community: 3,
                        post: 4, worship: 5, school: 6, civic: 7 };

  async function fetchOverpass(bbox) {
    const [w, s, e, n] = bbox;
    const amen = Object.keys(PUBLIC_AMENITY).join("|");
    const q = `[out:json][timeout:12];(` +
      `way[highway~"^(motorway|trunk|primary|secondary|tertiary|` +
      `unclassified|residential|service|living_street)$"](${s},${w},${n},${e});` +
      `way[building](${s},${w},${n},${e});` +
      `way[amenity=parking](${s},${w},${n},${e});` +
      `node[amenity~"^(${amen})$"](${s},${w},${n},${e});` +
      `way[amenity~"^(${amen})$"](${s},${w},${n},${e});` +
      `);out geom 700;`;
    // Mirrors: the main endpoint rate-limits and times out often, which
    // silently cost every road on the island while ArcGIS-sourced trails
    // kept working — the "roads broken on some maps" report.
    const ENDPOINTS = ["https://overpass-api.de/api/interpreter",
                       "https://overpass.kumi.systems/api/interpreter",
                       "https://overpass.osm.jp/api/interpreter"];
    let j = null, lastErr = null;
    for (const url of ENDPOINTS) {
      try {
        const r = await fetch(url, { method: "POST",
          body: "data=" + encodeURIComponent(q),
          headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (!r.ok) throw new Error("HTTP " + r.status);
        j = await r.json();
        if (j && j.elements) break;
      } catch (e) { lastErr = e; j = null; }
    }
    if (!j) throw lastErr || new Error("no overpass endpoint answered");
    const roads = [], buildings = [], parking = [], publics = [];
    for (const el of j.elements || []) {
      const tags = el.tags || {};
      const kind = PUBLIC_AMENITY[tags.amenity];
      if (kind) {
        // Nodes carry lat/lon directly; ways only have geometry, so take
        // the middle of the ring as a good-enough doorstep.
        let lon = el.lon, lat = el.lat;
        if (lon == null && el.geometry && el.geometry.length) {
          const g = el.geometry;
          lon = g.reduce((a, q) => a + q.lon, 0) / g.length;
          lat = g.reduce((a, q) => a + q.lat, 0) / g.length;
        }
        if (lon != null) publics.push({ lon, lat, kind, name: tags.name || "" });
        if (!tags.building) continue;
      }
      if (!el.geometry) continue;
      const pts = el.geometry.map(g => [g.lon, g.lat]);
      if (tags.building) buildings.push([pts]);
      else if (tags.amenity === "parking") parking.push([pts]);
      else if (tags.highway) roads.push({ geometry: { paths: [pts] } });
    }
    return { roads, buildings, parking, publics };
  }

  // ---- Trails + water + courts (ArcGIS) + Overpass extras ---------
  // Fetch once, keep the raw geometry; rasterising to the current grid
  // is a separate step so the block-size slider can rebuild instantly.
  async function fetchRawDressing(bbox) {
    const [w, s, e, n] = bbox;
    const env = JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n,
                                 spatialReference: { wkid: 4326 } });
    const common = { geometry: env, geometryType: "esriGeometryEnvelope",
                     inSR: "4326", outSR: "4326", outFields: "",
                     returnGeometry: "true", maxAllowableOffset: "0.00008",
                     resultRecordCount: "400" };
    const [trails, blue, water, leisure, over] = await Promise.allSettled([
      arc(OSM6 + "OSM_NA_Trails/FeatureServer/0/query",
          { ...common, where: "highway IN ('path','track','bridleway')" }),
      arc(DEEP + "BlueBlazedHikingTrails/FeatureServer/0/query",
          { ...common, where: "1=1" }),
      arc(OSM6 + "OSM_NA_Water/FeatureServer/0/query", { ...common, where: "1=1" }),
      arc(OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
          { ...common, outFields: "leisure,sport",
            where: "leisure IN ('pitch','playground','swimming_pool'," +
                   "'dog_park','track')" }),
      fetchOverpass(bbox)
    ]);
    const val = r => r.status === "fulfilled" ? r.value : [];
    const raw = {
      trailFeats: [...val(trails), ...val(blue)],
      waterRings: val(water).filter(f => f.geometry && f.geometry.rings)
                            .map(f => f.geometry.rings),
      courts: val(leisure).filter(f => f.geometry && f.geometry.rings)
        .map(f => {
          const a = f.attributes || {};
          if (a.leisure === "pitch") {
            const sport = String(a.sport || "").toLowerCase();
            const hit = SPORT.find(([re]) => re.test(sport)) || SPORT[SPORT.length - 1];
            return { rings: f.geometry.rings, code: hit[1], emoji: hit[3] };
          }
          if (KIND[a.leisure])
            return { rings: f.geometry.rings, code: KIND[a.leisure][0],
                     emoji: KIND[a.leisure][2] };
          return null;
        }).filter(Boolean),
      roads: [], buildings: [], parking: [], publics: []
    };
    if (over.status === "fulfilled") {
      raw.roads = over.value.roads;
      raw.buildings = over.value.buildings;
      raw.parking = over.value.parking;
      raw.publics = over.value.publics || [];
    }
    return raw;
  }

  // ---- NLCD: what the ground actually is ---------------------------
  // The pipeline already samples NLCD per place for the cover LABEL;
  // this fetches the same MRLC raster for the park's bbox so each CELL
  // knows its class — wetland, sand, meadow, scrub, crops, developed —
  // and the ground can show it. Needs mrlc.gov to allow cross-origin
  // reads; if it doesn't, everything degrades to the uniform palette.
  const NLCD_RGB = [
    [70, 107, 159, 11], [222, 197, 197, 21], [217, 146, 130, 22],
    [235, 0, 0, 23], [171, 0, 0, 24], [179, 172, 159, 31],
    [104, 171, 95, 41], [28, 95, 44, 42], [181, 197, 143, 43],
    [147, 204, 147, 51], [204, 184, 121, 52], [223, 223, 194, 71],
    [220, 217, 57, 81], [171, 108, 40, 82], [184, 217, 235, 90],
    [108, 159, 184, 95]];
  function nlcdClassOf(r, g, b) {
    let best = 0, bd = 46 * 46 * 3;
    for (const [cr, cg, cb, cls] of NLCD_RGB) {
      const d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb);
      if (d < bd) { bd = d; best = cls; }
    }
    return best;
  }
  async function fetchCoverGrid(bbox) {
    const [w, s, e, n] = bbox;
    const url = "https://www.mrlc.gov/geoserver/mrlc_display/wms?service=WMS" +
      "&version=1.1.1&request=GetMap&layers=NLCD_2021_Land_Cover_L48" +
      "&styles=&srs=EPSG:4326&format=image/png" +
      `&bbox=${w},${s},${e},${n}&width=128&height=128`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("nlcd " + r.status);
    const bmp = await createImageBitmap(await r.blob());
    const cv = document.createElement("canvas");
    cv.width = bmp.width; cv.height = bmp.height;
    const c2 = cv.getContext("2d");
    c2.drawImage(bmp, 0, 0);
    const d = c2.getImageData(0, 0, cv.width, cv.height);
    return { px: d.data, w: cv.width, h: cv.height };
  }
  // Rasterise the sample onto the CURRENT grid (row 0 = north in both).
  function coverGridFrom(cg, bbox) {
    const M = new Uint8Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const sx = Math.min(cg.w - 1, (gx / (GRID - 1) * (cg.w - 1)) | 0);
        const sy = Math.min(cg.h - 1, (gy / (GRID - 1) * (cg.h - 1)) | 0);
        const o = (sy * cg.w + sx) * 4;
        if (cg.px[o + 3] < 60) continue;
        M[gy * GRID + gx] = nlcdClassOf(cg.px[o], cg.px[o + 1], cg.px[o + 2]);
      }
    return M;
  }
  // Ground tints per class, blended into the height palette BEFORE the
  // season and time-of-day transforms so autumn wetlands still turn.
  // Forest classes carry no tint — the palette already is forest.
  const COVER_TINT = {
    21: [168, 166, 158], 22: [162, 160, 154], 23: [156, 154, 150],
    24: [150, 148, 144], 31: [199, 182, 143], 51: [142, 152, 96],
    52: [142, 152, 96], 71: [173, 180, 112], 81: [166, 178, 104],
    82: [187, 168, 104], 90: [70, 102, 88], 95: [112, 130, 86] };
  // Where trees should NOT be invented by the uniform-cover fallback.
  // A real canopy mask (from imagery) overrides this — it has seen the
  // actual trees.
  const COVER_NO_TREES = new Set([95, 31, 82, 22, 23, 24]);

  // ---- GNIS: the names of the land itself --------------------------
  // Summits, ridges, gaps and cliffs from the Landforms layer (5);
  // lakes, reservoirs, swamps and falls from Other Hydrographic (7).
  // GNIS is the federal gazetteer — the same names USGS prints on its
  // topo maps, from the same nationalmap.gov family the elevation and
  // imagery already come from.
  async function fetchNames(bbox) {
    const [w, s, e, n] = bbox;
    const env = JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n,
                                 spatialReference: { wkid: 4326 } });
    const common = { geometry: env, geometryType: "esriGeometryEnvelope",
                     inSR: "4326", outSR: "4326",
                     spatialRel: "esriSpatialRelIntersects",
                     outFields: "gaz_name,gaz_featureclass",
                     returnGeometry: "true", resultRecordCount: "40" };
    const GAZ = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/";
    const [land, hydro] = await Promise.allSettled([
      arc(GAZ + "5/query", { ...common, where: "1=1" }),
      arc(GAZ + "7/query", { ...common, where:
        "gaz_featureclass IN ('Lake','Reservoir','Falls','Swamp','Bay','Beach')" })
    ]);
    const val = r => r.status === "fulfilled" ? r.value : [];
    const out = [];
    for (const f of [...val(land), ...val(hydro)]) {
      const a = f.attributes || {};
      const g = f.geometry || {};
      // The gazetteer layers are multipoint; be tolerant of plain points.
      const pt = (g.points && g.points[0]) || (g.x != null ? [g.x, g.y] : null);
      if (!pt || !a.gaz_name) continue;
      out.push({ name: a.gaz_name, cls: a.gaz_featureclass || "",
                 water: /Lake|Reservoir|Falls|Swamp|Bay|Beach|Spring/i
                        .test(a.gaz_featureclass || ""),
                 lng: pt[0], lat: pt[1] });
    }
    return out;
  }

  // ---- Park lore ---------------------------------------------------
  // What this place actually IS, in the viewer, as game dialogue.
  //
  // Three sources, tried in order and merged, because no single one
  // covers 7,727 places:
  //
  //   1. OpenStreetMap tags on the park's own polygon. The only live
  //      source for RULES — hours, dogs, fee — and the only reliable
  //      way to find the right Wikipedia article, because its
  //      `wikipedia`/`wikidata` tag is an editor's assertion rather
  //      than our guess.
  //   2. Wikipedia's REST summary: history and general facts.
  //   3. The record we already hold. This one cannot fail, so the
  //      panel is never empty — which is the whole reason it exists,
  //      since most town parks will never have an article.
  //
  // Nothing here is baked. Baking 7,727 summaries by hand was the
  // alternative and it does not finish.
  //
  // A WRONG article is worse than none. "Memorial Park" matches a
  // hundred articles nationwide, and this project's whole history of
  // bugs is output that looked completely reasonable. So a match that
  // did not come from an OSM tag must clear BOTH a distance gate and a
  // name gate before it is allowed to say anything.

  const LORE_KM = 4;          // an unlinked article this far off is not this park
  const LORE_TIMEOUT = 9000;

  function kmApart(aLat, aLng, bLat, bLng) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const la = aLat * rad, lb = bLat * rad;
    const h = Math.sin(dLat / 2) ** 2
            + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Token overlap, ignoring the words that every park name contains.
  // "Park" matching "Park" is not evidence of anything.
  const LORE_STOP = new Set(["park", "parks", "the", "of", "and", "at", "area",
                             "open", "space", "preserve", "reserve", "land",
                             "state", "town", "city", "memorial", "public",
                             "recreation", "field", "fields", "green"]);
  function nameTokens(s) {
    return new Set(String(s || "").toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter(t => t.length > 2 && !LORE_STOP.has(t)));
  }
  function nameScore(a, b) {
    const A = nameTokens(a), B = nameTokens(b);
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const t of A) if (B.has(t)) hit++;
    return hit / Math.min(A.size, B.size);
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
  }
  const getJSON = async url => {
    const r = await withTimeout(fetch(url), LORE_TIMEOUT);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };

  // The park's own OSM polygon, with its tags. `out tags center` skips
  // the geometry — we already have a boundary, all we want is what the
  // mappers wrote down about the place.
  async function fetchOsmTags(p, bbox) {
    const [w, s, e, n] = bbox;
    const kinds =
      `way["leisure"~"^(park|nature_reserve|garden|recreation_ground|common|pitch)$"](${s},${w},${n},${e});` +
      `relation["leisure"~"^(park|nature_reserve|garden|recreation_ground|common)$"](${s},${w},${n},${e});` +
      `way["boundary"="protected_area"](${s},${w},${n},${e});` +
      `relation["boundary"="protected_area"](${s},${w},${n},${e});` +
      `way["landuse"~"^(cemetery|forest|recreation_ground)$"](${s},${w},${n},${e});` +
      `way["amenity"="grave_yard"](${s},${w},${n},${e});`;
    const q = `[out:json][timeout:12];(${kinds});out tags center 60;`;
    const ENDPOINTS = ["https://overpass-api.de/api/interpreter",
                       "https://overpass.kumi.systems/api/interpreter",
                       "https://overpass.osm.jp/api/interpreter"];
    let j = null;
    for (const url of ENDPOINTS) {
      try {
        const r = await withTimeout(fetch(url, { method: "POST",
          body: "data=" + encodeURIComponent(q),
          headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
          LORE_TIMEOUT);
        if (!r.ok) throw new Error("HTTP " + r.status);
        j = await r.json();
        if (j && j.elements) break;
      } catch (err) { j = null; }
    }
    if (!j || !j.elements || !j.elements.length) return null;
    // Best candidate: name agreement first, nearness second. An unnamed
    // polygon can still win, but only if it is nearly under the pin.
    let best = null, bestScore = -1;
    for (const el of j.elements) {
      const t = el.tags || {};
      const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
      if (!c) continue;
      const km = kmApart(p.lat, p.lng, c.lat, c.lon);
      const ns = nameScore(p.name, t.name);
      const score = ns * 2 + Math.max(0, 1 - km / 2);
      if (ns < 0.34 && km > 0.35) continue;        // neither name nor place agrees
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  // en:Some Article -> "Some Article". Other-language tags are ignored
  // rather than machine-translated.
  function titleFromWikiTag(tag) {
    if (!tag) return null;
    const m = String(tag).match(/^([a-z-]+):(.+)$/);
    if (m) return m[1] === "en" ? m[2] : null;
    return String(tag);
  }

  async function titleFromWikidata(qid) {
    if (!/^Q\d+$/.test(String(qid || ""))) return null;
    const j = await getJSON("https://www.wikidata.org/w/api.php?action=wbgetentities"
      + "&ids=" + qid + "&props=sitelinks&sitefilter=enwiki&format=json&origin=*");
    const ent = j && j.entities && j.entities[qid];
    const sl = ent && ent.sitelinks && ent.sitelinks.enwiki;
    return sl ? sl.title : null;
  }

  async function wikiSummary(title) {
    const j = await getJSON("https://en.wikipedia.org/api/rest_v1/page/summary/"
      + encodeURIComponent(String(title).replace(/ /g, "_")));
    if (!j || j.type === "disambiguation" || !j.extract) return null;
    return { title: j.title, extract: j.extract,
             desc: j.description || "",
             lat: j.coordinates ? j.coordinates.lat : null,
             lng: j.coordinates ? j.coordinates.lon : null,
             url: (j.content_urls && j.content_urls.desktop
                   && j.content_urls.desktop.page) || "" };
  }

  // No OSM link: search, then refuse anything that fails the gates.
  async function wikiGuess(p) {
    const terms = [p.name, p.town, "Connecticut"].filter(Boolean).join(" ");
    const j = await getJSON("https://en.wikipedia.org/w/api.php?action=query"
      + "&format=json&origin=*&generator=search&gsrlimit=5&gsrsearch="
      + encodeURIComponent(terms) + "&prop=coordinates");
    const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
    // Sort by the search engine's own ranking, then apply our gates.
    pages.sort((a, b) => (a.index || 99) - (b.index || 99));
    for (const pg of pages) {
      if (nameScore(p.name, pg.title) < 0.5) continue;
      const co = pg.coordinates && pg.coordinates[0];
      if (!co) continue;                     // ungeotagged: cannot be checked
      if (kmApart(p.lat, p.lng, co.lat, co.lon) > LORE_KM) continue;
      try {
        const s = await wikiSummary(pg.title);
        if (s) return s;
      } catch (err) { /* try the next candidate */ }
    }
    return null;
  }

  async function fetchWiki(p, tags) {
    const linked = tags
      ? (titleFromWikiTag(tags.wikipedia)
         || (tags.wikidata ? await titleFromWikidata(tags.wikidata).catch(() => null)
                           : null))
      : null;
    if (linked) {
      // An OSM editor asserted this link, so it skips the name gate.
      // The distance gate still applies: mis-tagged links exist.
      try {
        const s = await wikiSummary(linked);
        if (s && (s.lat == null || kmApart(p.lat, p.lng, s.lat, s.lng) <= 12))
          return Object.assign(s, { linked: true });
      } catch (err) { /* fall through to the search */ }
    }
    return wikiGuess(p).catch(() => null);
  }

  // ---- Composing the pages ------------------------------------------
  // Every sentence below is either a fact from the record, a fact an OSM
  // editor recorded, or Wikipedia's own words. Nothing is inferred to
  // fill a gap: a park with no known rules SAYS the rules are unknown.

  const OWNER_WORD = {
    state: "the State of Connecticut", federal: "the federal government",
    town: "the town", trust: "a land trust", cemetery: "a burial ground"
  };
  const DOG_WORD = {
    yes: "Dogs are allowed.", leashed: "Dogs on a lead.",
    no: "No dogs.", unleashed: "Dogs may run off the lead.",
    leashed_only: "Dogs on a lead."
  };

  function tidy(v) { return String(v || "").replace(/_/g, " ").trim(); }

  function lorePages(p, tags, wiki, extra) {
    const a = p.attrs || {};
    const pages = [];
    const t = tags || {};

    // 1. Who and where.
    const bits = [];
    const acres = Number(p.acres);
    if (acres > 0) bits.push(`${acres >= 1000 ? Math.round(acres / 100) * 100
                                              : Math.round(acres)} acres`);
    if (p.subtype) bits.push(String(p.subtype).toLowerCase());
    const steward = p.agency || t.operator || OWNER_WORD[p.type] || "";
    let open = p.town ? `${p.name}, in ${p.town}.` : `${p.name}.`;
    if (bits.length) open += ` ${bits.join(", ").replace(/^./, c => c.toUpperCase())}`
                             + (steward ? `, looked after by ${steward}.` : ".");
    else if (steward) open += ` Looked after by ${steward}.`;
    pages.push({ head: "THE PLACE", body: open });

    // 2. The ground itself — this is what the viewer is drawing, so it
    //    is worth saying out loud.
    const land = [];
    if (a.relief > 0)
      land.push(a.relief >= 120 ? `The ground climbs hard here — about ${Math.round(a.relief)} metres between the low ground and the high.`
              : a.relief >= 40  ? `About ${Math.round(a.relief)} metres of rise and fall across the site.`
                                : `Gentle ground, barely ${Math.round(a.relief)} metres of relief.`);
    if (a.elev > 0) land.push(`It sits around ${Math.round(a.elev)} m above the sea.`);
    if (a.cover) land.push(`${tidy(a.cover).replace(/^./, c => c.toUpperCase())}.`);
    if (a.water) land.push(a.waterType ? `There is ${/^[aeiou]/i.test(a.waterType) ? "an" : "a"} ${tidy(a.waterType)}.`
                                       : "There is water on it.");
    if (extra && extra.spanM)
      land.push(`Roughly ${(extra.spanM / 1000).toFixed(1)} km across the view you are looking at.`);
    if (land.length) pages.push({ head: "THE LAND", body: land.join(" ") });

    // 3. What you would actually find on arrival.
    const here = [];
    if (a.trails) here.push("There are mapped trails.");
    if (extra && extra.trailKm > 0.15)
      here.push(`About ${extra.trailKm.toFixed(1)} km of path is drawn in this view.`);
    const sport = tidy(t.sport);
    if (sport) here.push(`Marked for ${sport.split(";").join(", ")}.`);
    if (t.playground === "yes" || t.leisure === "playground") here.push("A playground.");
    if (extra && extra.parking) here.push("A parking area sits inside the frame.");
    if (t.toilets === "yes") here.push("Toilets.");
    if (t.wheelchair === "yes") here.push("Mapped as wheelchair accessible.");
    if (extra && extra.publics && extra.publics.length) {
      const named = extra.publics.filter(q => q.name).slice(0, 2).map(q => q.name);
      if (named.length) here.push(`Nearby: ${named.join(", ")}.`);
    }
    if (here.length) pages.push({ head: "WHAT'S HERE", body: here.join(" ") });

    // 4. Rules. The honest page. Everything here is attributed, and an
    //    absence is stated as an absence rather than dressed up as
    //    permission — asserting access we have not checked is exactly
    //    the bug that once rendered a reservation as "you can go here".
    const rules = [];
    let ruleSrc = "";
    if (p.feeState === "free") rules.push("Free to enter.");
    else if (p.feeState === "parking") rules.push("Free to enter; parking may be charged.");
    else if (t.fee === "no") rules.push("Mapped as free.");
    else if (t.fee === "yes" || p.feeState === "fee") rules.push("There is a fee.");
    if (t.opening_hours) {
      rules.push(/dawn|dusk|sunrise|sunset/i.test(t.opening_hours)
        ? `Open ${tidy(t.opening_hours).toLowerCase()}.`
        : `Hours: ${t.opening_hours}.`);
      ruleSrc = "OpenStreetMap";
    }
    if (t.dog && DOG_WORD[t.dog]) { rules.push(DOG_WORD[t.dog]); ruleSrc = "OpenStreetMap"; }
    if (t.access === "permit") { rules.push("A permit is wanted."); ruleSrc = "OpenStreetMap"; }
    if (t.access === "private") { rules.push("Mapped as private."); ruleSrc = "OpenStreetMap"; }
    if (a.researched && a.checked)
      rules.push(`Access confirmed ${a.checked} against ${
        (a.sources && a.sources.length) ? "a published source" : "our own research"}.`);
    else if (p.status !== "park")
      rules.push("We have not confirmed public access here — treat it as unknown.");
    if (!t.opening_hours) rules.push("No posted hours recorded.");
    if (!t.dog) rules.push("Nothing recorded about dogs.");
    pages.push({ head: "RULES", body: rules.join(" "),
                 src: ruleSrc ? "rules from " + ruleSrc : "" });

    // 5. History, in Wikipedia's own words. Trimmed to three sentences:
    //    the reveal is letter by letter and a full article never ends.
    if (wiki && wiki.extract) {
      const sentences = wiki.extract.match(/[^.!?]+[.!?]+(\s|$)/g) || [wiki.extract];
      let text = sentences.slice(0, 3).join("").trim();
      if (text.length > 420) text = text.slice(0, 417).replace(/\s\S*$/, "") + "…";
      pages.push({ head: "HISTORY", body: text,
                   src: "Wikipedia" + (wiki.linked ? "" : " (matched by name and location)"),
                   url: wiki.url });
    }
    return pages;
  }

  // Paths as VECTOR polylines in grid coords, split where they leave
  // the island. Drawn as strokes instead of rasterised cells, so a
  // trail reads as a line rather than a staircase of blocks.
  function linesFrom(features, bbox, inside, margin) {
    const near = (cx, cy) => {
      if (cx < 0 || cy < 0 || cx >= GRID || cy >= GRID) return false;
      if (inside[cy * GRID + cx]) return true;
      if (!margin) return false;
      for (let dy = -margin; dy <= margin; dy++)
        for (let dx = -margin; dx <= margin; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID
              && inside[ny * GRID + nx]) return true;
        }
      return false;
    };
    const out = [];
    for (const f of features)
      for (const path of (f.geometry && f.geometry.paths) || []) {
        let run = [];
        for (const [x, y] of path) {
          const gx = (x - bbox[0]) / (bbox[2] - bbox[0]) * (GRID - 1);
          const gy = (bbox[3] - y) / (bbox[3] - bbox[1]) * (GRID - 1);
          const cx = Math.round(gx), cy = Math.round(gy);
          if (near(cx, cy)) {
            const prev = run[run.length - 1];
            const cum = prev
              ? prev[2] + Math.hypot(gx - prev[0], gy - prev[1]) : 0;
            run.push([gx, gy, cum]);
          } else { if (run.length > 1) out.push(run); run = []; }
        }
        if (run.length > 1) out.push(run);
      }
    return out;
  }

  // Cut a polyline into short ribbon pieces (<= half a block each) in
  // GRID space, dropping the gaps of a dash pattern. Short pieces are
  // what stop a long road being clipped by terrain drawn after it, and
  // grid space is what lets each piece be draped on the ground later.
  function pathPieces(lines, dash) {
    const out = [];
    for (const line of lines || [])
      for (let k = 0; k + 1 < line.length; k++) {
        const [x1, y1, c1] = line[k], [x2, y2] = line[k + 1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 1e-6) continue;
        const steps = Math.max(1, Math.ceil(len / 0.5));
        for (let t = 0; t < steps; t++) {
          const f0 = t / steps, f1 = (t + 1) / steps;
          if (dash) {
            const phase = ((c1 || 0) + len * f0) % (dash[0] + dash[1]);
            if (phase >= dash[0]) continue;
          }
          out.push([x1 + (x2 - x1) * f0, y1 + (y2 - y1) * f0,
                    x1 + (x2 - x1) * f1, y1 + (y2 - y1) * f1]);
          if (out.length > 9000) return out;
        }
      }
    return out;
  }

  function buildDressing(raw, bbox, inside) {
    const trailM = new Uint8Array(GRID * GRID);
    rasterisePaths(raw.trailFeats, bbox, trailM);
    const roadM = new Uint8Array(GRID * GRID);
    rasterisePaths(raw.roads, bbox, roadM);
    const buildM = new Uint8Array(GRID * GRID);
    for (const rings of raw.buildings) {
      const m2 = maskFromRings(rings, bbox);
      for (let i = 0; i < buildM.length; i++) if (m2[i]) buildM[i] = 1;
    }
    const parkM = new Uint8Array(GRID * GRID);
    const sprites = [];
    for (const rings of raw.parking) {
      const m2 = maskFromRings(rings, bbox);
      for (let i = 0; i < parkM.length; i++) if (m2[i]) parkM[i] = 1;
      let sx = 0, sy = 0, np = 0;
      for (const [x, y] of rings[0]) { sx += x; sy += y; np++; }
      const cc = snapInside(inside, ...cellOf(bbox, sx / np, sy / np));
      if (cc) sprites.push({ gx: cc[0], gy: cc[1], kind: "parking" });
    }
    const waterM = new Uint8Array(GRID * GRID);
    for (const rings of raw.waterRings) {
      const m2 = maskFromRings(rings, bbox);
      for (let i = 0; i < waterM.length; i++) if (m2[i]) waterM[i] = 1;
    }
    const courtM = new Uint8Array(GRID * GRID);
    for (const c of raw.courts) {
      const m2 = maskFromRings(c.rings, bbox);
      for (let i = 0; i < courtM.length; i++) if (m2[i]) courtM[i] = c.code;
      let sx = 0, sy = 0, np = 0;
      for (const [x, y] of c.rings[0]) { sx += x; sy += y; np++; }
      const cc = snapInside(inside, ...cellOf(bbox, sx / np, sy / np));
      if (cc) sprites.push({ gx: cc[0], gy: cc[1], kind: c.emoji });
    }

    // The hiker's route: from every trail polyline, take the longest
    // CONTIGUOUS stretch that stays on the island (a polyline that dips
    // off-island used to make him cut across open terrain), then
    // resample it at half-block spacing so he walks at constant speed.
    const toGrid = ([x, y]) =>
      [(x - bbox[0]) / (bbox[2] - bbox[0]) * (GRID - 1),
       (bbox[3] - y) / (bbox[3] - bbox[1]) * (GRID - 1)];
    const onIsland = ([gx, gy]) => {
      const cx2 = Math.round(gx), cy2 = Math.round(gy);
      return cx2 >= 0 && cy2 >= 0 && cx2 < GRID && cy2 < GRID
          && inside[cy2 * GRID + cx2];
    };
    let best = null, bestLen = 0;
    for (const f of raw.trailFeats)
      for (const path of (f.geometry && f.geometry.paths) || []) {
        const g = path.map(toGrid);
        let run = [];
        const flush = () => {
          if (run.length > 3) {
            let len = 0;
            for (let i = 1; i < run.length; i++)
              len += Math.hypot(run[i][0] - run[i - 1][0],
                                run[i][1] - run[i - 1][1]);
            if (len > bestLen) { bestLen = len; best = run; }
          }
          run = [];
        };
        for (const pt of g) { if (onIsland(pt)) run.push(pt); else flush(); }
        flush();
      }
    let hikePath = null;
    if (best) {
      // Uniform resample: one point every half block, so index speed IS
      // ground speed.
      hikePath = [best[0]];
      let carry = 0;
      for (let i = 1; i < best.length; i++) {
        let [x0, y0] = hikePath[hikePath.length - 1];
        const [x1, y1] = best[i];
        let seg = Math.hypot(x1 - x0, y1 - y0);
        while (carry + seg >= 0.5) {
          const t = (0.5 - carry) / seg;
          const nx = x0 + (x1 - x0) * t, ny = y0 + (y1 - y0) * t;
          hikePath.push([nx, ny]);
          seg -= (0.5 - carry); carry = 0; x0 = nx; y0 = ny;
        }
        carry += seg;
      }
      if (hikePath.length < 6) hikePath = null;
    }
    // Both clipped to the island itself: a way hanging off the edge into
    // empty sky reads as a bug, whatever it says about the neighbourhood.
    const trailLines = linesFrom(raw.trailFeats, bbox, inside, 0);
    const roadLines = linesFrom(raw.roads, bbox, inside, 0);
    // Public buildings, snapped onto the island and thinned so a dense
    // downtown does not become a wall of labels. Ranked, so if only a few
    // fit, the library survives and the clinic does not.
    const publics = [];
    const seenCell = new Set();
    for (const q of (raw.publics || []).slice().sort(
           (a, b) => (PUBLIC_RANK[a.kind] || 9) - (PUBLIC_RANK[b.kind] || 9))) {
      const [gx, gy] = cellOf(bbox, q.lon, q.lat);
      const snap = snapInside(inside, gx, gy);
      if (!snap) continue;
      const key = `${Math.round(snap[0] / 3)},${Math.round(snap[1] / 3)}`;
      if (seenCell.has(key)) continue;
      seenCell.add(key);
      publics.push({ gx: snap[0], gy: snap[1], kind: q.kind, name: q.name });
      if (publics.length >= 14) break;
    }

    return { trailM, waterM, roadM, buildM, parkM, courtM, sprites, hikePath,
             trailLines, roadLines, publics,
             trailPieces: pathPieces(trailLines, [1.5, 1.1]),
             roadPieces: pathPieces(roadLines, null) };
  }

  // Drawn icons for the corner controls — no emoji in the chrome either.
  const SVG = {
    day:    '<circle cx="12" cy="12" r="5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2 2M17.8 17.8l2 2M19.8 4.2l-2 2M6.2 17.8l-2 2"/></g>',
    sunset: '<path d="M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M6.5 18a5.5 5.5 0 0 1 11 0z"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v3M4 9l2 1.6M20 9l-2 1.6"/></g>',
    night:  '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    summer: '<circle cx="12" cy="9" r="6.5"/><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/><path d="M10.8 14h2.4v7h-2.4z"/>',
    fall:   '<path d="M12 21c0-5 1-8 5-11 1.6-1.2 2.4-3.4 2.4-6-3.6 0-6.4.9-8.4 2.6C8.4 8.6 7.4 11.6 7.4 15c0 .5 0 1 .1 1.5"/><path d="M12 21c-1.5-2.5-3-4-5.5-5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
    winter: '<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"><path d="M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17"/><path d="M9 4.4L12 6l3-1.6M9 19.6L12 18l3 1.6M4.6 9.8l.6 3.3-2.4 2.3M19.4 14.2l-.6-3.3 2.4-2.3M4.6 14.2l.6-3.3-2.4-2.3M19.4 9.8l-.6 3.3 2.4 2.3"/></g>',
    spring: '<circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="6.4" rx="2.6" ry="3.6"/><ellipse cx="12" cy="17.6" rx="2.6" ry="3.6"/><ellipse cx="6.4" cy="12" rx="3.6" ry="2.6"/><ellipse cx="17.6" cy="12" rx="3.6" ry="2.6"/>',
    // Bottom corners: the terrain menu, the turntable, the export, and
    // the way back to the text once it has been dismissed.
    terrain: '<path d="M2 19h20L14.6 7.2 11 12.6 8.6 9.4z"/><path d="M6.2 14.6l2.4-3.2 1.9 2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    rotate:  '<path d="M12 5V2.5L7.8 5.8 12 9.2V6.6a5.4 5.4 0 1 1-5.4 5.4H5a7 7 0 1 0 7-7z"/><ellipse cx="12" cy="12" rx="9.2" ry="3.4" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".55"/>',
    save:    '<path d="M12 3v10.2l3.4-3.4 1.5 1.5L11 17.2 5.1 11.3l1.5-1.5L10 13.2V3z"/><path d="M4 18.5h16V21H4z"/>',
    scroll:  '<path d="M5 3h11a2.5 2.5 0 0 1 2.5 2.5V19a2 2 0 0 0 2 2H7a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8 7.5h7M8 11h7M8 14.5h4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>'
  };
  const icon = name =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"
          aria-hidden="true">${SVG[name]}</svg>`;

  // ---- Seasons (prototype) ----------------------------------------
  // Ground and tree colours transform per season; winter also frosts
  // the high ground. Applied before time-of-day.
  const SEASONS = [
    { icon: "summer", label: "Summer",
      ground: (r, g, b) => [r, g, b],
      canopy: h2 => [30 + 24 * h2, 96 + 24 * h2, 46 + 19 * h2] },
    { icon: "fall", label: "Fall",
      ground: (r, g, b) => [Math.min(255, r * 1.14 + 14), g * .92, b * .62],
      canopy: h2 => h2 < .45
        ? [172 + 60 * h2, 84 + 40 * h2, 26]           // maples turning
        : [40 + 20 * h2, 88 + 20 * h2, 44] },          // pines stay
    { icon: "winter", label: "Winter",
      ground: (r, g, b) => {
        const m = .68;                                  // frost mix
        return [r * (1 - m) + 226 * m, g * (1 - m) + 232 * m, b * (1 - m) + 238 * m];
      },
      canopy: h2 => [26 + 14 * h2, 58 + 16 * h2, 40 + 12 * h2] },
    { icon: "spring", label: "Spring",
      ground: (r, g, b) => [r * .92, Math.min(255, g * 1.08 + 8), b * .9],
      canopy: h2 => h2 < .3
        ? [214, 160 + 40 * h2, 190]                     // blossom
        : [66 + 30 * h2, 140 + 30 * h2, 70 + 20 * h2] }
  ];

  // ---- Time of day ------------------------------------------------
  const TOD = [
    { icon: "day", label: "Day",    fn: (r, g, b) => [r, g, b] },
    { icon: "sunset", label: "Sunset", fn: (r, g, b) => [Math.min(255, r * 1.08 + 20), g * .82, b * .62] },
    { icon: "night", label: "Night",  fn: (r, g, b) => [r * .30 + 8, g * .34 + 10, b * .52 + 34] }
  ];

  // ---- Drawn sprites (no emoji font anywhere in the scene) --------
  // Civic glyphs: a disc with a simple mark. Drawn rather than emoji, and
  // legible at eight pixels, which rules out anything with fine detail.
  function civicSprite(ctx, kind, X, Y, r, tod) {
    const ink = c => { const t = tod(c[0], c[1], c[2]);
                       return `rgb(${t[0]|0},${t[1]|0},${t[2]|0})`; };
    const FACE = { library: [216, 164, 65], townhall: [206, 210, 214],
                   museum: [206, 210, 214], community: [143, 176, 120],
                   post: [176, 196, 216], worship: [214, 206, 226],
                   school: [226, 196, 150], civic: [206, 206, 206] };
    ctx.save();
    ctx.fillStyle = ink(FACE[kind] || FACE.civic);
    ctx.beginPath(); ctx.arc(X, Y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = ink([32, 48, 38]);
    ctx.lineWidth = Math.max(1, r * .17);
    ctx.stroke();
    ctx.strokeStyle = ctx.fillStyle = ink([28, 44, 34]);
    ctx.lineWidth = Math.max(1, r * .15);
    const u = r * .5;
    ctx.beginPath();
    if (kind === "library") {                       // an open book
      ctx.moveTo(X - u, Y - u * .7); ctx.lineTo(X - u, Y + u * .7);
      ctx.lineTo(X, Y + u * .45); ctx.lineTo(X, Y - u * .9);
      ctx.moveTo(X + u, Y - u * .7); ctx.lineTo(X + u, Y + u * .7);
      ctx.lineTo(X, Y + u * .45); ctx.lineTo(X, Y - u * .9);
    } else if (kind === "worship") {                // a steeple
      ctx.moveTo(X, Y - u); ctx.lineTo(X, Y + u);
      ctx.moveTo(X - u * .6, Y - u * .2); ctx.lineTo(X + u * .6, Y - u * .2);
    } else if (kind === "post") {                   // an envelope
      ctx.rect(X - u, Y - u * .65, u * 2, u * 1.3);
      ctx.moveTo(X - u, Y - u * .65); ctx.lineTo(X, Y + u * .15);
      ctx.lineTo(X + u, Y - u * .65);
    } else if (kind === "school") {                 // a mortarboard
      ctx.moveTo(X - u, Y - u * .2); ctx.lineTo(X, Y - u * .8);
      ctx.lineTo(X + u, Y - u * .2); ctx.lineTo(X, Y + u * .4);
      ctx.closePath();
      ctx.moveTo(X + u * .7, Y - u * .05); ctx.lineTo(X + u * .7, Y + u * .6);
    } else if (kind === "community") {              // a roof over a door
      ctx.moveTo(X - u, Y + u * .6); ctx.lineTo(X - u, Y - u * .1);
      ctx.lineTo(X, Y - u * .8); ctx.lineTo(X + u, Y - u * .1);
      ctx.lineTo(X + u, Y + u * .6);
    } else {                                        // columns: civic, town hall, museum
      ctx.moveTo(X - u, Y - u * .35); ctx.lineTo(X, Y - u * .95);
      ctx.lineTo(X + u, Y - u * .35);
      ctx.moveTo(X - u * .65, Y - u * .2); ctx.lineTo(X - u * .65, Y + u * .5);
      ctx.moveTo(X, Y - u * .2); ctx.lineTo(X, Y + u * .5);
      ctx.moveTo(X + u * .65, Y - u * .2); ctx.lineTo(X + u * .65, Y + u * .5);
      ctx.moveTo(X - u, Y + u * .62); ctx.lineTo(X + u, Y + u * .62);
    }
    ctx.stroke();
    ctx.restore();
  }

  function facilitySprite(ctx, kind, X, Y, r, tod) {
    const ink = (c) => { const t = tod(c[0], c[1], c[2]);
                         return `rgb(${t[0]|0},${t[1]|0},${t[2]|0})`; };
    const disc = (fill, stroke) => {
      ctx.fillStyle = ink(fill);
      ctx.beginPath(); ctx.arc(X, Y, r, 0, 7); ctx.fill();
      if (stroke) { ctx.strokeStyle = ink(stroke); ctx.lineWidth = Math.max(1, r * .16); ctx.stroke(); }
    };
    ctx.save();
    ctx.lineCap = "round";
    switch (kind) {
      case "baseball":
        disc([248, 246, 238], [176, 62, 48]);
        ctx.strokeStyle = ink([176, 62, 48]); ctx.lineWidth = Math.max(1, r * .2);
        ctx.beginPath(); ctx.arc(X - r * .9, Y, r * .95, -.7, .7); ctx.stroke();
        ctx.beginPath(); ctx.arc(X + r * .9, Y, r * .95, Math.PI - .7, Math.PI + .7); ctx.stroke();
        break;
      case "basketball":
        disc([214, 122, 54]);
        ctx.strokeStyle = ink([56, 38, 26]); ctx.lineWidth = Math.max(1, r * .16);
        ctx.beginPath(); ctx.moveTo(X - r, Y); ctx.lineTo(X + r, Y);
        ctx.moveTo(X, Y - r); ctx.lineTo(X, Y + r); ctx.stroke();
        break;
      case "tennis":
        disc([206, 226, 92]);
        ctx.strokeStyle = ink([250, 250, 244]); ctx.lineWidth = Math.max(1, r * .18);
        ctx.beginPath(); ctx.arc(X - r * .95, Y, r, -.75, .75); ctx.stroke();
        break;
      case "pickleball":
        disc([238, 226, 120], [90, 84, 46]);
        ctx.fillStyle = ink([90, 84, 46]);
        for (const [dx, dy] of [[-.4, -.35], [.4, -.35], [0, .1], [-.4, .5], [.4, .5]]) {
          ctx.beginPath(); ctx.arc(X + dx * r, Y + dy * r, r * .15, 0, 7); ctx.fill();
        }
        break;
      case "soccer":
        disc([250, 250, 246], [40, 40, 40]);
        ctx.fillStyle = ink([40, 40, 40]);
        ctx.beginPath();
        for (let k = 0; k < 5; k++) {
          const a = -Math.PI / 2 + k * Math.PI * 2 / 5;
          const px = X + Math.cos(a) * r * .42, py = Y + Math.sin(a) * r * .42;
          k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath(); ctx.fill();
        break;
      case "volleyball":
        disc([250, 248, 240], [70, 110, 170]);
        ctx.strokeStyle = ink([70, 110, 170]); ctx.lineWidth = Math.max(1, r * .15);
        ctx.beginPath(); ctx.arc(X, Y - r * 1.1, r * 1.2, .5, 2.6); ctx.stroke();
        ctx.beginPath(); ctx.arc(X + r * 1.1, Y + r * .4, r * 1.2, 2.6, 4.4); ctx.stroke();
        break;
      case "playground": {                       // a slide
        ctx.strokeStyle = ink([232, 168, 72]); ctx.lineWidth = Math.max(1.4, r * .3);
        ctx.beginPath();
        ctx.moveTo(X - r, Y + r * .7); ctx.quadraticCurveTo(X, Y - r * .2, X + r * .7, Y - r);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X + r * .7, Y - r); ctx.lineTo(X + r * .7, Y + r * .7); ctx.stroke();
        break;
      }
      case "pool":
        ctx.fillStyle = ink([80, 168, 210]);
        ctx.fillRect(X - r, Y - r * .8, r * 2, r * 1.6);
        ctx.strokeStyle = ink([246, 250, 252]); ctx.lineWidth = Math.max(1, r * .18);
        ctx.beginPath();
        for (let k = -1; k <= 1; k++) {
          ctx.moveTo(X - r * .8, Y + k * r * .5);
          ctx.quadraticCurveTo(X, Y + k * r * .5 - r * .35, X + r * .8, Y + k * r * .5);
        }
        ctx.stroke();
        break;
      case "dogpark": {                          // paw
        ctx.fillStyle = ink([196, 168, 122]);
        ctx.beginPath(); ctx.ellipse(X, Y + r * .35, r * .6, r * .5, 0, 0, 7); ctx.fill();
        for (const dx of [-.62, -.2, .2, .62]) {
          ctx.beginPath();
          ctx.ellipse(X + dx * r, Y - r * .5, r * .22, r * .3, dx * .5, 0, 7);
          ctx.fill();
        }
        break;
      }
      case "track":
        ctx.strokeStyle = ink([196, 122, 92]); ctx.lineWidth = Math.max(1.4, r * .34);
        ctx.beginPath(); ctx.ellipse(X, Y, r, r * .62, 0, 0, 7); ctx.stroke();
        break;
      case "parking":
        ctx.fillStyle = ink([54, 84, 150]);
        ctx.fillRect(X - r * .95, Y - r * .95, r * 1.9, r * 1.9);
        ctx.strokeStyle = ink([248, 248, 248]);
        ctx.lineWidth = Math.max(1.2, r * .28); ctx.lineJoin = "miter";
        ctx.beginPath();
        ctx.moveTo(X - r * .3, Y + r * .6); ctx.lineTo(X - r * .3, Y - r * .6);
        ctx.lineTo(X + r * .18, Y - r * .6);
        ctx.arc(X + r * .18, Y - r * .18, r * .42, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(X - r * .3, Y + r * .24);
        ctx.stroke();
        break;
      default:                                    // generic pitch
        ctx.strokeStyle = ink([244, 246, 240]); ctx.lineWidth = Math.max(1, r * .2);
        ctx.strokeRect(X - r * .95, Y - r * .6, r * 1.9, r * 1.2);
        ctx.beginPath(); ctx.moveTo(X, Y - r * .6); ctx.lineTo(X, Y + r * .6); ctx.stroke();
    }
    ctx.restore();
  }

  // A walker: head, body, two legs mid-stride.
  let hikerAtlas = null, hikerAtlasKey = "";
  function hikerFrames(todIdx, tod) {
    if (hikerAtlasKey === String(todIdx) && hikerAtlas) return hikerAtlas;
    const w = PIX_HIKER[0][0].length * PIX_K, h = PIX_HIKER[0].length * PIX_K;
    const cv = document.createElement("canvas");
    cv.width = w * PIX_HIKER.length; cv.height = h;
    const c2 = cv.getContext("2d");
    PIX_HIKER.forEach((rows, i) =>
      pixDraw(c2, rows, PIX_HIKER_PAL, i * w, 0, PIX_K, tod));
    cv.fw = w; cv.fh = h;
    hikerAtlas = cv; hikerAtlasKey = String(todIdx);
    return cv;
  }

  function hikerSprite(ctx, X, Y, r, tod, phase, todIdx, pixel) {
    if (pixel === false) return classicHiker(ctx, X, Y, r, tod, phase);
    const at = hikerFrames(todIdx == null ? 0 : todIdx, tod);
    // Four frames on a two-beat walk. The phase already advances with
    // the hiker's progress along the trail, so the feet keep time with
    // the distance covered rather than with the frame rate.
    const f = Math.abs(Math.floor(phase * 6)) % PIX_HIKER.length;
    const hh = r * 3.4, ww = hh * (at.fw / at.fh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(at, f * at.fw, 0, at.fw, at.fh, X - ww / 2, Y - hh, ww, hh);
    ctx.imageSmoothingEnabled = true;
  }

  // ---- Pixel-art sprites ------------------------------------------
  // Authored in tools/sprites/author.py, which renders them magnified so
  // the pixels can actually be looked at. Stored INDEXED, the way an NES
  // tile was: each pixel names a palette slot, and the palette is swapped
  // per season. One conifer therefore covers all four seasons instead of
  // four drawings, and the time-of-day tint applies to six colours rather
  // than to every pixel.
  // Slots: o outline · a lit · b mid · c shadow · t trunk · u trunk shadow
  const PIX_TREES = [
    [".......oo.......","......oaao......","......oaabo.....",".....oaaabo.....",".....oaaabbo....","....oaaaabbo....","...ooaaabbboo...",".....oaaabbo....","....oaaaabbbo...","...oaaaaabbbbo..","..ooaaaabbbbboo.","....oaaaabbbo...","...oaaaaabbbbo..","..oaaaaaabbbbbo.",".ooaaaaabbbbbboo","....oaaaabbbo...","..oaaaaaabbbbbo.",".oaaaaaaabbbbbbo","ooooaaaabbbboooo",".......tu.......",".......tu.......","......ootuoo...."],
    [".....oooooo.....","...ooaaaabbboo..","..oaaaaabbbbbbo.",".oaaaaaabbbbbbbo",".oaaaaaabbbbbbbo","oaaaaaaabbbbbbbb","oaaaaaaabbbbbbbb","oaaaaaaabbbbbbbb",".oaaaaaabbbbbbbo",".ooaaaaabbbbbboo","...ooaaabbbboo..",".....oootuoo....","......ottuo.....","......ottuo.....",".....oottuuo...."],
    ["........oo......","......ooaabo....",".....oaaaabbo...",".....oaaaabbo...","....oaaaabbbbo..","....oaaaabbbbo..",".....oaaabbbo...","......oatubo....",".......tu.......",".......tu.......",".......tu.......","......ootuoo...."],
    ["....oooo....","..ooaabboo..",".oaaaabbbbo.","oaaaaabbbbbo","oaaaaabbbbbo",".oaaabbbbbo.","..ooaaabboo.","....oooo...."],
  ];
  const PIX_HIKER = [
    ["....oooo....","...ohhhho...","..ohhhhhho..","...osssso...","....osso....","..ooccccoo..",".opccccccpo.",".opccccccpo.",".oopccccpoo.","...occcco...","...ollllo...","..oll..llo..","..oll..llo..",".oll....llo.",".oo......oo."],
    ["....oooo....","...ohhhho...","..ohhhhhho..","...osssso...","....osso....","..ooccccoo..",".opccccccpo.",".opccccccpo.",".oopccccpoo.","...occcco...","...ollllo...","...ollllo...","...ollllo...","...oll.lo...","...oo..oo..."],
    ["....oooo....","...ohhhho...","..ohhhhhho..","...osssso...","....osso....","..ooccccoo..",".opccccccpo.",".opccccccpo.",".oopccccpoo.","...occcco...","...ollllo...","...oll.llo..","..oll..llo..","..oll...llo.","..oo.....oo."],
    ["....oooo....","...ohhhho...","..ohhhhhho..","...osssso...","....osso....","..ooccccoo..",".opccccccpo.",".opccccccpo.",".oopccccpoo.","...occcco...","...ollllo...","...ollllo...","...ollllo...","...ol.llo...","...oo..oo..."],
  ];
  // The outline stays near-black in every season: a constant dark edge is
  // what makes limited-palette art read at 20 pixels tall.
  const PIX_SEASON = [
    { o: [27, 51, 32],  a: [99, 165, 82],  b: [61, 122, 60],  c: [45, 92, 48],
      t: [107, 74, 47], u: [67, 48, 31] },   // summer
    { o: [51, 34, 15],  a: [216, 151, 58], b: [165, 90, 36],  c: [125, 63, 28],
      t: [107, 74, 47], u: [67, 48, 31] },   // autumn
    { o: [42, 51, 64],  a: [232, 238, 242], b: [169, 188, 203], c: [125, 148, 166],
      t: [79, 58, 40],  u: [51, 37, 26] },   // winter
    { o: [30, 53, 36],  a: [143, 201, 95], b: [92, 156, 70],  c: [63, 119, 53],
      t: [107, 74, 47], u: [67, 48, 31] }    // spring
  ];
  const PIX_ROCKS = [
    ["...oooo.....","..oaabbbo...",".oaaabbbbo..","oaaaabbbbbo.","oaaabbbbbbbo",".ooaabbbbbo.","...oooooooo."],
    ["....oo......","..ooaabo....",".oaaabbbo...","oaaabbbbbo..",".ooabbbbbo..","...oooooo..."],
  ];
  const PIX_STONES = [
    ["..oooo..",".oaaabo.","oaaaabbo","oaaaabbo","oaaaabbo","oaaaabbo","oaaaabbo","oooooooo"],
    ["...oo...","..oaao..",".oaaabo.","oaaaabbo","oaoaaboo","oaaaabbo","oaaaabbo","oooooooo"],
    [".oooooo.","oaaaabbo","oaaaabbo","oaaaabbo","oaaaabbo","oooooooo"],
  ];
  const PIX_ROCK_PAL  = { o: [58, 58, 54],  a: [154, 151, 140], b: [111, 109, 102] };
  const PIX_STONE_PAL = { o: [60, 66, 84],  a: [186, 196, 218], b: [132, 142, 166] };
  const PIX_HIKER_PAL = { o: [32, 33, 31], h: [194, 69, 47], s: [224, 176, 136],
                          c: [217, 164, 65], p: [77, 107, 60], l: [55, 80, 107] };

  // Relative trunk-to-crown heights, so a bush is not drawn as tall as a
  // conifer just because they share an atlas.
  const PIX_TREE_SCALE = [1, .78, .62, .34];
  const PIX_K = 4;                       // atlas magnification

  // Paint one indexed shape into a context at integer scale. Nearest
  // neighbour by construction — every pixel is a filled rect, so the art
  // never picks up the smoothing that would make it mush.
  function pixDraw(c2, rows, pal, ox, oy, k, tod) {
    const cache = {};
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === "." || !pal[ch]) continue;
        let col = cache[ch];
        if (!col) {
          const v = tod ? tod(pal[ch][0], pal[ch][1], pal[ch][2]) : pal[ch];
          col = cache[ch] = `rgb(${v[0] | 0},${v[1] | 0},${v[2] | 0})`;
        }
        c2.fillStyle = col;
        c2.fillRect(ox + x * k, oy + y * k, k, k);
      }
    }
  }

  // Props (boulders, headstones) take one palette, so they only need
  // rebuilding when the light changes.
  const propCache = new Map();
  function propAtlas(shapes, pal, todIdx, tod, tag) {
    const key = tag + "|" + todIdx;
    let cv = propCache.get(key);
    if (cv) return cv;
    const cells = shapes.map(rows => ({ w: rows[0].length * PIX_K,
                                        h: rows.length * PIX_K, rows }));
    cv = document.createElement("canvas");
    cv.width = cells.reduce((a, c) => a + c.w, 0);
    cv.height = Math.max(...cells.map(c => c.h));
    const c2 = cv.getContext("2d");
    let x = 0;
    for (const c of cells) { c.x = x; pixDraw(c2, c.rows, pal, x, 0, PIX_K, tod); x += c.w; }
    cv.cells = cells;
    if (propCache.size > 8) propCache.clear();
    propCache.set(key, cv);
    return cv;
  }

  // The pre-pixel look, kept so it can be switched back to. Same atlas
  // shape as the pixel one, so the draw code does not care which is in
  // use — only `cells` and a per-variant scale differ.
  const CLASSIC_W = 44, CLASSIC_H = 74, CLASSIC_N = 4;
  let classicAtlas = null, classicKey = "";
  function classicTrees(season, todIdx, tod) {
    const key = season + "|" + todIdx;
    if (classicKey === key && classicAtlas) return classicAtlas;
    const cv = document.createElement("canvas");
    cv.width = CLASSIC_W * CLASSIC_N; cv.height = CLASSIC_H;
    const c2 = cv.getContext("2d");
    const cells = [];
    for (let v = 0; v < CLASSIC_N; v++) {
      const h2 = (v + .5) / CLASSIC_N;
      const ox = v * CLASSIC_W + CLASSIC_W / 2;
      const base = CLASSIC_H - 2;
      const th = CLASSIC_H * (.72 + .2 * h2);
      const half = CLASSIC_W * .42;
      const shade = 24 * h2;
      const [tr, tg2, tb] = tod(58 + shade, 44 + shade * .6, 30);
      const [cr, cg, cb] = tod(...SEASONS[season].canopy(h2));
      c2.fillStyle = `rgb(${tr | 0},${tg2 | 0},${tb | 0})`;
      c2.fillRect(ox - CLASSIC_W * .06, base - th * .32, CLASSIC_W * .12, th * .34);
      c2.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
      c2.beginPath();
      c2.moveTo(ox, base - th * .74);
      c2.lineTo(ox - half, base - th * .22);
      c2.lineTo(ox + half, base - th * .22);
      c2.closePath(); c2.fill();
      c2.beginPath();
      c2.moveTo(ox, base - th);
      c2.lineTo(ox - half * .72, base - th * .53);
      c2.lineTo(ox + half * .72, base - th * .53);
      c2.closePath(); c2.fill();
      cells.push({ x: v * CLASSIC_W, w: CLASSIC_W, h: CLASSIC_H });
    }
    cv.cells = cells;
    classicAtlas = cv; classicKey = key;
    return cv;
  }
  const CLASSIC_TREE_SCALE = [1, 1, 1, 1];

  function classicHiker(ctx, X, Y, r, tod, phase) {
    const t = tod(250, 248, 240);
    const light = `rgb(${t[0]|0},${t[1]|0},${t[2]|0})`;
    const t2 = tod(38, 62, 48);
    const dark = `rgb(${t2[0]|0},${t2[1]|0},${t2[2]|0})`;
    const sw = Math.max(1.4, r * .34);
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const sp = Math.sin(phase * 9) * r * .55;
    for (const [col, wdt] of [[dark, sw * 1.9], [light, sw]]) {
      ctx.strokeStyle = col; ctx.lineWidth = wdt;
      ctx.beginPath();
      ctx.moveTo(X, Y - r * 1.5); ctx.lineTo(X, Y - r * .1);
      ctx.moveTo(X, Y - r * .1); ctx.lineTo(X - sp, Y + r * .9);
      ctx.moveTo(X, Y - r * .1); ctx.lineTo(X + sp, Y + r * .9);
      ctx.stroke();
    }
    ctx.fillStyle = light;
    ctx.beginPath(); ctx.arc(X, Y - r * 1.95, r * .48, 0, 7); ctx.fill();
    ctx.restore();
  }

  // Trees are the densest thing on screen — thousands of them. They are
  // baked once into an atlas of variants and blitted after that, which is
  // the difference between redrawing geometry and copying pixels.
  let treeAtlas = null, treeAtlasKey = "";
  const TREE_N = PIX_TREES.length;
  function treeSprites(season, todIdx, tod) {
    const key = season + "|" + todIdx;
    if (treeAtlasKey === key && treeAtlas) return treeAtlas;
    const pal = PIX_SEASON[season % PIX_SEASON.length];
    const cells = PIX_TREES.map(rows => ({
      w: rows[0].length * PIX_K, h: rows.length * PIX_K, rows
    }));
    const cv = document.createElement("canvas");
    cv.width = cells.reduce((a, c) => a + c.w, 0);
    cv.height = Math.max(...cells.map(c => c.h));
    const c2 = cv.getContext("2d");
    let x = 0;
    for (const c of cells) {
      c.x = x;
      pixDraw(c2, c.rows, pal, x, 0, PIX_K, tod);
      x += c.w;
    }
    cv.cells = cells;
    treeAtlas = cv; treeAtlasKey = key;
    return cv;
  }

  // ---- Sky: gradient only -----------------------------------------
  function drawSky(ctx, W, Hh, mode) {
    // Just the gradient — the sun, moon and stars were more distraction
    // than atmosphere once the terrain got detailed.
    const g = ctx.createLinearGradient(0, 0, 0, Hh);
    if (mode === 0) {
      g.addColorStop(0, "#8ec9ec"); g.addColorStop(.6, "#cde7f4");
      g.addColorStop(1, "#10161a");
    } else if (mode === 1) {
      g.addColorStop(0, "#2c2350"); g.addColorStop(.45, "#b0526b");
      g.addColorStop(.72, "#f0924f"); g.addColorStop(1, "#140f1c");
    } else {
      g.addColorStop(0, "#050a1c"); g.addColorStop(.7, "#0b1230");
      g.addColorStop(1, "#02040a");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Hh);
  }

  // ---- Drawing ----------------------------------------------------
  function coverPalette(p) {
    // Graveyards get their own cold, drained ground — a colder green
    // going grey-violet in the hollows.
    if (p.type === "cemetery") return { lo: [58, 62, 74], hi: [128, 138, 132] };
    const c = ((p.attrs || {}).cover || "").toLowerCase();
    if (c.includes("wood")) return { lo: [52, 96, 62], hi: [140, 182, 118] };
    if (c.includes("open")) return { lo: [128, 138, 76], hi: [212, 203, 130] };
    return { lo: [76, 108, 74], hi: [178, 195, 140] };
  }
  // Tree probability per CELL derives from trees per GROUND AREA, so
  // the forest doesn't thicken or thin when the block slider moves.
  // With a canopy mask (from satellite imagery) trees stand only where
  // imagery shows canopy; without one, the place's cover label sets an
  // average spacing.
  function treeProb(p, mPerBlock, masked) {
    if (masked) return Math.min(1, (mPerBlock / 18) ** 2);
    const c = ((p.attrs || {}).cover || "").toLowerCase();
    const spacing = c.includes("wood") ? 22
                  : c.includes("mixed") ? 34
                  : c.includes("open") ? 70 : 40;
    return Math.min(1, (mPerBlock / spacing) ** 2);
  }

  // Canopy from imagery, with ADAPTIVE thresholds: vegetation is any
  // pixel where green leads, and "tree" is the darker 65% of the
  // vegetated pixels on THIS island — canopy is darker than lawn in
  // any season's imagery, so the split survives exposure differences
  // that broke a fixed magic-number cut.
  function treeMaskFrom(tex, inside) {
    const M = new Uint8Array(GRID * GRID);
    const veg = [], brightness = [];
    for (let i = 0; i < GRID * GRID; i++) {
      if (inside && !inside[i]) continue;
      const r = tex[i * 3], g = tex[i * 3 + 1], b = tex[i * 3 + 2];
      const bright = (r + g + b) / 3;
      if (bright > 18 && g >= r * 0.96 && g >= b * 0.96) {
        veg.push(i); brightness.push(bright);
      }
    }
    if (veg.length < 20) return null;                 // imagery unusable
    const sorted = [...brightness].sort((a, b) => a - b);
    const cut = sorted[Math.floor(sorted.length * 0.65)];
    for (let k = 0; k < veg.length; k++)
      if (brightness[k] <= cut) M[veg[k]] = 1;
    return M;
  }

  // One consistent earth colour for every side face, everywhere. Per-cell
  // wall shading made the hem look noisy and flickery as it rotated.
  const WALL = [88, 76, 60];

  function renderScene(canvas, S, yaw) {
    const { H, inside, trailM, waterM, roadM, buildM, parkM, courtM,
            dropM, edge, p, spriteAt, tex, coverM } = S;
    const useSat = S.useSat && tex;
    const tod = TOD[S.tod].fn;
    // Satellite is a photo — always drape it on the continuous mesh
    // rather than on stepped columns.
    const smooth = !!S.smooth || useSat;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, Hh = canvas.height;
    drawSky(ctx, W, Hh, S.tod);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < H.length; i++)
      if (inside[i]) { if (H[i] < min) min = H[i]; if (H[i] > max) max = H[i]; }
    if (min === Infinity) { min = 0; max = 1; }
    const span = Math.max(max - min, 8);
    const pal = coverPalette(p);
    const density = Math.min(1, treeProb(p, S.mPerBlock || 10, !!S.treeMask));
    let waterLevel = Infinity;
    for (let i = 0; i < H.length; i++)
      if (inside[i] && waterM[i] && H[i] < waterLevel) waterLevel = H[i];

    const s = (W / (GRID * 1.9)) * (S.zoom || 1);
    const zScale = Math.min(60, 9000 / span) * (span / 90) * (S.zoom || 1);
    const cx = W / 2 + (S.panX || 0), cy = Hh * 0.60 + (S.panY || 0);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const project = (fgx, fgy, h) => {
      const rx = (fgx - GRID / 2) * cos - (fgy - GRID / 2) * sin;
      const ry = (fgx - GRID / 2) * sin + (fgy - GRID / 2) * cos;
      return [cx + rx * s * 1.55,
              cy + ry * s * .8 - (h - min) / span * zScale];
    };
    const depth = (fgx, fgy) => (fgx - GRID / 2) * sin + (fgy - GRID / 2) * cos;
    S._proj = { project, s, min, span, zScale, cx, cy, cos, sin, tod };

    // Terrain height a path or sprite should sit on.
    const heightAtCell = (fgx, fgy) => {
      const gx2 = Math.min(GRID - 1, Math.max(0, Math.round(fgx)));
      const gy2 = Math.min(GRID - 1, Math.max(0, Math.round(fgy)));
      const j = gy2 * GRID + gx2;
      let h = H[j];
      if (waterM[j] && h <= waterLevel + 4) h = waterLevel;
      return h;
    };

    // Height for a corner that is off the island. It MUST depend only on
    // the corner, never on which cell is asking: when it returned the
    // asking cell's own height, the two quads either side of a shoreline
    // corner placed it at two different heights and the mesh tore. That
    // is the smooth-mode stitching.
    const fillCache = new Map();
    const hFill = (ax, ay) => {
      const k = ay * GRID + ax;
      let v = fillCache.get(k);
      if (v !== undefined) return v;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = ax + dx, ny = ay + dy;
          if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
          const j = ny * GRID + nx;
          if (!inside[j]) continue;
          let hh = H[j];
          if (waterM[j] && hh <= waterLevel + 4) hh = waterLevel;
          else if (buildM[j]) hh += 7;
          sum += hh; n++;
        }
      v = n ? sum / n : min;
      fillCache.set(k, v);
      return v;
    };

    // Painter's order without building or sorting 50,000 entries every
    // frame. Depth rises monotonically with gx along sin and gy along
    // cos, so walking each axis in the sign of its term visits cells
    // back-to-front by construction — the standard isometric traversal.
    // While turning, step the grid coarsely: the cost here is per COLUMN,
    // not per pixel, so halving the grid quarters the work. Settling
    // re-renders once at full detail.
    const st = Math.max(1, S.lod || 1);
    const dirX = sin >= 0 ? 1 : -1, dirY = cos >= 0 ? 1 : -1;
    const stepX = dirX * st, stepY = dirY * st;
    const lastAnchor = Math.floor((GRID - 1) / st) * st;
    const gxA = dirX > 0 ? 0 : lastAnchor;
    const gyA = dirY > 0 ? 0 : lastAnchor;
    const inX = gx => dirX > 0 ? gx < GRID : gx >= 0;
    const inY = gy => dirY > 0 ? gy < GRID : gy >= 0;
    // An anchor owns the cells [gx, gx+st), so its column is centred half
    // a cell before it and spans st cells — not centred ON it, which
    // would offset the block from the cells it represents.
    const c0 = -0.5, c1 = -0.5 + st;

    const w = s * 1.62 * st, hgt = s * .92 * st;
    // Infinite mode: one level line below the island's deepest point.
    // Deepest projected row, from the grid corners rather than a scan.
    let maxRy = -Infinity;
    for (const [ax, ay] of [[0, 0], [GRID, 0], [0, GRID], [GRID, GRID]]) {
      const d2 = (ax - GRID / 2) * sin + (ay - GRID / 2) * cos;
      if (d2 > maxRy) maxRy = d2;
    }
    const slabY = cy + maxRy * s * .8 + hgt * 2 + s * 1.2;
    const sides = S.sides == null ? 0 : S.sides;   // 0 solid 1 infinite 2 skirt 3 tops
    // A fixed-width wall rect leaves vertical gaps as the island turns:
    // the projected footprint of a cell is widest at 45 degrees. Walls
    // are one colour, so overlapping them is free.
    const wallW = s * 1.55 * (Math.abs(cos) + Math.abs(sin)) + 1.2;
    const [wr, wg, wb] = tod(WALL[0], WALL[1], WALL[2]);
    const wallFill = `rgb(${wr | 0},${wg | 0},${wb | 0})`;
    const ribbon = zScale * .12 + s * 2.4;

    // Flat ribbons lying on the ground: yellow dashed trails, solid grey
    // roads. Butt caps — round caps on every segment were what made them
    // read as strings of cylinders.
    const deferred = [];        // facility marks, painted above the ways
    const decor = [];           // sprites, painted after ALL terrain
    const pixelMode = S.pixel !== false;
    const atlas = pixelMode ? treeSprites(S.season || 0, S.tod, tod)
                            : classicTrees(S.season || 0, S.tod, tod);
    const treeScale = pixelMode ? PIX_TREE_SCALE : CLASSIC_TREE_SCALE;
    const rockAtlas = pixelMode
      ? propAtlas(PIX_ROCKS, PIX_ROCK_PAL, S.tod, tod, "rock") : null;
    const stoneAtlas = (pixelMode && p.type === "cemetery")
      ? propAtlas(PIX_STONES, PIX_STONE_PAL, S.tod, tod, "stone") : null;
    const trailCol = (() => { const c = tod(232, 196, 74); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; })();
    const roadCol  = (() => { const c = tod(146, 148, 150); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; })();
    const roadEdge = (() => { const c = tod(104, 104, 104); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; })();
    const pxPerGrid = s * 1.55;

    // A ribbon DRAPED on the ground: widened perpendicular in grid space,
    // then every corner projected at its own terrain height, so it hugs
    // the slope instead of hovering.
    const drawRibbon = (pc, kind) => {
      {
        const [x1, y1, x2, y2] = pc;
        const dx = x2 - x1, dy = y2 - y1;
        const L = Math.hypot(dx, dy) || 1;
        const lift = s * .1;
        const hA = heightAtCell(x1, y1), hB = heightAtCell(x2, y2);
        const band = (hw, fill) => {
          const nx = -dy / L * hw, ny = dx / L * hw;
          const q1 = project(x1 + nx, y1 + ny, hA);
          const q2 = project(x2 + nx, y2 + ny, hB);
          const q3 = project(x2 - nx, y2 - ny, hB);
          const q4 = project(x1 - nx, y1 - ny, hA);
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.moveTo(q1[0], q1[1] - lift); ctx.lineTo(q2[0], q2[1] - lift);
          ctx.lineTo(q3[0], q3[1] - lift); ctx.lineTo(q4[0], q4[1] - lift);
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = fill; ctx.lineWidth = 1; ctx.stroke();
        };
        if (kind === "road") { band(0.34, roadEdge); band(0.22, roadCol); }
        else band(0.24, trailCol);
      }
    };

    for (let gy = gyA; inY(gy); gy += stepY)
    for (let gx = gxA; inX(gx); gx += stepX) {
      const i = gy * GRID + gx;
      if (!inside[i]) continue;
      const rx = (gx - GRID / 2) * cos - (gy - GRID / 2) * sin;
      const ry = (gx - GRID / 2) * sin + (gy - GRID / 2) * cos;
      let h = H[i];
      const isWater = waterM[i] && (h <= waterLevel + 4);
      const isBuild = buildM[i] && !isWater;
      if (isWater) h = waterLevel;
      if (isBuild) h += 7;
      const t = (h - min) / span;
      const X = cx + rx * s * 1.55;
      const Y = cy + ry * s * .8 - t * zScale;

      let r, g, b;
      const nb = H[gy * GRID + Math.max(0, gx - 1)];
      const sh = Math.max(-14, Math.min(18, (h - nb) * 1.6));
      if (isBuild) {
        const v = 18 * hash(gx, gy);
        r = 158 + v; g = 144 + v; b = 122 + v;
      } else if (useSat) {
        const o = i * 3;
        r = tex[o] + sh; g = tex[o + 1] + sh; b = tex[o + 2] + sh;
        let tint = null;
        if (isWater) tint = [56, 116, 172];
        else if (courtM[i]) tint = hexRgb(COURT_COLOR[courtM[i]]);
        else if (parkM[i]) tint = [176, 178, 180];
        if (tint) { r = (r + tint[0]) / 2; g = (g + tint[1]) / 2; b = (b + tint[2]) / 2; }
      } else if (isWater) {
        const rip = Math.sin(gx * 1.3 + gy * 2.1) * 6;
        r = 56 + rip; g = 116 + rip; b = 172;
      } else if (courtM[i]) {
        [r, g, b] = hexRgb(COURT_COLOR[courtM[i]]);
        r += sh * .5; g += sh * .5; b += sh * .5;
      } else if (parkM[i]) {
        r = 176; g = 178; b = 180;
      } else {
        r = pal.lo[0] + (pal.hi[0] - pal.lo[0]) * t;
        g = pal.lo[1] + (pal.hi[1] - pal.lo[1]) * t;
        b = pal.lo[2] + (pal.hi[2] - pal.lo[2]) * t;
        r += sh; g += sh; b += sh;
        // NLCD says what this cell actually is — lean the height
        // palette toward it. 55/45 keeps the relief shading readable
        // through the class colour.
        const ct = coverM && COVER_TINT[coverM[i]];
        if (ct) {
          r = r * .45 + ct[0] * .55;
          g = g * .45 + ct[1] * .55;
          b = b * .45 + ct[2] * .55;
        }
      }
      if (!useSat && !isWater && !courtM[i] && !parkM[i] && !isBuild)
        [r, g, b] = SEASONS[S.season || 0].ground(r, g, b);
      [r, g, b] = tod(r, g, b);
      const topFill = rgbStr(r, g, b);

      if (smooth) {
        // Every inside cell gets a quad — no blocky fallback at the
        // boundary, which was the fringe of blocks around the shoreline.
        // Missing neighbours reuse this cell's height so the mesh ends flat.
        const hAt = (ax, ay) => {
          if (ax < 0 || ay < 0 || ax >= GRID || ay >= GRID) return hFill(ax, ay);
          const j = ay * GRID + ax;
          if (!inside[j]) return hFill(ax, ay);
          let hh = H[j];
          if (waterM[j] && hh <= waterLevel + 4) hh = waterLevel;
          else if (buildM[j]) hh += 7;
          return hh;
        };
        // Quads must span the same stride the loop steps, or coarse
        // motion-LOD passes leave a gap between every pair of tiles —
        // that was the "smooth mode shattered while spinning" bug.
        const p00 = project(gx, gy, h);
        const p10 = project(gx + st, gy, hAt(gx + st, gy));
        const p11 = project(gx + st, gy + st, hAt(gx + st, gy + st));
        const p01 = project(gx, gy + st, hAt(gx, gy + st));

        if (sides !== 3) {
          // A wall belongs wherever the NEIGHBOURING QUAD is missing —
          // the neighbour anchored one stride away, not one cell away.
          // Gating this on the full-res edge[] mask broke the rim while
          // spinning: coarse anchors next to the boundary aren't edge
          // cells themselves, so their walls silently vanished.
          const out = (ax, ay) => ax < 0 || ay < 0 || ax >= GRID
                               || ay >= GRID || !inside[ay * GRID + ax];
          const botOf = (pt, fgx, fgy) =>
            sides === 0 ? project(fgx, fgy, min)[1] + s * .9
          : sides === 1 ? slabY
                        : pt[1] + ribbon;
          const wall = (pa, pb, ax, ay, bx, by) => {
            ctx.fillStyle = wallFill;
            ctx.beginPath();
            ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
            ctx.lineTo(pb[0], botOf(pb, bx, by));
            ctx.lineTo(pa[0], botOf(pa, ax, ay));
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = wallFill; ctx.lineWidth = 1; ctx.stroke();
          };
          if (out(gx, gy - st))  wall(p00, p10, gx, gy, gx + st, gy);
          if (out(gx - st, gy))  wall(p00, p01, gx, gy, gx, gy + st);
          if (out(gx + st, gy))  wall(p10, p11, gx + st, gy, gx + st, gy + st);
          if (out(gx, gy + st))  wall(p01, p11, gx, gy + st, gx + st, gy + st);
        }
        ctx.fillStyle = topFill;
        ctx.beginPath();
        ctx.moveTo(p00[0], p00[1]); ctx.lineTo(p10[0], p10[1]);
        ctx.lineTo(p11[0], p11[1]); ctx.lineTo(p01[0], p01[1]);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = topFill; ctx.lineWidth = 1; ctx.stroke();
      } else {
        // TRUE voxel columns. Both faces used to be screen-aligned
        // fillRects, so every block presented the same flat rectangle to
        // the camera however far you rotated — that is the "all blocks
        // face me" bug. Now the top is the projected diamond of the
        // cell's footprint, and the two side faces that actually point
        // at the camera are drawn as quads, each at its own shade: the
        // three-tone top/left/right split is what reads as a cube.
        const P00 = project(gx + c0, gy + c0, h), P10 = project(gx + c1, gy + c0, h),
              P11 = project(gx + c1, gy + c1, h), P01 = project(gx + c0, gy + c1, h);
        const nH = (ax, ay) => {
          if (ax < 0 || ay < 0 || ax >= GRID || ay >= GRID) return null;
          const j = ay * GRID + ax;
          if (!inside[j]) return null;
          let hh = H[j];
          if (waterM[j] && hh <= waterLevel + 4) hh = waterLevel;
          else if (buildM[j]) hh += 7;
          return hh;
        };
        if (sides !== 3) {
          const botFor = (pt, fgx, fgy, nh) => {
            // Against a lower neighbour the wall stops on its roof —
            // that step is the block's visible height. At the island's
            // rim it runs to whatever the side mode asks for.
            if (nh != null) return pt[1] + Math.max(0, (h - nh) / span * zScale) + 1;
            return sides === 0 ? project(fgx, fgy, min)[1] + s * .9
                 : sides === 1 ? slabY
                               : pt[1] + ribbon;
          };
          const face = (pa, pb, ax, ay, bx, by, nh, shade) => {
            // Hidden-face culling: a neighbour at or above this block
            // covers the whole wall, so there is nothing to draw. This
            // is most of the geometry on gentle ground.
            if (nh != null && nh >= h - 0.05) return;
            const ya = botFor(pa, ax, ay, nh), yb = botFor(pb, bx, by, nh);
            if (ya <= pa[1] + .5 && yb <= pb[1] + .5) return;
            // A missing neighbour IS the island's rim — paint it earth
            // brown. Requiring edge[i] too lost the brown ring while
            // spinning: at a coarse stride the anchor cell next to the
            // boundary isn't flagged edge, so the rim went green.
            ctx.fillStyle = nh == null ? wallFill
              : rgbStr(r * shade, g * shade, b * shade);
            ctx.beginPath();
            ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
            ctx.lineTo(pb[0], yb); ctx.lineTo(pa[0], ya);
            ctx.closePath(); ctx.fill();
            // Deliberately NO same-colour stroke here: a stroke bleeds
            // the dark wall half a pixel sideways over the lit top of
            // the neighbouring column, drawing a hairline up every
            // pillar. Abutting fills share exact projected corners, so
            // they need no seam cover.
          };
          // Only the camera-facing pair: which two those are follows the
          // rotation, so the lit and shaded sides swap as you spin.
          if (cos > 0) face(P01, P11, gx + c0, gy + c1, gx + c1, gy + c1, nH(gx, gy + st), .58);
          else         face(P00, P10, gx + c0, gy + c0, gx + c1, gy + c0, nH(gx, gy - st), .58);
          if (sin > 0) face(P10, P11, gx + c1, gy + c0, gx + c1, gy + c1, nH(gx + st, gy), .76);
          else         face(P00, P01, gx + c0, gy + c0, gx + c0, gy + c1, nH(gx - st, gy), .76);
        }
        ctx.fillStyle = topFill;
        ctx.beginPath();
        ctx.moveTo(P00[0], P00[1]); ctx.lineTo(P10[0], P10[1]);
        ctx.lineTo(P11[0], P11[1]); ctx.lineTo(P01[0], P01[1]);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = topFill; ctx.lineWidth = 1; ctx.stroke();
      }

      // Decorations — trees, headstones, boulders, reeds, bushes — are
      // seeded per FULL-RES cell whatever stride the geometry walks
      // (a coarse-lattice forest reshuffles and flickers), and they are
      // NOT drawn here: they are collected and painted after every
      // column, in the sprite pass below. Timothy's spec: decorations
      // are video-game sprites — their full face is always shown, the
      // terrain never eats them.
      for (let sy = 0; sy < st; sy++)
      for (let sx = 0; sx < st; sx++) {
        const dgx = gx + sx, dgy = gy + sy;
        if (dgx < 0 || dgy < 0 || dgx >= GRID || dgy >= GRID) continue;
        const j = dgy * GRID + dgx;
        if (!inside[j]) continue;
        let dh = H[j];
        const dWater = waterM[j] && (dh <= waterLevel + 4);
        const dBuild = buildM[j] && !dWater;
        if (dWater) dh = waterLevel;
        if (dBuild) dh += 7;
        // Stand on this cell's OWN height, at every stride. Borrowing the
        // anchor's height tied each tree to whichever block happened to
        // own it, so the whole forest stepped up and down as the stride
        // or the lattice changed. Sprites paint above the terrain
        // anyway, so a coarse block underneath costs nothing.
        const [dX, dY] = project(dgx, dgy, dh);
        const dd = depth(dgx, dgy);

        const sp = spriteAt && spriteAt.get(j);
        // Facility marks are drawn after the ways, so a court's icon is
        // never painted over by the road running past it.
        if (sp) { deferred.push([dX, dY, sp]); continue; }
        if (dWater || dBuild || trailM[j] || roadM[j] || parkM[j]) continue;
        const cvr = coverM ? coverM[j] : 0;

        // Trees stay in satellite mode too — the drape is the ground,
        // the sprites are the forest standing on it. Without a canopy
        // mask, don't invent trees on ground NLCD calls treeless
        // (marsh, sand, crops, pavement).
        if (!courtM[j] && hash(dgx, dgy) < density
            && (!S.treeMask || S.treeMask[j])
            && (S.treeMask || !COVER_NO_TREES.has(cvr))) {
          const jx = (hash(dgx + 7, dgy) - .5) * s * .97;
          const v = (hash(dgx + 1, dgy + 1) * atlas.cells.length) | 0;
          const cell = atlas.cells[v];
          // Each variant keeps its own proportions and its own height:
          // sharing one atlas cell size drew every bush as tall as a pine.
          const th = s * (1.5 + hash(dgx, dgy + 3)) * 1.35 * treeScale[v];
          const tw = th * (cell.w / cell.h);
          decor.push({ d: dd, f: () => {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(atlas, cell.x, 0, cell.w, cell.h,
                          dX + jx - tw / 2, dY - th, tw, th);
            ctx.imageSmoothingEnabled = true;
          } });
        }

        // Headstones instead of pines: little pale slabs in rows, with
        // a couple of bare crooked trees. Cemeteries should feel like
        // cemeteries.
        else if (p.type === "cemetery" && hash(dgx * 2, dgy) < 0.20) {
          const stoneH = s * (.7 + .35 * hash(dgx, dgy + 5));
          const stoneW = s * .42;
          const crooked = hash(dgx + 9, dgy + 9) < 0.14;
          if (stoneAtlas) {
            const sv = (hash(dgx + 4, dgy + 6) * stoneAtlas.cells.length) | 0;
            const sc = stoneAtlas.cells[sv];
            const sh2 = s * 1.5 * (.8 + .4 * hash(dgx, dgy + 5));
            const sw2 = sh2 * (sc.w / sc.h);
            decor.push({ d: dd, f: () => {
              ctx.imageSmoothingEnabled = false;
              ctx.drawImage(stoneAtlas, sc.x, 0, sc.w, sc.h,
                            dX - sw2 / 2, dY - sh2, sw2, sh2);
              ctx.imageSmoothingEnabled = true;
            } });
            continue;
          }
          decor.push({ d: dd, f: () => {
            let [gr2, gg2, gb2] = tod(198, 200, 196);
            ctx.fillStyle = `rgb(${gr2 | 0},${gg2 | 0},${gb2 | 0})`;
            ctx.beginPath();
            ctx.moveTo(dX - stoneW / 2, dY);
            ctx.lineTo(dX - stoneW / 2, dY - stoneH * .68);
            ctx.quadraticCurveTo(dX, dY - stoneH * 1.12, dX + stoneW / 2, dY - stoneH * .68);
            ctx.lineTo(dX + stoneW / 2, dY);
            ctx.closePath(); ctx.fill();
            if (crooked) {
              let [br, bg2, bb] = tod(58, 52, 48);
              ctx.strokeStyle = `rgb(${br | 0},${bg2 | 0},${bb | 0})`;
              ctx.lineWidth = Math.max(1, s * .16);
              ctx.beginPath();
              ctx.moveTo(dX, dY);
              ctx.lineTo(dX + s * .2, dY - s * 1.5);
              ctx.moveTo(dX + s * .12, dY - s * .9);
              ctx.lineTo(dX - s * .5, dY - s * 1.35);
              ctx.moveTo(dX + s * .17, dY - s * 1.15);
              ctx.lineTo(dX + s * .8, dY - s * 1.6);
              ctx.stroke();
            }
          } });
        }

        // Marsh reeds where NLCD says herbaceous wetland.
        else if (cvr === 95 && hash(dgx + 3, dgy + 7) < 0.28) {
          decor.push({ d: dd, f: () => {
            const [rr, rg2, rb] = tod(104, 116, 62);
            ctx.strokeStyle = `rgb(${rr | 0},${rg2 | 0},${rb | 0})`;
            ctx.lineWidth = Math.max(1, s * .09);
            for (let k = -1; k <= 1; k++) {
              ctx.beginPath();
              ctx.moveTo(dX + k * s * .16, dY);
              ctx.quadraticCurveTo(dX + k * s * .22, dY - s * .45,
                dX + k * s * .3, dY - s * (.7 + .25 * hash(dgx + k, dgy)));
              ctx.stroke();
            }
          } });
        }

        // Low bushes on shrub/scrub ground.
        else if ((cvr === 51 || cvr === 52) && hash(dgx + 11, dgy + 5) < 0.18) {
          decor.push({ d: dd, f: () => {
            const [br2, bg3, bb2] = tod(86, 118, 70);
            ctx.fillStyle = `rgb(${br2 | 0},${bg3 | 0},${bb2 | 0})`;
            ctx.beginPath();
            ctx.ellipse(dX, dY - s * .22, s * .4, s * .27, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(dX + s * .28, dY - s * .14, s * .26, s * .18, 0, 0, Math.PI * 2);
            ctx.fill();
          } });
        }

        // Boulders: same scatter as trees, but only where the ground is
        // genuinely steep — Connecticut's outcrops sit on the slopes,
        // and seeding them off gradient keeps them off lawns and
        // meadows.
        else if (!courtM[j]) {
          const grad = Math.abs(H[j] - H[dgy * GRID + Math.max(0, dgx - 1)])
                     + Math.abs(H[j] - H[Math.max(0, j - GRID)]);
          if (grad > (S.mPerBlock || 10) * 0.30
              && hash(dgx + 31, dgy + 17) < 0.055) {
            const rx2 = (hash(dgx + 5, dgy + 11) - .5) * s * .81;
            const rs = s * (.5 + .5 * hash(dgx + 3, dgy + 9));
            const v = 26 * hash(dgx + 13, dgy + 2);
            if (rockAtlas) {
              const rv = (hash(dgx + 8, dgy + 4) * rockAtlas.cells.length) | 0;
              const rc = rockAtlas.cells[rv];
              const rh2 = rs * 1.7, rw2 = rh2 * (rc.w / rc.h);
              decor.push({ d: dd, f: () => {
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(rockAtlas, rc.x, 0, rc.w, rc.h,
                              dX + rx2 - rw2 / 2, dY - rh2, rw2, rh2);
                ctx.imageSmoothingEnabled = true;
              } });
              continue;
            }
            decor.push({ d: dd, f: () => {
              let [kr, kg, kb] = tod(126 + v, 122 + v, 114 + v);
              ctx.fillStyle = `rgb(${kr | 0},${kg | 0},${kb | 0})`;
              ctx.beginPath();
              ctx.moveTo(dX + rx2 - rs, dY);
              ctx.lineTo(dX + rx2 - rs * .55, dY - rs * .95);
              ctx.lineTo(dX + rx2 + rs * .35, dY - rs * 1.05);
              ctx.lineTo(dX + rx2 + rs, dY - rs * .2);
              ctx.closePath(); ctx.fill();
              let [sr, sg, sb] = tod(92, 89, 84);
              ctx.fillStyle = `rgb(${sr | 0},${sg | 0},${sb | 0})`;
              ctx.beginPath();
              ctx.moveTo(dX + rx2 + rs * .35, dY - rs * 1.05);
              ctx.lineTo(dX + rx2 + rs, dY - rs * .2);
              ctx.lineTo(dX + rx2 + rs * .2, dY);
              ctx.closePath(); ctx.fill();
            } });
          }
        }
      }
    }

    // SPRITE PASS. All decorations paint after every terrain column,
    // far-to-near so they overlap each other correctly. This is what
    // makes them read as video-game sprites: a tree's full face is
    // always shown — the ground never eats it while the view turns.
    // The trade: a sprite whose ground is genuinely hidden behind a
    // ridge stands on the silhouette instead of vanishing; with
    // Connecticut relief that is rare, and it reads far better than
    // trees sinking into the hillside mid-rotation.
    decor.sort((a, b) => a.d - b.d);
    for (const D of decor) D.f();

    // A low mist over graveyards.
    if (p.type === "cemetery") {
      const mist = ctx.createLinearGradient(0, Hh * .45, 0, Hh);
      mist.addColorStop(0, "rgba(198,206,214,0)");
      mist.addColorStop(1, "rgba(198,206,214,.30)");
      ctx.fillStyle = mist;
      ctx.fillRect(0, Hh * .45, W, Hh * .55);
    }

    // Ways in, drawn last so nothing hides them: trees, buildings and
    // ridges can obscure a trail exactly when you need to trace it.
    // Sorted by depth among themselves so crossings stack sensibly.
    const ways = [];
    for (const pc of S.roadPieces || []) ways.push([pc, "road"]);
    for (const pc of S.trailPieces || []) ways.push([pc, "trail"]);
    ways.sort((a, b) =>
      (depth(a[0][0], a[0][1]) + depth(a[0][2], a[0][3]))
      - (depth(b[0][0], b[0][1]) + depth(b[0][2], b[0][3])));
    for (const [pc, kind] of ways) drawRibbon(pc, kind);

    for (const [X, Y, sp] of deferred)
      facilitySprite(ctx, sp, X, Y - s * 1.5, Math.min(11, Math.max(4.5, s * 1.5)), tod);

    // Landscape names — GNIS summits and lakes, drawn last so the land
    // never hides its own name. Retro-topo style: uppercase mono over a
    // paper-coloured halo, lake names in water ink, each pinned to its
    // spot by a short tick. Greedy spacing: a name that would land on
    // one already drawn is skipped this frame rather than overlapped.
    // Public buildings — where the library actually is. Drawn in the
    // always-visible pass with the landscape names, because the whole
    // point is that a roof or a ridge must never hide one.
    if (S.publics && S.publics.length) {
      const fs = Math.max(8, Math.min(13, s * 1.7));
      const r = Math.max(5, Math.min(11, s * 1.5));
      const placedP = [];
      for (const q of S.publics) {
        const [px, pyG] = project(q.gx, q.gy, heightAtCell(q.gx, q.gy));
        const py = pyG - r * 2.1;
        if (placedP.some(o => Math.abs(o[0] - px) < r * 2.4
                           && Math.abs(o[1] - py) < r * 2.4)) continue;
        placedP.push([px, py]);
        // A stem to the ground, so the icon reads as marking a spot
        // rather than floating over one.
        const st2 = tod(28, 44, 34);
        ctx.strokeStyle = `rgb(${st2[0] | 0},${st2[1] | 0},${st2[2] | 0})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(px, py + r); ctx.lineTo(px, pyG); ctx.stroke();
        civicSprite(ctx, q.kind, px, py, r, tod);
        if (q.name && s > 2.2) {
          ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
          ctx.textAlign = "center";
          const halo = tod(245, 242, 230), ink2 = tod(13, 42, 30);
          ctx.lineJoin = "round";
          ctx.lineWidth = Math.max(2.4, fs * .26);
          ctx.strokeStyle = `rgba(${halo[0] | 0},${halo[1] | 0},${halo[2] | 0},.88)`;
          ctx.strokeText(q.name, px, py - r - 3);
          ctx.fillStyle = `rgb(${ink2[0] | 0},${ink2[1] | 0},${ink2[2] | 0})`;
          ctx.fillText(q.name, px, py - r - 3);
        }
      }
    }

    if (S.labels && S.labels.length) {
      const fs = Math.max(10, Math.min(17, s * 2.2));
      ctx.font = `600 ${fs}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = "center";
      const inkC = tod(13, 42, 30), watC = tod(36, 84, 128),
            haloC = tod(245, 242, 230);
      const placed = [];
      for (const L of S.labels) {
        const [lx, lyG] = project(L.gx, L.gy, heightAtCell(L.gx, L.gy));
        const ly = lyG - fs * .9;
        if (placed.some(q => Math.abs(q[0] - lx) < fs * 7
                          && Math.abs(q[1] - ly) < fs * 1.6)) continue;
        placed.push([lx, ly]);
        const t = L.text.toUpperCase();
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(2.5, fs * .24);
        ctx.strokeStyle = `rgba(${haloC[0] | 0},${haloC[1] | 0},${haloC[2] | 0},.85)`;
        ctx.strokeText(t, lx, ly);
        const c = L.water ? watC : inkC;
        ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
        ctx.fillText(t, lx, ly);
        ctx.beginPath();
        ctx.moveTo(lx, ly + fs * .35); ctx.lineTo(lx, lyG);
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // The elevation range sits bottom-CENTRE. It was bottom-left until
    // the terrain menu and turntable icons moved into that corner and
    // covered it. Centring is also dpr-proof: the icons are laid out in
    // CSS pixels and this text in device pixels, so any fixed offset
    // that cleared them on a 1x screen would still collide at 2x.
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(min)}\u2013${Math.round(max)} m`, W / 2, Hh - 10);
  }

  // The scene only changes when the view or the settings change, but the
  // hiker moves every frame. Bake the terrain once per distinct view into
  // an offscreen canvas, blit it, and draw only the walker on top — so a
  // paused turntable costs one copy per frame instead of a full rebuild.
  function draw(canvas, S, yaw) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, Hh = canvas.height;
    // MOTION DETAIL, decided by measurement rather than always-on.
    //
    // This used to drop unconditionally to a doubled grid step and 0.7
    // resolution the instant the view moved, which is visible as the
    // blocks growing while you drag and snapping back when you let go —
    // Timothy reported exactly that, and he was right about the cause.
    //
    // The saving is real: full detail costs about 1.7-2.6x the coarse
    // step, measured both in the offline harness and on the live site,
    // and the cost scales with the column count — a 48-cell grid renders
    // in a few ms where a 176-cell grid is tens. So the coarse step
    // cannot simply be deleted; a big forest on a slow device needs it.
    //
    // It just should not be paid by devices that do not need it. So:
    // start every motion burst at FULL detail, time that first frame,
    // and only coarsen for the rest of the burst if it actually blew the
    // budget. On hardware that keeps up, motion now looks identical to
    // rest — no size change, no softening — because both degradations
    // are tied to the same measured decision instead of to a flag.
    //
    // Absolute frame times could not be pinned down from this sandbox:
    // its browser has no GPU, and the live measurement ran in a
    // BACKGROUNDED tab, where rAF is throttled and raster is
    // deprioritised — numbers from either are not what a real viewer
    // experiences. Measuring in the running viewer sidesteps the
    // question entirely: whatever the truth is on this device, the
    // viewer finds it out for itself.
    // ~45 fps; a full-detail frame under this keeps full detail. The
    // override is a test seam: this sandbox's browser has no GPU, so it
    // coarsens on everything and the fast-device branch could otherwise
    // only be asserted by argument rather than by running it.
    const LOD_BUDGET_MS = window.__lodBudgetMs != null ? window.__lodBudgetMs : 22;
    // Re-probe when the scene's cost could have changed under us —
    // a different grid, the satellite drape, smooth mode, sprite style.
    // Dressing counts are in here too: trails, roads and buildings stream
    // in after the terrain, so a probe taken before they land would be
    // measuring a cheaper scene than the one that ends up on screen.
    const shape = [GRID, S.smooth ? 1 : 0, S.useSat ? 1 : 0,
                   S.pixel === false ? 0 : 1,
                   S.trailPieces ? S.trailPieces.length : 0,
                   S.roadPieces ? S.roadPieces.length : 0,
                   S.publics ? S.publics.length : 0].join(",");
    if (!S.moving || S._lodShape !== shape) {
      S._lodShape = shape;
      S._lodCoarse = false;        // every burst starts optimistic
      S._lodOver = 0;
    }
    S.lod = window.__forceLod != null ? window.__forceLod
          : (S.moving && S._lodCoarse ? 2 : 1);
    // Resolution follows the same decision, so there is never a frame
    // that is sharp but chunky or vice versa.
    const q = (S.moving && S._lodCoarse) ? 0.7 : 1;
    const cw = Math.max(2, Math.round(W * q)), ch = Math.max(2, Math.round(Hh * q));
    const sig = [Math.round(yaw * 500), S.lod, S.tod, S.season, S.sides,
                 S.smooth ? 1 : 0, S.useSat ? 1 : 0, GRID,
                 Math.round((S.zoom || 1) * 200), cw, ch,
                 S.trailPieces ? S.trailPieces.length : 0,
                 S.roadPieces ? S.roadPieces.length : 0,
                 S.labels ? S.labels.length : 0,
                 S.coverM ? 1 : 0, S.treeMask ? 1 : 0,
                 S.publics ? S.publics.length : 0,
                 S.pixel === false ? 0 : 1,
                 Math.round(S.panX || 0), Math.round(S.panY || 0)].join(",");
    if (!S._cache || S._cache.width !== cw || S._cache.height !== ch) {
      S._cache = document.createElement("canvas");
      S._cache.width = cw; S._cache.height = ch;
      S._sig = null;
    }
    if (S._sig !== sig) {
      const t0 = performance.now();
      renderScene(S._cache, S, yaw);
      // Only a full-detail frame tells us whether full detail is
      // affordable. Timing a coarse one would just confirm that the
      // cheap path is cheap, and the viewer would never come back.
      //
      // A HIDDEN tab is not evidence. Chrome throttles rAF and
      // deprioritises raster there, and a backgrounded tab reported
      // 200-320 ms for scenes that render in single-digit ms — enough to
      // latch the coarse step permanently on a machine that never needed
      // it. This cost a whole round of wrong measurements before it was
      // spotted, so it is checked here rather than trusted.
      //
      // Two consecutive over-budget frames, not one: a single slow frame
      // is as likely to be a GC pause or a texture decode as a genuine
      // inability to keep up, and latching on one sample is how you get
      // a permanently chunky viewer from a momentary hiccup.
      if (S.lod === 1 && S.moving && window.__forceLod == null
          && !document.hidden) {
        const over = (performance.now() - t0) > LOD_BUDGET_MS;
        S._lodOver = over ? (S._lodOver || 0) + 1 : 0;
        S._lodCoarse = S._lodOver >= 2;
      }
      S._sig = sig;
    }
    ctx.clearRect(0, 0, W, Hh);
    ctx.imageSmoothingEnabled = q !== 1;
    ctx.drawImage(S._cache, 0, 0, cw, ch, 0, 0, W, Hh);

    // The walker, painted fresh over the baked scene.
    const P = S._proj, inv = P ? (W / S._cache.width) : 1;
    if (P && S.hikePath && S.hikePath.length > 3) {
      const path = S.hikePath;
      const tt = S.hikeT < 0.5 ? S.hikeT * 2 : (1 - S.hikeT) * 2;
      const fi = tt * (path.length - 1);
      const i0 = Math.min(path.length - 2, Math.floor(fi));
      const fr = fi - i0;
      const fgx = path[i0][0] + (path[i0 + 1][0] - path[i0][0]) * fr;
      const fgy = path[i0][1] + (path[i0 + 1][1] - path[i0][1]) * fr;
      const gx2 = Math.min(GRID - 1, Math.max(0, Math.round(fgx)));
      const gy2 = Math.min(GRID - 1, Math.max(0, Math.round(fgy)));
      const [hx0, hy0] = P.project(fgx, fgy, S.H[gy2 * GRID + gx2]);
      // No bob: a pixel sprite that slides up and down by fractions of a
      // pixel just shimmers. The walk cycle carries the motion instead.
      hikerSprite(ctx, hx0 * inv, (hy0 - P.s * .5) * inv,
                  Math.min(9, Math.max(3.6, P.s * 1.2)) * inv, P.tod,
                  S.hikeT * 100, S.tod, S.pixel !== false);
    }
  }

  // ---- Open --------------------------------------------------------
  async function open(p) {
    if (document.getElementById("isoOverlay")) return;
    const ov = document.createElement("div");
    ov.id = "isoOverlay";
    ov.innerHTML = `
      <div id="isoPanel">
        <h3>${p.name}</h3>
        <div class="iso-sub">Loading boundary and terrain…</div>
        <div class="iso-stage">
          <canvas width="840" height="540"></canvas>
          <div class="iso-lore" hidden>
            <div class="iso-lore-head">
              <span class="iso-lore-title"></span>
              <span class="iso-lore-src"></span>
              <button class="iso-lore-x" title="Hide">&#215;</button>
            </div>
            <p class="iso-lore-body"></p>
            <span class="iso-lore-next" hidden></span>
          </div>
          <div class="iso-corner iso-corner-tl"><button id="isoTod" title="Time of day"></button></div>
          <div class="iso-corner iso-corner-tr"><button id="isoSeason" title="Season"></button></div>
          <div class="iso-corner iso-corner-bl">
            <div class="iso-menu" id="isoMenu" hidden></div>
            <div class="iso-corner-row">
              <button id="isoTerrainBtn" title="Terrain and look"></button>
              <button id="isoSpinBtn" class="iso-spin-btn active" title="Pause / resume the turntable"></button>
            </div>
          </div>
          <div class="iso-corner iso-corner-br">
            <div class="iso-corner-row">
              <button id="isoLoreBtn" title="Read about this place" hidden></button>
              <button id="isoSaveBtn" title="Save a picture"></button>
            </div>
          </div>
        </div>
        <div class="iso-foot">
          <span class="iso-tools"></span>
          <button id="isoClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const canvas = ov.querySelector("canvas");
    // The backing store must match the box the browser gives the canvas,
    // or the picture is stretched: CSS was scaling a fixed 840x540 buffer
    // into a full-screen panel. A ResizeObserver keeps them in step.
    if (window.innerWidth <= 760) ov.classList.add("iso-full");
    const fit = () => {
      const box = canvas.getBoundingClientRect();
      if (box.width < 40 || box.height < 40) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w2 = Math.round(box.width * dpr), h2 = Math.round(box.height * dpr);
      if (canvas.width !== w2 || canvas.height !== h2) {
        canvas.width = w2; canvas.height = h2;
      }
    };
    if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas);
    window.addEventListener("resize", fit);
    requestAnimationFrame(fit);
    const sub = ov.querySelector(".iso-sub");
    const tools = ov.querySelector(".iso-tools");
    const spin = document.createElement("div");
    spin.className = "iso-spin";
    canvas.parentElement.insertBefore(spin, canvas);
    canvas.style.display = "none";
    // The lore ribbon runs its own animation frame, so closing the
    // viewer has to stop that too or it keeps typing into a dead node.
    let loreCancel = null;
    const close = () => {
      cancelAnimationFrame(raf);
      if (loreCancel) loreCancel();
      ov.remove();
    };
    ov.querySelector("#isoClose").addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });

    let boundary = null;
    // Districts arrive WITH their boundary — it is the National Register
    // outline the map already drew. Re-deriving it from DEEP/OSM/PAD-US
    // would find nothing, because a town centre is not anybody's parcel.
    if (p.rings && p.rings.length) boundary = { rings: p.rings, label: p.boundaryLabel || "supplied" };
    else { try { boundary = await fetchBoundary(p); } catch (e) { /* fall through */ } }
    let bbox;
    if (boundary) {
      let w = 180, s2 = 90, e2 = -180, n2 = -90;
      for (const ring of boundary.rings)
        for (const [x, y] of ring) {
          if (x < w) w = x; if (x > e2) e2 = x;
          if (y < s2) s2 = y; if (y > n2) n2 = y;
        }
      const padX = (e2 - w) * .08 + 1e-4, padY = (n2 - s2) * .08 + 1e-4;
      bbox = [w - padX, s2 - padY, e2 + padX, n2 + padY];
    } else {
      const acres = Number(p.acres) || 60;
      const sideM = Math.min(Math.max(Math.sqrt(acres * 4046.86) * 1.6, 500), 6000);
      const mPerDeg = 111320 * Math.cos(p.lat * Math.PI / 180);
      const dLng = sideM / mPerDeg / 2, dLat = sideM / 111320 / 2;
      bbox = [p.lng - dLng, p.lat - dLat, p.lng + dLng, p.lat + dLat];
    }
    const spanM = (() => {
      const [w, s2, e2, n2] = bbox;
      return Math.max((e2 - w) * 111320 * Math.cos(s2 * Math.PI / 180),
                      (n2 - s2) * 111320);
    })();

    // A block IS a distance: spanM / GRID metres on the ground. The
    // slider asks for a block size; the grid is clamped for sanity and
    // the label reports the EFFECTIVE size, so it never lies.
    // 176 a side is ~31,000 columns — about as much geometry as a canvas
    // turntable stays fluid with.
    const gridFor = cellM =>
      Math.max(48, Math.min(176, Math.round(spanM / cellM)));

    let heightSample = null;
    try { heightSample = await fetchHeightSample(bbox); } catch (e) { /* */ }

    const buildTerrain = () => {
      const inside = boundary ? maskFromRings(boundary.rings, bbox)
                              : new Uint8Array(GRID * GRID).fill(1);
      const H = heightSample ? heightsFrom(heightSample, bbox)
                             : proceduralHeights(p);
      const dropM = new Float32Array(GRID * GRID);
      const edge = new Uint8Array(GRID * GRID);
      for (let gy = 0; gy < GRID; gy++)
        for (let gx = 0; gx < GRID; gx++) {
          const i = gy * GRID + gx;
          if (!inside[i]) continue;
          let lo = H[i], isEdge = 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = gx + dx, ny = gy + dy;
            if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID
                || !inside[ny * GRID + nx]) { isEdge = 1; continue; }
            const nh = H[ny * GRID + nx];
            if (nh < lo) lo = nh;
          }
          dropM[i] = H[i] - lo;
          edge[i] = isEdge;
        }
      return { inside, H, dropM, edge };
    };

    // The default block size, defined once. The slider below re-derives
    // the same value; if these two ever disagree the first terrain is
    // built at one scale while the slider claims another.
    const minCell = Math.max(4, Math.ceil(spanM / 176 / 2) * 2);
    const defCell = Math.min(Math.max(20, minCell), minCell + 16);
    GRID = gridFor(defCell);
    const { inside, H, dropM, edge } = buildTerrain();

    // TERRAIN FIRST. Trails/roads/buildings/courts stream in after —
    // this is what makes the view feel fast.
    spin.remove();
    canvas.style.display = "";
    const empty = () => new Uint8Array(GRID * GRID);
    const S = { H, inside, dropM, edge, p,
                trailM: empty(), waterM: empty(), roadM: empty(),
                buildM: empty(), parkM: empty(), courtM: empty(),
                trailLines: [], roadLines: [], trailPieces: [], roadPieces: [],
                spriteAt: new Map(), hikePath: null, hikeT: 0,
                useSat: false, tex: null, tod: 0, zoom: 1, cellM: 10,
                smooth: false, mPerBlock: 10, sides: 0, treeMask: null,
                panX: 0, panY: 0,
                season: 0 };
    if (p.type === "cemetery") S.tod = 1;      // dusk suits them
    const baseSub = boundary ? `boundary: ${boundary.label}`
                             : "no boundary found — square sample";
    sub.textContent = baseSub + " · fetching trails, roads, buildings…";

    let rawDressing = null;
    let rawNames = null;
    // Names live in lat/lng; the grid they pin to changes with the
    // block-size slider, so keep the raw list and re-pin on rebuild.
    const buildLabels = () => {
      if (!rawNames) return;
      const order = c => /Summit/i.test(c) ? 0
                       : /Lake|Reservoir/i.test(c) ? 1
                       : /Ridge|Falls|Gap|Cliff/i.test(c) ? 2 : 3;
      const seen = new Set();
      const labels = [];
      for (const nm of rawNames.slice()
                         .sort((a, b) => order(a.cls) - order(b.cls))) {
        const [gx, gy] = cellOf(bbox, nm.lng, nm.lat);
        if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue;
        if (!S.inside[gy * GRID + gx]) continue;   // the island only
        const k = nm.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        labels.push({ gx, gy, text: nm.name, water: nm.water });
        if (labels.length >= 8) break;             // a map, not a phonebook
      }
      S.labels = labels;
    };
    fetchNames(bbox).then(ns => { rawNames = ns; buildLabels(); })
                    .catch(() => { /* nameless land is fine */ });

    // Resolved when the dressing fetch settles either way, so the lore
    // queries can queue behind it rather than race it.
    let dressingDone = () => {};
    const dressingReady = new Promise(r => { dressingDone = r; });

    // ---- The lore ribbon --------------------------------------------
    // Game dialogue: the text arrives a letter at a time, a click
    // finishes the line, another click turns the page. The reveal is
    // driven off the animation clock rather than setInterval, so the
    // pace is the same on a 60 Hz laptop and a 120 Hz phone — a
    // per-character timer runs twice as fast on the phone.
    const lore = ov.querySelector(".iso-lore");
    const loreTitle = lore.querySelector(".iso-lore-title");
    const loreSrc = lore.querySelector(".iso-lore-src");
    const loreBody = lore.querySelector(".iso-lore-body");
    const loreNext = lore.querySelector(".iso-lore-next");
    const loreBtn = ov.querySelector("#isoLoreBtn");
    loreBtn.innerHTML = icon("scroll");

    const CPS = 42;                       // characters per second
    const PAUSE = { ".": 260, "!": 260, "?": 260, ",": 110, ";": 110, "—": 150 };
    const still = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let pages = [], page = 0, shown = 0, typing = false;
    let lastT = 0, hold = 0, typeRaf = null;

    const paintPage = () => {
      const pg = pages[page];
      if (!pg) return;
      loreTitle.textContent = pg.head;
      loreSrc.textContent = pg.src || "";
      loreBody.textContent = pg.body.slice(0, shown);
      const done = shown >= pg.body.length;
      loreNext.hidden = !(done && page < pages.length - 1);
    };

    const step = t => {
      const pg = pages[page];
      if (!pg) { typing = false; return; }
      if (!lastT) lastT = t;
      let dt = t - lastT;
      lastT = t;
      if (hold > 0) { hold -= dt; typeRaf = requestAnimationFrame(step); return; }
      const want = Math.min(pg.body.length, shown + Math.max(1, Math.round(dt * CPS / 1000)));
      if (want > shown) {
        const justTyped = pg.body[want - 1];
        shown = want;
        paintPage();
        if (PAUSE[justTyped]) hold = PAUSE[justTyped];
      }
      if (shown < pg.body.length) typeRaf = requestAnimationFrame(step);
      else { typing = false; paintPage(); }
    };

    const startPage = () => {
      cancelAnimationFrame(typeRaf);
      shown = still ? (pages[page] ? pages[page].body.length : 0) : 0;
      lastT = 0; hold = 0;
      paintPage();
      if (still || shown >= (pages[page] ? pages[page].body.length : 0)) { typing = false; return; }
      typing = true;
      typeRaf = requestAnimationFrame(step);
    };

    const showLore = on => {
      lore.hidden = !on;
      loreBtn.hidden = on;
      if (on) startPage(); else cancelAnimationFrame(typeRaf);
    };
    loreCancel = () => cancelAnimationFrame(typeRaf);

    lore.addEventListener("click", e => {
      if (e.target.closest(".iso-lore-x")) { showLore(false); return; }
      const pg = pages[page];
      if (!pg) return;
      if (typing && shown < pg.body.length) {   // impatient: finish the line
        cancelAnimationFrame(typeRaf);
        shown = pg.body.length; typing = false; paintPage();
      } else if (page < pages.length - 1) { page++; startPage(); }
    });
    loreBtn.addEventListener("click", () => showLore(true));

    // Facts the record does not hold, gathered from what the viewer has
    // already drawn. Read at compose time so whatever has streamed in by
    // then is included and nothing waits on anything else.
    const loreExtra = () => {
      let cells = 0;
      for (const run of (S.trailLines || []))
        if (run.length) cells += run[run.length - 1][2] || 0;
      return { spanM,
               trailKm: cells * (S.mPerBlock || 10) / 1000,
               parking: !!(S.parkM && S.parkM.some(v => v)),
               publics: S.publics || [] };
    };

    // Local first, so there is text within a frame of the terrain
    // appearing. The network sources then replace it if they land.
    pages = lorePages(p, null, null, loreExtra());
    page = 0;
    showLore(true);
    (async () => {
      // Wait for the dressing query before asking Overpass anything
      // else. Firing both at once is how you get rate-limited, and a
      // throttled Overpass once silently cost every road on the island
      // while ArcGIS-sourced trails kept working — roads matter more
      // than lore, so lore queues behind them.
      await dressingReady;
      const tags = await fetchOsmTags(p, bbox).catch(() => null);
      const wiki = await fetchWiki(p, tags).catch(() => null);
      if (!document.body.contains(ov)) return;      // viewer closed meanwhile
      if (!tags && !wiki) return;                   // nothing to add
      const fresh = lorePages(p, tags, wiki, loreExtra());
      // Do not yank the page out from under someone mid-read: keep their
      // place if the new set still has it, and only retype if the text
      // they are looking at actually changed.
      const wasBody = pages[page] && pages[page].body;
      pages = fresh;
      page = Math.min(page, pages.length - 1);
      if (!lore.hidden && pages[page] && pages[page].body !== wasBody) startPage();
      else paintPage();
    })();

    fetchRawDressing(bbox).then(raw => {
      rawDressing = raw;
      const d = buildDressing(raw, bbox, S.inside);
      Object.assign(S, d);
      S.spriteAt = new Map();
      for (const sp of d.sprites) S.spriteAt.set(sp.gy * GRID + sp.gx, sp.kind);
      const bits = [baseSub];
      if (d.trailM.some(v => v)) bits.push("trails");
      bits.push((d.roadPieces && d.roadPieces.length) ? "roads"
                                                        : "roads unavailable");
      if (d.waterM.some(v => v)) bits.push("water");
      if (d.buildM.some(v => v)) bits.push("buildings");
      if (d.sprites.length) bits.push(`${d.sprites.length} facilities`);
      if ((p.attrs || {}).cover) bits.push(p.attrs.cover);
      bits.push("drag to rotate");
      sub.textContent = bits.join(" · ");
    }).catch(() => {
      sub.textContent = baseSub + " · extras unavailable · drag to rotate";
    }).finally(() => dressingDone());

    // Canopy: fetch the imagery sample in the background so trees can
    // stand where the imagery actually shows trees. Doesn't turn the
    // satellite drape on — just informs the forest.
    fetchSatSample(bbox).then(t => {
      satSample = t;
      S.tex = satTexFrom(t, bbox);
      S.treeMask = treeMaskFrom(S.tex, S.inside);
    }).catch(() => { /* uniform cover fallback */ });

    // NLCD ground classes: wetland, sand, meadow, scrub, crops,
    // pavement — per cell, so the ground can show what it is.
    fetchCoverGrid(bbox).then(cg => {
      coverSample = cg;
      S.coverM = coverGridFrom(cg, bbox);
    }).catch(() => { /* uniform palette fallback */ });

    // Toolbar: time of day, satellite drape, export.
    const todBtn = ov.querySelector("#isoTod");
    const paintTod = () => {
      todBtn.innerHTML = icon(TOD[S.tod].icon);
      todBtn.title = "Time of day: " + TOD[S.tod].label;
    };
    paintTod();
    todBtn.addEventListener("click", () => {
      S.tod = (S.tod + 1) % TOD.length; paintTod();
    });
    const satBtn = document.createElement("button");
    satBtn.className = "iso-tool";
    satBtn.textContent = "Satellite";
    satBtn.addEventListener("click", async () => {
      if (S.useSat) { S.useSat = false; satBtn.classList.remove("active"); return; }
      if (!S.tex) {
        satBtn.textContent = "Loading…";
        try {
          satSample = await fetchSatSample(bbox);
          S.tex = satTexFrom(satSample, bbox);
          S.treeMask = treeMaskFrom(S.tex, S.inside);
        }
        catch (e) { satBtn.textContent = "No imagery"; return; }
        satBtn.textContent = "Satellite";
      }
      S.useSat = true; satBtn.classList.add("active");
    });
    // Save moved out of the footer and into the bottom-right corner, to
    // match Season and Time of day. An icon has no room for a "Failed"
    // label, so a failure flashes the button and says so in the tooltip.
    const shotBtn = ov.querySelector("#isoSaveBtn");
    shotBtn.innerHTML = icon("save");
    const shotFailed = () => {
      shotBtn.classList.add("iso-bad");
      shotBtn.title = "Could not save this frame";
      setTimeout(() => shotBtn.classList.remove("iso-bad"), 1200);
    };
    shotBtn.addEventListener("click", () => {
      try {
        canvas.toBlob(blob => {
          if (!blob) { shotFailed(); return; }
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${p.name.replace(/[^\w ]+/g, "").trim() || "park"}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
      } catch (e) { shotFailed(); }
    });
    // Block-size slider: a block is a real distance on the ground.
    // Big parks clamp at 240 cells per side, so a fixed 4-20 m range
    // left the slider dead there (every value clamped to the same grid).
    // The range now starts at the smallest ACHIEVABLE block size.
    // minCell / defCell come from the terrain build above — a block is
    // 20 m by default, everywhere, rotating or not (Timothy, 2026-08-05).
    // It was 10 m, which made a small park's blocks half the size of a
    // big one's and gave the whole thing an inconsistent scale. Fixing it
    // also makes the default view four times cheaper to draw — halving
    // the cell size doubles the grid on each axis — which is why full
    // detail during motion is affordable almost everywhere now. Big parks
    // cannot reach 20 m (the grid clamps at 176 a side), so this is the
    // closest achievable value rather than a promise.
    const sliderWrap = document.createElement("label");
    sliderWrap.className = "iso-slider";
    sliderWrap.innerHTML = `<span class="iso-slider-lab"></span>
      <input type="range" min="${minCell}" max="${minCell + 16}" step="2"
             value="${defCell}">`;
    const slider = sliderWrap.querySelector("input");
    const sliderLab = sliderWrap.querySelector(".iso-slider-lab");
    const labelBlocks = () => {
      S.mPerBlock = spanM / GRID;
      sliderLab.textContent = `1 block ≈ ${Math.round(S.mPerBlock)} m`;
    };
    labelBlocks();

    let satSample = null, coverSample = null;
    const rebuild = () => {
      GRID = gridFor(S.cellM);
      const t2 = buildTerrain();
      Object.assign(S, t2);
      if (rawDressing) {
        const d2 = buildDressing(rawDressing, bbox, S.inside);
        Object.assign(S, d2);
        S.spriteAt = new Map();
        for (const sp of d2.sprites) S.spriteAt.set(sp.gy * GRID + sp.gx, sp.kind);
      }
      S.tex = satSample ? satTexFrom(satSample, bbox) : null;
      S.treeMask = S.tex ? treeMaskFrom(S.tex, S.inside) : null;
      if (!S.tex) S.useSat = false;
      S.coverM = coverSample ? coverGridFrom(coverSample, bbox) : null;
      buildLabels();          // re-pin names to the new grid
      labelBlocks();
    };
    S.cellM = defCell;
    let sliderTimer = null;
    slider.addEventListener("input", () => {
      S.cellM = +slider.value;
      clearTimeout(sliderTimer);
      sliderTimer = setTimeout(rebuild, 160);
    });

    const seasonBtn = ov.querySelector("#isoSeason");
    const paintSeason = () => {
      seasonBtn.innerHTML = icon(SEASONS[S.season].icon);
      seasonBtn.title = "Season: " + SEASONS[S.season].label;
    };
    paintSeason();
    seasonBtn.addEventListener("click", () => {
      S.season = (S.season + 1) % SEASONS.length; paintSeason();
    });

    const SIDES_LABELS = ["Solid", "Infinite", "Skirt", "Tops"];
    const sidesBtn = document.createElement("button");
    sidesBtn.className = "iso-tool";
    sidesBtn.textContent = SIDES_LABELS[0];
    sidesBtn.addEventListener("click", () => {
      S.sides = (S.sides + 1) % 4;
      sidesBtn.textContent = SIDES_LABELS[S.sides];
    });

    // Hop straight to another park without closing the viewer. app.js
    // owns the pool and the filters, so it hands the picker over rather
    // than the viewer duplicating that logic.
    const randBtn = document.createElement("button");
    randBtn.className = "iso-tool";
    randBtn.textContent = "Random";
    randBtn.title = "Jump to another park";
    randBtn.addEventListener("click", () => {
      if (!window.EveryParkRandom) return;
      close();
      setTimeout(() => window.EveryParkRandom(), 80);
    });

    const pixBtn = document.createElement("button");
    pixBtn.className = "iso-tool active";
    pixBtn.textContent = "Pixel";
    pixBtn.title = "Pixel-art sprites, or the original drawn ones";
    pixBtn.addEventListener("click", () => {
      S.pixel = S.pixel === false;
      pixBtn.classList.toggle("active", S.pixel !== false);
      pixBtn.textContent = S.pixel === false ? "Classic" : "Pixel";
    });

    const smoothBtn = document.createElement("button");
    smoothBtn.className = "iso-tool";
    smoothBtn.textContent = "Smooth";
    smoothBtn.addEventListener("click", () => {
      S.smooth = !S.smooth;
      smoothBtn.classList.toggle("active", S.smooth);
    });

    // The look controls live behind one bottom-left icon now. They are
    // things you set once and then stop touching, so a permanent row of
    // them was spending the footer on nothing. The BUTTONS are the same
    // objects as before — moved, not rebuilt — so every handler above
    // and the isotest harness's lookup by label still find them.
    const menu = ov.querySelector("#isoMenu");
    const menuRow = (label, ...ctrls) => {
      const row = document.createElement("div");
      row.className = "iso-menu-row";
      const lab = document.createElement("span");
      lab.className = "iso-menu-lab";
      lab.textContent = label;
      row.append(lab, ...ctrls);
      menu.appendChild(row);
    };
    menuRow("Ground", smoothBtn);
    menuRow("Sides", sidesBtn);
    menuRow("Drape", satBtn);
    menuRow("Sprites", pixBtn);
    menu.appendChild(sliderWrap);

    const terrainBtn = ov.querySelector("#isoTerrainBtn");
    terrainBtn.innerHTML = icon("terrain");
    const setMenu = on => {
      menu.hidden = !on;
      terrainBtn.classList.toggle("active", on);
    };
    terrainBtn.addEventListener("click", e => {
      e.stopPropagation();
      setMenu(menu.hidden);
    });
    // Clicking the terrain itself should put the menu away, but clicking
    // inside the menu must not — a slider drag ending outside its track
    // would otherwise close the thing mid-adjustment.
    menu.addEventListener("click", e => e.stopPropagation());
    canvas.addEventListener("pointerdown", () => setMenu(false));

    tools.append(randBtn);

    // Scroll to zoom, centred on the island.
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      S.zoom = Math.min(9, Math.max(.5, S.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    }, { passive: false });

    // The turntable toggle sits beside the terrain icon rather than
    // inside its menu: it is the one look control you reach for WHILE
    // watching, and burying it would cost two clicks every time.
    const spinBtn = ov.querySelector("#isoSpinBtn");
    spinBtn.innerHTML = icon("rotate");
    spinBtn.addEventListener("click", () => {
      S.spin = !S.spin;
      spinBtn.title = S.spin ? "Pause the turntable" : "Resume the turntable";
      spinBtn.classList.toggle("active", S.spin);
    });
    S.spin = true;

    let yaw = 0, target = 0, dragging = false, lastX = 0, pinchMid = null;
    // Test hooks for tools/isotest. The rotation-stability check has to
    // drive yaw to exact values either side of a quadrant boundary,
    // which no user gesture can do repeatably.
    window.__isoS = S;
    window.__isoSetYaw = v => { yaw = target = v; draw(canvas, S, yaw); };
    // One finger rotates, two fingers pinch to zoom.
    const pointers = new Map();
    let pinchDist = 0;
    const midpoint = () => {
      const p = [...pointers.values()];
      if (!p.length) return { x: 0, y: 0 };
      return { x: p.reduce((a, q) => a + q.x, 0) / p.length,
               y: p.reduce((a, q) => a + q.y, 0) / p.length };
    };
    const spread = () => {
      const [a, b2] = [...pointers.values()];
      return Math.hypot(a.x - b2.x, a.y - b2.y);
    };
    canvas.addEventListener("pointerdown", e => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Capture can throw if the pointer has already been released
      // (and always does for synthetic events in the test harness).
      // Losing capture costs a smooth drag, not correctness.
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      if (pointers.size === 1) { dragging = true; lastX = e.clientX; }
      else if (pointers.size === 2) { dragging = false; pinchDist = spread(); pinchMid = midpoint(); }
    });
    canvas.addEventListener("pointermove", e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size >= 2) {
        const d = spread(), m = midpoint();
        if (pinchDist > 0 && d > 0)
          S.zoom = Math.min(9, Math.max(.5, S.zoom * (d / pinchDist)));
        // Two fingers pinch AND pan: the midpoint between them drags the
        // island, so you can zoom into a corner and then bring it to the
        // middle without letting go.
        if (pinchMid) {
          const q = canvas.width / canvas.getBoundingClientRect().width;
          S.panX = (S.panX || 0) + (m.x - pinchMid.x) * q;
          S.panY = (S.panY || 0) + (m.y - pinchMid.y) * q;
        }
        pinchDist = d; pinchMid = m;
      } else if (dragging) {
        // Touch drags the ISLAND; a mouse drags the CAMERA. With a finger
        // on the thing itself, pushing right should carry the near edge
        // right, which is the opposite sign — the mouse convention felt
        // backwards on a phone.
        const dir = e.pointerType === "touch" ? -1 : 1;
        target += (e.clientX - lastX) * .008 * dir; lastX = e.clientX;
      }
    });
    const release = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { pinchDist = 0; pinchMid = null; }
      if (pointers.size === 1) {
        dragging = true; lastX = [...pointers.values()][0].x;
      } else if (pointers.size === 0) dragging = false;
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.style.touchAction = "none";
    const loop = () => {
      if (!document.getElementById("isoOverlay")) return;
      if (!dragging && S.spin) target += 0.0012;
      const prev = yaw;
      yaw += (target - yaw) * .15;
      S.moving = dragging || S.spin || Math.abs(yaw - prev) > 1e-4;
      // Walking pace: ~1.3 m/s of real ground, whatever the block size.
      if (S.hikePath) {
        const mPerBlock = S.mPerBlock || 10;
        const step = (1.3 / 60) / (mPerBlock * 0.5) / S.hikePath.length;
        S.hikeT = (S.hikeT + step) % 1;
      }
      draw(canvas, S, yaw);
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  return { open };
})();
window.EveryParkIso = EveryParkIso;
