/* ============================================================
   EVERYPARK — ISOMETRIC TERRAIN VIEW, v3

   Opens from the ⛰ button on a place card. Renders the park's real
   boundary as a Minecraft-style floating island and dresses it with
   everything we can fetch about the place:

   - Boundary: point-in-polygon against CT DEEP / OSM mirrors / PAD-US.
   - Elevation: AWS Terrain Tiles (terrarium); procedural fallback.
   - Trails (OSM + Blue-Blazed) as worn tan paths; water flattened blue.
   - Roads, buildings and parking lots from one Overpass query: roads
     asphalt grey, buildings extruded blocks, parking pads with 🅿.
   - Sport courts from the OSM leisure layer, sport-coloured with an
     emoji sprite each (⚾🏀🎾🏓⚽…).
   - A little hiker 🚶 walking the longest trail, because it's cute.
   - Time-of-day toggle (day / sunset / night), satellite drape toggle,
     and 📸 export of the canvas as a PNG.

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
    [/baseball|softball/, 2, "#d9c186", "⚾"],
    [/basketball/,        3, "#6b7d99", "🏀"],
    [/tennis/,            4, "#b85c48", "🎾"],
    [/pickleball/,        5, "#4f9d8b", "🏓"],
    [/soccer|football/,   6, "#5c9e57", "⚽"],
    [/volleyball/,        7, "#c9a86b", "🏐"],
    [/./,                 8, "#7fa06f", "🏃"]
  ];
  const KIND = { playground: [9, "#d99a4e", "🛝"],
                 swimming_pool: [10, "#4fa3c9", "🏊"],
                 dog_park: [11, "#a08a6b", "🐕"],
                 track: [12, "#b0876b", "🏃"] };
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
  async function fetchOverpass(bbox) {
    const [w, s, e, n] = bbox;
    const q = `[out:json][timeout:12];(` +
      `way[highway~"^(motorway|trunk|primary|secondary|tertiary|` +
      `unclassified|residential|service|living_street)$"](${s},${w},${n},${e});` +
      `way[building](${s},${w},${n},${e});` +
      `way[amenity=parking](${s},${w},${n},${e});` +
      `);out geom 700;`;
    const r = await fetch("https://overpass-api.de/api/interpreter",
      { method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const j = await r.json();
    const roads = [], buildings = [], parking = [];
    for (const el of j.elements || []) {
      if (!el.geometry) continue;
      const pts = el.geometry.map(g => [g.lon, g.lat]);
      const tags = el.tags || {};
      if (tags.building) buildings.push([pts]);
      else if (tags.amenity === "parking") parking.push([pts]);
      else if (tags.highway) roads.push({ geometry: { paths: [pts] } });
    }
    return { roads, buildings, parking };
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
      roads: [], buildings: [], parking: []
    };
    if (over.status === "fulfilled") {
      raw.roads = over.value.roads;
      raw.buildings = over.value.buildings;
      raw.parking = over.value.parking;
    }
    return raw;
  }

  // Paths as VECTOR polylines in grid coords, split where they leave
  // the island. Drawn as strokes instead of rasterised cells, so a
  // trail reads as a line rather than a staircase of blocks.
  function linesFrom(features, bbox, inside) {
    const out = [];
    for (const f of features)
      for (const path of (f.geometry && f.geometry.paths) || []) {
        let run = [];
        for (const [x, y] of path) {
          const gx = (x - bbox[0]) / (bbox[2] - bbox[0]) * (GRID - 1);
          const gy = (bbox[3] - y) / (bbox[3] - bbox[1]) * (GRID - 1);
          const cx = Math.round(gx), cy = Math.round(gy);
          if (cx >= 0 && cy >= 0 && cx < GRID && cy < GRID
              && inside[cy * GRID + cx]) {
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
      if (cc) sprites.push({ gx: cc[0], gy: cc[1], emoji: "🅿️" });
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
      if (cc) sprites.push({ gx: cc[0], gy: cc[1], emoji: c.emoji });
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
    return { trailM, waterM, roadM, buildM, parkM, courtM, sprites, hikePath,
             trailLines: linesFrom(raw.trailFeats, bbox, inside),
             roadLines: linesFrom(raw.roads, bbox, inside) };
  }

  // ---- Seasons (prototype) ----------------------------------------
  // Ground and tree colours transform per season; winter also frosts
  // the high ground. Applied before time-of-day.
  const SEASONS = [
    { icon: "🌞", label: "Summer",
      ground: (r, g, b) => [r, g, b],
      canopy: h2 => [30 + 24 * h2, 96 + 24 * h2, 46 + 19 * h2] },
    { icon: "🍂", label: "Fall",
      ground: (r, g, b) => [Math.min(255, r * 1.14 + 14), g * .92, b * .62],
      canopy: h2 => h2 < .45
        ? [172 + 60 * h2, 84 + 40 * h2, 26]           // maples turning
        : [40 + 20 * h2, 88 + 20 * h2, 44] },          // pines stay
    { icon: "❄️", label: "Winter",
      ground: (r, g, b) => {
        const m = .68;                                  // frost mix
        return [r * (1 - m) + 226 * m, g * (1 - m) + 232 * m, b * (1 - m) + 238 * m];
      },
      canopy: h2 => [26 + 14 * h2, 58 + 16 * h2, 40 + 12 * h2] },
    { icon: "🌸", label: "Spring",
      ground: (r, g, b) => [r * .92, Math.min(255, g * 1.08 + 8), b * .9],
      canopy: h2 => h2 < .3
        ? [214, 160 + 40 * h2, 190]                     // blossom
        : [66 + 30 * h2, 140 + 30 * h2, 70 + 20 * h2] }
  ];

  // ---- Time of day ------------------------------------------------
  const TOD = [
    { icon: "☀️", label: "Day",    fn: (r, g, b) => [r, g, b] },
    { icon: "🌅", label: "Sunset", fn: (r, g, b) => [Math.min(255, r * 1.08 + 20), g * .82, b * .62] },
    { icon: "🌙", label: "Night",  fn: (r, g, b) => [r * .30 + 8, g * .34 + 10, b * .52 + 34] }
  ];

  // ---- Sky: gradient + sun / low sun / moon & stars per mode ------
  function drawSky(ctx, W, Hh, mode) {
    let g;
    if (mode === 0) {                                  // day
      g = ctx.createLinearGradient(0, 0, 0, Hh);
      g.addColorStop(0, "#8ec9ec"); g.addColorStop(.6, "#cde7f4");
      g.addColorStop(1, "#10161a");
    } else if (mode === 1) {                           // sunset
      g = ctx.createLinearGradient(0, 0, 0, Hh);
      g.addColorStop(0, "#2c2350"); g.addColorStop(.45, "#b0526b");
      g.addColorStop(.72, "#f0924f"); g.addColorStop(1, "#140f1c");
    } else {                                           // night
      g = ctx.createLinearGradient(0, 0, 0, Hh);
      g.addColorStop(0, "#050a1c"); g.addColorStop(.7, "#0b1230");
      g.addColorStop(1, "#02040a");
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, Hh);

    if (mode === 0) {                                  // sun, high right
      const sx = W * .84, sy = Hh * .13;
      const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, 70);
      glow.addColorStop(0, "rgba(255,246,200,.95)");
      glow.addColorStop(.35, "rgba(255,232,150,.45)");
      glow.addColorStop(1, "rgba(255,232,150,0)");
      ctx.fillStyle = glow; ctx.fillRect(sx - 70, sy - 70, 140, 140);
      ctx.fillStyle = "#fff6d0";
      ctx.beginPath(); ctx.arc(sx, sy, 17, 0, 7); ctx.fill();
    } else if (mode === 1) {                           // fat low sun
      const sx = W * .5, sy = Hh * .30;
      const glow = ctx.createRadialGradient(sx, sy, 8, sx, sy, 110);
      glow.addColorStop(0, "rgba(255,180,90,.9)");
      glow.addColorStop(.4, "rgba(255,140,80,.35)");
      glow.addColorStop(1, "rgba(255,140,80,0)");
      ctx.fillStyle = glow; ctx.fillRect(sx - 110, sy - 110, 220, 220);
      ctx.fillStyle = "#ffcf8a";
      ctx.beginPath(); ctx.arc(sx, sy, 26, 0, 7); ctx.fill();
    } else {                                           // stars + crescent
      for (let i = 0; i < 140; i++) {
        const x = hash(i, 7) * W, y = hash(i, 13) * Hh * .75;
        ctx.fillStyle = `rgba(255,255,255,${.25 + .6 * hash(i, 31)})`;
        ctx.fillRect(x, y, hash(i, 3) > .9 ? 2 : 1, hash(i, 3) > .9 ? 2 : 1);
      }
      const mx = W * .82, my = Hh * .14;
      ctx.fillStyle = "#e8ecf5";
      ctx.beginPath(); ctx.arc(mx, my, 16, 0, 7); ctx.fill();
      ctx.fillStyle = "#0b1230";
      ctx.beginPath(); ctx.arc(mx + 7, my - 4, 14, 0, 7); ctx.fill();
    }
  }

  // ---- Drawing ----------------------------------------------------
  function coverPalette(p) {
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

  function draw(canvas, S, yaw) {
    const { H, inside, trailM, waterM, roadM, buildM, parkM, courtM,
            dropM, edge, p, spriteAt, tex } = S;
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
    const density = treeProb(p, S.mPerBlock || 10, !!S.treeMask);
    let waterLevel = Infinity;
    for (let i = 0; i < H.length; i++)
      if (inside[i] && waterM[i] && H[i] < waterLevel) waterLevel = H[i];

    const s = (W / (GRID * 1.9)) * (S.zoom || 1);
    const zScale = Math.min(60, 9000 / span) * (span / 90) * (S.zoom || 1);
    const cx = W / 2, cy = Hh * 0.60;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const project = (fgx, fgy, h) => {
      const rx = (fgx - GRID / 2) * cos - (fgy - GRID / 2) * sin;
      const ry = (fgx - GRID / 2) * sin + (fgy - GRID / 2) * cos;
      return [cx + rx * s * 1.55,
              cy + ry * s * .8 - (h - min) / span * zScale];
    };
    const depth = (fgx, fgy) => (fgx - GRID / 2) * sin + (fgy - GRID / 2) * cos;

    // Terrain height a path or sprite should sit on.
    const heightAtCell = (fgx, fgy) => {
      const gx2 = Math.min(GRID - 1, Math.max(0, Math.round(fgx)));
      const gy2 = Math.min(GRID - 1, Math.max(0, Math.round(fgy)));
      const j = gy2 * GRID + gx2;
      let h = H[j];
      if (waterM[j] && h <= waterLevel + 4) h = waterLevel;
      return h;
    };

    // Painter's order: terrain cells AND path segments together, so a
    // trail disappears behind a ridge instead of floating over it.
    const order = [];
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        if (!inside[gy * GRID + gx]) continue;
        const rx = (gx - GRID / 2) * cos - (gy - GRID / 2) * sin;
        order.push([depth(gx, gy), rx, gx, gy]);
      }
    const pushLines = (lines, kind) => {
      for (const line of lines || [])
        for (let k = 0; k + 1 < line.length; k++) {
          const a = line[k], b = line[k + 1];
          order.push([(depth(a[0], a[1]) + depth(b[0], b[1])) / 2,
                      -1, { a, b, kind }, null]);
        }
    };
    pushLines(S.trailLines, "trail");
    pushLines(S.roadLines, "road");
    order.sort((a, b) => a[0] - b[0]);

    const w = s * 1.62, hgt = s * .92;
    // Infinite mode: one level line below the island's deepest point.
    let maxRy = -Infinity;
    for (const e2 of order) if (e2[0] > maxRy) maxRy = e2[0];
    const slabY = cy + maxRy * s * .8 + hgt * 2 + s * 1.2;
    const sides = S.sides == null ? 0 : S.sides;   // 0 solid 1 infinite 2 skirt 3 tops
    const [wr, wg, wb] = tod(WALL[0], WALL[1], WALL[2]);
    const wallFill = `rgb(${wr | 0},${wg | 0},${wb | 0})`;
    const ribbon = zScale * .12 + s * 2.4;

    // Flat ribbons lying on the ground: yellow dashed trails, solid grey
    // roads. Butt caps — round caps on every segment were what made them
    // read as strings of cylinders.
    const trailCol = (() => { const c = tod(232, 196, 74); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; })();
    const roadCol  = (() => { const c = tod(158, 162, 168); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; })();
    const roadEdge = (() => { const c = tod(96, 100, 106); return `rgb(${c[0]|0},${c[1]|0},${c[2]|0})`; })();
    const pxPerGrid = s * 1.55;

    for (const entry of order) {
      // --- a path segment ---
      if (entry[1] === -1) {
        const { a, b, kind } = entry[2];
        // Lifted a touch off the ground so the ribbon reads as lying on
        // the surface rather than buried in it.
        const lift = s * .45;
        const pa = project(a[0], a[1], heightAtCell(a[0], a[1]));
        const pb = project(b[0], b[1], heightAtCell(b[0], b[1]));
        ctx.lineCap = "butt"; ctx.lineJoin = "round";
        if (kind === "road") {
          ctx.setLineDash([]);
          ctx.strokeStyle = roadEdge;
          ctx.lineWidth = Math.max(2.2, s * 1.35);
          ctx.beginPath();
          ctx.moveTo(pa[0], pa[1] - lift); ctx.lineTo(pb[0], pb[1] - lift);
          ctx.stroke();
          ctx.strokeStyle = roadCol;
          ctx.lineWidth = Math.max(1.4, s * .95);
        } else {
          const dash = Math.max(2.4, s * 1.5), gap = Math.max(2, s * 1.15);
          ctx.setLineDash([dash, gap]);
          ctx.lineDashOffset = -(a[2] || 0) * pxPerGrid;
          ctx.strokeStyle = trailCol;
          ctx.lineWidth = Math.max(1.3, s * .62);
        }
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1] - lift); ctx.lineTo(pb[0], pb[1] - lift);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }

      const [ry, rx, gx, gy] = entry;
      const i = gy * GRID + gx;
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
      }
      if (!useSat && !isWater && !courtM[i] && !parkM[i] && !isBuild)
        [r, g, b] = SEASONS[S.season || 0].ground(r, g, b);
      [r, g, b] = tod(r, g, b);
      const topFill = `rgb(${r | 0},${g | 0},${b | 0})`;

      if (smooth) {
        // Every inside cell gets a quad — no blocky fallback at the
        // boundary, which was the fringe of blocks around the shoreline.
        // Missing neighbours reuse this cell's height so the mesh ends flat.
        const hAt = (ax, ay) => {
          if (ax < 0 || ay < 0 || ax >= GRID || ay >= GRID) return h;
          const j = ay * GRID + ax;
          if (!inside[j]) return h;
          let hh = H[j];
          if (waterM[j] && hh <= waterLevel + 4) hh = waterLevel;
          else if (buildM[j]) hh += 7;
          return hh;
        };
        const p00 = project(gx, gy, h);
        const p10 = project(gx + 1, gy, hAt(gx + 1, gy));
        const p11 = project(gx + 1, gy + 1, hAt(gx + 1, gy + 1));
        const p01 = project(gx, gy + 1, hAt(gx, gy + 1));

        if (sides !== 3 && edge[i]) {
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
          if (gy === 0 || !inside[i - GRID])            wall(p00, p10, gx, gy, gx + 1, gy);
          if (gx === 0 || !inside[i - 1])               wall(p00, p01, gx, gy, gx, gy + 1);
          if (gx + 1 >= GRID || !inside[i + 1])         wall(p10, p11, gx + 1, gy, gx + 1, gy + 1);
          if (gy + 1 >= GRID || !inside[i + GRID])      wall(p01, p11, gx, gy + 1, gx + 1, gy + 1);
        }
        ctx.fillStyle = topFill;
        ctx.beginPath();
        ctx.moveTo(p00[0], p00[1]); ctx.lineTo(p10[0], p10[1]);
        ctx.lineTo(p11[0], p11[1]); ctx.lineTo(p01[0], p01[1]);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = topFill; ctx.lineWidth = 1; ctx.stroke();
      } else {
        if (sides !== 3) {
          const drop =
            sides === 0 ? (edge[i] ? t * zScale + s * .9
                                   : (dropM[i] / span) * zScale + 1.6)
          : sides === 1 ? (edge[i] ? Math.max(0, slabY - Y)
                                   : (dropM[i] / span) * zScale + 1.6)
                        : (dropM[i] / span) * zScale + (edge[i] ? ribbon : 1.6);
          ctx.fillStyle = wallFill;
          ctx.fillRect(X - w / 2, Y, w + .7,
                       drop + hgt + (isBuild ? 7 / span * zScale : 0));
        }
        ctx.fillStyle = topFill;
        ctx.fillRect(X - w / 2, Y - hgt / 2, w + .7, hgt + .7);
      }

      const sp = spriteAt && spriteAt.get(i);
      if (sp) {
        ctx.font = `${Math.min(30, Math.max(10, s * 3.6)) | 0}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(sp, X, Y - s * .9);
      }
      // Trees stay in satellite mode too — the drape is the ground, the
      // sprites are the forest standing on it.
      if (!sp && !isWater && !isBuild && !trailM[i] && !roadM[i]
          && !courtM[i] && !parkM[i] && hash(gx, gy) < density
          && (!S.treeMask || S.treeMask[i])) {
        const jx = (hash(gx + 7, gy) - .5) * w * .6;
        const th = s * (1.5 + hash(gx, gy + 3));
        const half = s * .55;
        const h2 = hash(gx + 1, gy + 1);
        const shade = 24 * h2;
        let tr = 58 + shade, tg2 = 44 + shade * .6, tb = 30;
        let [cr, cg, cb] = SEASONS[S.season || 0].canopy(h2);
        [tr, tg2, tb] = tod(tr, tg2, tb); [cr, cg, cb] = tod(cr, cg, cb);
        ctx.fillStyle = `rgb(${tr | 0},${tg2 | 0},${tb | 0})`;
        ctx.fillRect(X + jx - s * .08, Y - th * .35, s * .16, th * .4);
        ctx.fillStyle = `rgb(${cr | 0},${cg | 0},${cb | 0})`;
        ctx.beginPath();
        ctx.moveTo(X + jx, Y - th);
        ctx.lineTo(X + jx - half, Y - th * .3);
        ctx.lineTo(X + jx + half, Y - th * .3);
        ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(X + jx, Y - th * 1.35);
        ctx.lineTo(X + jx - half * .72, Y - th * .72);
        ctx.lineTo(X + jx + half * .72, Y - th * .72);
        ctx.closePath(); ctx.fill();
      }
    }

    if (S.hikePath && S.hikePath.length > 3) {
      const path = S.hikePath;
      const tt = S.hikeT < 0.5 ? S.hikeT * 2 : (1 - S.hikeT) * 2;
      const fi = tt * (path.length - 1);
      const i0 = Math.min(path.length - 2, Math.floor(fi));
      const fr = fi - i0;
      const fgx = path[i0][0] + (path[i0 + 1][0] - path[i0][0]) * fr;
      const fgy = path[i0][1] + (path[i0 + 1][1] - path[i0][1]) * fr;
      const [hx, hy] = project(fgx, fgy, heightAtCell(fgx, fgy));
      const bob = Math.sin(S.hikeT * 240) * 1.5;
      ctx.font = `${Math.min(32, Math.max(11, s * 4)) | 0}px system-ui`;
      ctx.textAlign = "center";
      ctx.fillText("\u{1F6B6}", hx, hy - s * 1.1 + bob);
    }

    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = "11px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`${Math.round(min)}\u2013${Math.round(max)} m`, 10, Hh - 10);
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
        <canvas width="840" height="540"></canvas>
        <div class="iso-foot">
          <span class="iso-tools"></span>
          <button id="isoClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const canvas = ov.querySelector("canvas");
    const sub = ov.querySelector(".iso-sub");
    const tools = ov.querySelector(".iso-tools");
    const spin = document.createElement("div");
    spin.className = "iso-spin";
    ov.querySelector("#isoPanel").insertBefore(spin, canvas);
    canvas.style.display = "none";
    const close = () => { cancelAnimationFrame(raf); ov.remove(); };
    ov.querySelector("#isoClose").addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });

    let boundary = null;
    try { boundary = await fetchBoundary(p); } catch (e) { /* fall through */ }
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
    const gridFor = cellM =>
      Math.max(48, Math.min(240, Math.round(spanM / cellM)));

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

    GRID = gridFor(Math.max(10, Math.ceil(spanM / 240 / 2) * 2));  // default ≈ 10 m
    const { inside, H, dropM, edge } = buildTerrain();

    // TERRAIN FIRST. Trails/roads/buildings/courts stream in after —
    // this is what makes the view feel fast.
    spin.remove();
    canvas.style.display = "";
    const empty = () => new Uint8Array(GRID * GRID);
    const S = { H, inside, dropM, edge, p,
                trailM: empty(), waterM: empty(), roadM: empty(),
                buildM: empty(), parkM: empty(), courtM: empty(),
                trailLines: [], roadLines: [],
                spriteAt: new Map(), hikePath: null, hikeT: 0,
                useSat: false, tex: null, tod: 0, zoom: 1, cellM: 10,
                smooth: false, mPerBlock: 10, sides: 0, treeMask: null,
                season: 0 };
    const baseSub = boundary ? `boundary: ${boundary.label}`
                             : "no boundary found — square sample";
    sub.textContent = baseSub + " · fetching trails, roads, buildings…";

    let rawDressing = null;
    fetchRawDressing(bbox).then(raw => {
      rawDressing = raw;
      const d = buildDressing(raw, bbox, S.inside);
      Object.assign(S, d);
      S.spriteAt = new Map();
      for (const sp of d.sprites) S.spriteAt.set(sp.gy * GRID + sp.gx, sp.emoji);
      const bits = [baseSub];
      if (d.trailM.some(v => v)) bits.push("trails");
      if (d.roadM.some(v => v)) bits.push("roads");
      if (d.waterM.some(v => v)) bits.push("water");
      if (d.buildM.some(v => v)) bits.push("buildings");
      if (d.sprites.length) bits.push(`${d.sprites.length} facilities`);
      if ((p.attrs || {}).cover) bits.push(p.attrs.cover);
      bits.push("drag to rotate");
      sub.textContent = bits.join(" · ");
    }).catch(() => {
      sub.textContent = baseSub + " · extras unavailable · drag to rotate";
    });

    // Canopy: fetch the imagery sample in the background so trees can
    // stand where the imagery actually shows trees. Doesn't turn the
    // satellite drape on — just informs the forest.
    fetchSatSample(bbox).then(t => {
      satSample = t;
      S.tex = satTexFrom(t, bbox);
      S.treeMask = treeMaskFrom(S.tex, S.inside);
    }).catch(() => { /* uniform cover fallback */ });

    // Toolbar: time of day, satellite drape, export.
    const todBtn = document.createElement("button");
    todBtn.className = "iso-tool";
    todBtn.textContent = "☀️ Day";
    todBtn.addEventListener("click", () => {
      S.tod = (S.tod + 1) % TOD.length;
      todBtn.textContent = `${TOD[S.tod].icon} ${TOD[S.tod].label}`;
    });
    const satBtn = document.createElement("button");
    satBtn.className = "iso-tool";
    satBtn.textContent = "🛰 Satellite";
    satBtn.addEventListener("click", async () => {
      if (S.useSat) { S.useSat = false; satBtn.classList.remove("active"); return; }
      if (!S.tex) {
        satBtn.textContent = "🛰 loading…";
        try {
          satSample = await fetchSatSample(bbox);
          S.tex = satTexFrom(satSample, bbox);
          S.treeMask = treeMaskFrom(S.tex, S.inside);
        }
        catch (e) { satBtn.textContent = "🛰 unavailable"; return; }
        satBtn.textContent = "🛰 Satellite";
      }
      S.useSat = true; satBtn.classList.add("active");
    });
    const shotBtn = document.createElement("button");
    shotBtn.className = "iso-tool";
    shotBtn.textContent = "📸 Save";
    shotBtn.addEventListener("click", () => {
      try {
        canvas.toBlob(blob => {
          if (!blob) { shotBtn.textContent = "📸 unavailable"; return; }
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${p.name.replace(/[^\w ]+/g, "").trim() || "park"}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
      } catch (e) { shotBtn.textContent = "📸 unavailable"; }
    });
    // Block-size slider: a block is a real distance on the ground.
    // Big parks clamp at 240 cells per side, so a fixed 4-20 m range
    // left the slider dead there (every value clamped to the same grid).
    // The range now starts at the smallest ACHIEVABLE block size.
    const minCell = Math.max(4, Math.ceil(spanM / 240 / 2) * 2);
    const defCell = Math.max(10, minCell);
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

    let satSample = null;
    const rebuild = () => {
      GRID = gridFor(S.cellM);
      const t2 = buildTerrain();
      Object.assign(S, t2);
      if (rawDressing) {
        const d2 = buildDressing(rawDressing, bbox, S.inside);
        Object.assign(S, d2);
        S.spriteAt = new Map();
        for (const sp of d2.sprites) S.spriteAt.set(sp.gy * GRID + sp.gx, sp.emoji);
      }
      S.tex = satSample ? satTexFrom(satSample, bbox) : null;
      S.treeMask = S.tex ? treeMaskFrom(S.tex, S.inside) : null;
      if (!S.tex) S.useSat = false;
      labelBlocks();
    };
    S.cellM = defCell;
    let sliderTimer = null;
    slider.addEventListener("input", () => {
      S.cellM = +slider.value;
      clearTimeout(sliderTimer);
      sliderTimer = setTimeout(rebuild, 160);
    });

    const seasonBtn = document.createElement("button");
    seasonBtn.className = "iso-tool";
    seasonBtn.textContent = "🌞 Summer";
    seasonBtn.addEventListener("click", () => {
      S.season = (S.season + 1) % SEASONS.length;
      seasonBtn.textContent = `${SEASONS[S.season].icon} ${SEASONS[S.season].label}`;
    });

    const SIDES_LABELS = ["🧱 Solid", "⬇️ Infinite", "🪜 Skirt", "▭ Tops"];
    const sidesBtn = document.createElement("button");
    sidesBtn.className = "iso-tool";
    sidesBtn.textContent = SIDES_LABELS[0];
    sidesBtn.addEventListener("click", () => {
      S.sides = (S.sides + 1) % 4;
      sidesBtn.textContent = SIDES_LABELS[S.sides];
    });

    const smoothBtn = document.createElement("button");
    smoothBtn.className = "iso-tool";
    smoothBtn.textContent = "⬜ Smooth";
    smoothBtn.addEventListener("click", () => {
      S.smooth = !S.smooth;
      smoothBtn.classList.toggle("active", S.smooth);
    });

    tools.append(todBtn, seasonBtn, satBtn, smoothBtn, sidesBtn, shotBtn, sliderWrap);

    // Scroll to zoom, centred on the island.
    canvas.addEventListener("wheel", e => {
      e.preventDefault();
      S.zoom = Math.min(3, Math.max(.5, S.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    }, { passive: false });

    let yaw = 0, target = 0, dragging = false, lastX = 0;
    canvas.addEventListener("pointerdown", e => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => { if (dragging) { target += (e.clientX - lastX) * .008; lastX = e.clientX; } });
    canvas.addEventListener("pointerup", () => dragging = false);
    const loop = () => {
      if (!document.getElementById("isoOverlay")) return;
      if (!dragging) target += 0.0012;
      yaw += (target - yaw) * .15;
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
