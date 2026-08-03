/* ============================================================
   EVERYPARK — ISOMETRIC TERRAIN VIEW, v2

   Opens from the ⛰ button on a place card. Now renders the park's
   REAL boundary as a floating island — not a square sample:

   1. Boundary: fetched on demand by point-in-polygon query against
      the same public services the pipeline uses (CT DEEP, the OSM
      mirrors, PAD-US). Best candidate wins: name match first, then
      the smallest polygon containing the pin. No boundary found →
      falls back to an acreage-sized square, labelled as such.
   2. Elevation: AWS Terrain Tiles (Mapzen terrarium), fetched for
      the polygon's bbox; procedural fallback offline.
   3. Dressing: trails (OSM + Blue-Blazed) rasterised onto the
      terrain as tan paths, water polygons flattened and tinted,
      and little sprite trees scattered to match the place's NLCD
      cover ("mostly wooded" → dense pines).

   Everything is fetched only when the button is pressed; the map
   itself still loads nothing at runtime.
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

  async function arc(url, params) {
    const body = new URLSearchParams({ f: "json", ...params });
    const r = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "service error");
    return j.features || [];
  }

  // ---- 1. The real boundary --------------------------------------
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
    // Named: biggest wins (a preserve is many parcels; show the property).
    // Unnamed fallback: smallest containing polygon is the most specific.
    pool.sort((a, b) => named.length ? area(b) - area(a) : area(a) - area(b));
    return pool[0];
  }

  // ---- 2. Elevation ----------------------------------------------
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

  async function fetchHeights(bbox) {
    const [w, s, e, n] = bbox;
    const spanM = Math.max((e - w) * 111320 * Math.cos(s * Math.PI / 180),
                           (n - s) * 111320);
    const z = spanM > 3000 ? 12 : spanM > 1200 ? 13 : 14;
    const tl = tileXY(n, w, z), br = tileXY(s, e, z);
    const x0 = Math.floor(tl.x), y0 = Math.floor(tl.y);
    const cols = Math.floor(br.x) - x0 + 1, rows = Math.floor(br.y) - y0 + 1;
    if (cols * rows > 12) throw new Error("area too large");
    const cv = document.createElement("canvas");
    cv.width = cols * 256; cv.height = rows * 256;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    await Promise.all([...Array(cols * rows)].map((_, i) => {
      const tx = x0 + (i % cols), ty = y0 + Math.floor(i / cols);
      return loadImage(`${TILE(z)}${tx}/${ty}.png`)
        .then(im => cx.drawImage(im, (tx - x0) * 256, (ty - y0) * 256));
    }));
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    const H = new Float32Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const lng = w + (e - w) * gx / (GRID - 1);
        const lat = n - (n - s) * gy / (GRID - 1);
        const t = tileXY(lat, lng, z);
        const ix = Math.min(cv.width - 1, Math.max(0, Math.round((t.x - x0) * 256)));
        const iy = Math.min(cv.height - 1, Math.max(0, Math.round((t.y - y0) * 256)));
        const k = (iy * cv.width + ix) * 4;
        H[gy * GRID + gx] = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
      }
    return H;
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

  // ---- 3. Rasterise helpers --------------------------------------
  // Even-odd point-in-rings test — handles holes for free.
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

  function maskFromRings(rings, bbox) {
    const [w, s, e, n] = bbox;
    const M = new Uint8Array(GRID * GRID);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const lng = w + (e - w) * gx / (GRID - 1);
        const lat = n - (n - s) * gy / (GRID - 1);
        if (insideRings(rings, lng, lat)) M[gy * GRID + gx] = 1;
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

  // Sport courts get a flat colour and a little emoji sprite.
  const SPORT = [
    [/baseball|softball/,      2, "#d9c186", "⚾"],
    [/basketball/,             3, "#6b7d99", "🏀"],
    [/tennis/,                 4, "#b85c48", "🎾"],
    [/pickleball/,             5, "#4f9d8b", "🏓"],
    [/soccer|football/,        6, "#5c9e57", "⚽"],
    [/volleyball/,             7, "#c9a86b", "🏐"],
    [/./,                      8, "#7fa06f", "🏃"]          // generic pitch
  ];
  const KIND = { playground: [9, "#d99a4e", "🛝"],
                 swimming_pool: [10, "#4fa3c9", "🏊"],
                 dog_park: [11, "#a08a6b", "🐕"],
                 track: [12, "#b0876b", "🏃"] };
  const COURT_COLOR = {};
  for (const [, code, col] of SPORT) COURT_COLOR[code] = col;
  for (const k in KIND) COURT_COLOR[KIND[k][0]] = KIND[k][1];

  // Roads come straight from OpenStreetMap via Overpass — the ArcGIS
  // mirrors don't publish a drivable-roads layer. Best-effort: a park
  // with no reachable Overpass just renders without roads.
  async function fetchRoads(bbox) {
    const [w, s, e, n] = bbox;
    const q = `[out:json][timeout:10];way[highway~"^(motorway|trunk|primary|` +
      `secondary|tertiary|unclassified|residential|service|living_street)$"]` +
      `(${s},${w},${n},${e});out geom 300;`;
    const r = await fetch("https://overpass-api.de/api/interpreter",
      { method: "POST", body: "data=" + encodeURIComponent(q),
        headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const j = await r.json();
    return (j.elements || [])
      .filter(el => el.geometry)
      .map(el => ({ geometry: { paths: [el.geometry.map(g => [g.lon, g.lat])] } }));
  }

  async function fetchDressing(bbox) {
    const [w, s, e, n] = bbox;
    const env = JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n,
                                 spatialReference: { wkid: 4326 } });
    const common = { geometry: env, geometryType: "esriGeometryEnvelope",
                     inSR: "4326", outSR: "4326", outFields: "",
                     returnGeometry: "true", maxAllowableOffset: "0.00008",
                     resultRecordCount: "400" };
    const [trails, blue, water, leisure, roads] = await Promise.allSettled([
      arc(OSM6 + "OSM_NA_Trails/FeatureServer/0/query",
          { ...common, where: "highway IN ('path','track','bridleway')" }),
      arc(DEEP + "BlueBlazedHikingTrails/FeatureServer/0/query",
          { ...common, where: "1=1" }),
      arc(OSM6 + "OSM_NA_Water/FeatureServer/0/query", { ...common, where: "1=1" }),
      arc(OSM6 + "OSM_NA_Leisure/FeatureServer/0/query",
          { ...common, outFields: "leisure,sport",
            where: "leisure IN ('pitch','playground','swimming_pool'," +
                   "'dog_park','track')" }),
      fetchRoads(bbox)
    ]);
    const trailM = new Uint8Array(GRID * GRID);
    for (const r of [trails, blue])
      if (r.status === "fulfilled") rasterisePaths(r.value, bbox, trailM);
    const roadM = new Uint8Array(GRID * GRID);
    if (roads.status === "fulfilled") rasterisePaths(roads.value, bbox, roadM);
    const waterM = new Uint8Array(GRID * GRID);
    if (water.status === "fulfilled")
      for (const f of water.value)
        if (f.geometry && f.geometry.rings) {
          const m2 = maskFromRings(f.geometry.rings, bbox);
          for (let i = 0; i < waterM.length; i++) if (m2[i]) waterM[i] = 1;
        }
    // Courts: rasterise each pitch into a per-sport colour code and pin
    // an emoji sprite at its centroid cell.
    const courtM = new Uint8Array(GRID * GRID);
    const sprites = [];
    if (leisure.status === "fulfilled")
      for (const f of leisure.value) {
        if (!f.geometry || !f.geometry.rings) continue;
        const a = f.attributes || {};
        let code, emoji;
        if (a.leisure === "pitch") {
          const sport = String(a.sport || "").toLowerCase();
          const hit = SPORT.find(([re]) => re.test(sport)) || SPORT[SPORT.length - 1];
          code = hit[1]; emoji = hit[3];
        } else if (KIND[a.leisure]) {
          code = KIND[a.leisure][0]; emoji = KIND[a.leisure][2];
        } else continue;
        const m2 = maskFromRings(f.geometry.rings, bbox);
        for (let i = 0; i < courtM.length; i++) if (m2[i]) courtM[i] = code;
        let sx = 0, sy = 0, np = 0;
        for (const [x, y] of f.geometry.rings[0]) { sx += x; sy += y; np++; }
        const [cgx, cgy] = cellOf(bbox, sx / np, sy / np);
        if (cgx >= 0 && cgx < GRID && cgy >= 0 && cgy < GRID)
          sprites.push({ gx: cgx, gy: cgy, emoji });
      }
    return { trailM, waterM, roadM, courtM, sprites };
  }

  // ---- Satellite drape: sample real imagery per cell -----------------
  async function fetchSatTexture(bbox) {
    const [w, s, e, n] = bbox;
    const spanM = Math.max((e - w) * 111320 * Math.cos(s * Math.PI / 180),
                           (n - s) * 111320);
    const z = Math.max(13, Math.min(17, Math.round(17 - Math.log2(spanM / 700))));
    const tl = tileXY(n, w, z), br = tileXY(s, e, z);
    const x0 = Math.floor(tl.x), y0 = Math.floor(tl.y);
    const cols = Math.floor(br.x) - x0 + 1, rows = Math.floor(br.y) - y0 + 1;
    if (cols * rows > 20) throw new Error("too many imagery tiles");
    const cv = document.createElement("canvas");
    cv.width = cols * 256; cv.height = rows * 256;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    await Promise.all([...Array(cols * rows)].map((_, i) => {
      const tx = x0 + (i % cols), ty = y0 + Math.floor(i / cols);
      return loadImage("https://server.arcgisonline.com/ArcGIS/rest/services/" +
                       `World_Imagery/MapServer/tile/${z}/${ty}/${tx}`)
        .then(im => cx.drawImage(im, (tx - x0) * 256, (ty - y0) * 256));
    }));
    const px = cx.getImageData(0, 0, cv.width, cv.height).data;
    const tex = new Uint8ClampedArray(GRID * GRID * 3);
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const lng = w + (e - w) * gx / (GRID - 1);
        const lat = n - (n - s) * gy / (GRID - 1);
        const t = tileXY(lat, lng, z);
        const ix = Math.min(cv.width - 1, Math.max(0, Math.round((t.x - x0) * 256)));
        const iy = Math.min(cv.height - 1, Math.max(0, Math.round((t.y - y0) * 256)));
        const k = (iy * cv.width + ix) * 4, o = (gy * GRID + gx) * 3;
        tex[o] = px[k]; tex[o + 1] = px[k + 1]; tex[o + 2] = px[k + 2];
      }
    return tex;
  }

  // ---- 4. Drawing ------------------------------------------------
  function coverPalette(p) {
    const c = ((p.attrs || {}).cover || "").toLowerCase();
    if (c.includes("wood")) return { lo: [52, 96, 62], hi: [140, 182, 118] };
    if (c.includes("open")) return { lo: [128, 138, 76], hi: [212, 203, 130] };
    return { lo: [76, 108, 74], hi: [178, 195, 140] };
  }
  function treeDensity(p) {
    const c = ((p.attrs || {}).cover || "").toLowerCase();
    if (c.includes("wood")) return 0.16;
    if (c.includes("mixed")) return 0.09;
    if (c.includes("open")) return 0.03;
    return 0.07;
  }
  const hexRgb = h => [parseInt(h.slice(1, 3), 16),
                       parseInt(h.slice(3, 5), 16),
                       parseInt(h.slice(5, 7), 16)];

  const hash = (gx, gy) => {
    let h = (gx * 73856093) ^ (gy * 19349663);
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };

  function draw(canvas, S, yaw) {
    const { H, inside, trailM, waterM, roadM, courtM, dropM, edge, p,
            spriteAt, tex } = S;
    const useSat = S.useSat && tex;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, Hh = canvas.height;
    ctx.clearRect(0, 0, W, Hh);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < H.length; i++)
      if (inside[i]) { if (H[i] < min) min = H[i]; if (H[i] > max) max = H[i]; }
    if (min === Infinity) { min = 0; max = 1; }
    const span = Math.max(max - min, 8);
    const pal = coverPalette(p);
    const density = treeDensity(p);
    let waterLevel = Infinity;
    for (let i = 0; i < H.length; i++)
      if (inside[i] && waterM[i] && H[i] < waterLevel) waterLevel = H[i];

    const s = W / (GRID * 1.9);
    const zScale = Math.min(60, 9000 / span) * (span / 90);
    const cx = W / 2, cy = Hh * 0.60;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);

    const order = [];
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        if (!inside[gy * GRID + gx]) continue;
        const rx = (gx - GRID / 2) * cos - (gy - GRID / 2) * sin;
        const ry = (gx - GRID / 2) * sin + (gy - GRID / 2) * cos;
        order.push([ry, rx, gx, gy]);
      }
    order.sort((a, b) => a[0] - b[0]);

    const w = s * 1.62, hgt = s * .92;
    for (const [ry, rx, gx, gy] of order) {
      const i = gy * GRID + gx;
      let h = H[i];
      const isWater = waterM[i] && (h <= waterLevel + 4);
      if (isWater) h = waterLevel;
      const t = (h - min) / span;
      const X = cx + rx * s * 1.55;
      const Y = cy + ry * s * .8 - t * zScale;

      let r, g, b;
      const nb = H[gy * GRID + Math.max(0, gx - 1)];
      const sh = Math.max(-14, Math.min(18, (h - nb) * 1.6));
      if (useSat) {
        // Real imagery draped over the height field, hillshade kept so
        // the relief still reads. Water/trail/road/court tints blend in
        // at half strength so the overlays stay legible on photo ground.
        const o = i * 3;
        r = tex[o] + sh; g = tex[o + 1] + sh; b = tex[o + 2] + sh;
        let tint = null;
        if (isWater) tint = [56, 116, 172];
        else if (courtM[i]) tint = hexRgb(COURT_COLOR[courtM[i]]);
        else if (roadM[i]) tint = [154, 160, 166];
        else if (trailM[i]) tint = [196, 168, 122];
        if (tint) { r = (r + tint[0]) / 2; g = (g + tint[1]) / 2; b = (b + tint[2]) / 2; }
      } else if (isWater) {
        const rip = Math.sin(gx * 1.3 + gy * 2.1) * 6;
        r = 56 + rip; g = 116 + rip; b = 172;
      } else if (courtM[i]) {
        [r, g, b] = hexRgb(COURT_COLOR[courtM[i]]);
        r += sh * .5; g += sh * .5; b += sh * .5;
      } else if (roadM[i]) {
        r = 148; g = 152; b = 158;                    // asphalt grey
      } else if (trailM[i]) {
        r = 196; g = 168; b = 122;                    // worn-path tan
      } else {
        r = pal.lo[0] + (pal.hi[0] - pal.lo[0]) * t;
        g = pal.lo[1] + (pal.hi[1] - pal.lo[1]) * t;
        b = pal.lo[2] + (pal.hi[2] - pal.lo[2]) * t;
        r += sh; g += sh; b += sh;
      }
      // Side face first: a darker column reaching down far enough that
      // the cells drawn in front always overlap it — so the terrain is a
      // connected blocky solid instead of floating top faces you could
      // see between. Edge columns drop further, giving the island sides.
      const i2 = gy * GRID + gx;
      const skirt = (dropM[i2] / span) * zScale
                  + (edge[i2] ? zScale * .12 + s * 2.4 : 1.6);
      ctx.fillStyle = `rgb(${r * .55 | 0},${g * .55 | 0},${b * .55 | 0})`;
      ctx.fillRect(X - w / 2, Y, w + .7, skirt + hgt);
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(X - w / 2, Y - hgt / 2, w + .7, hgt + .7);

      // A sprite tree, drawn straight after its own cell so nearer rows
      // paint over it correctly. Density follows the NLCD cover.
      const sp = spriteAt && spriteAt.get(i);
      if (sp) {
        // Court emoji, drawn straight after its cell for correct depth.
        ctx.font = `${Math.max(14, s * 3.4) | 0}px system-ui`;
        ctx.textAlign = "center";
        ctx.fillText(sp, X, Y - s * .8);
      }
      if (!useSat && !sp && !isWater && !trailM[i] && !roadM[i] && !courtM[i]
          && hash(gx, gy) < density) {
        const jx = (hash(gx + 7, gy) - .5) * w * .6;
        const th = s * (1.5 + hash(gx, gy + 3));      // tree height varies
        const half = s * .55;
        const shade = 24 * hash(gx + 1, gy + 1);
        ctx.fillStyle = `rgb(${58 + shade | 0},${44 + shade * .6 | 0},30)`;
        ctx.fillRect(X + jx - s * .08, Y - th * .35, s * .16, th * .4);
        ctx.fillStyle = `rgb(${30 + shade | 0},${96 + shade | 0},${46 + shade * .8 | 0})`;
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

    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = "11px system-ui";
    ctx.fillText(`${Math.round(min)}–${Math.round(max)} m`, 10, Hh - 10);
  }

  // ---- 5. Open ----------------------------------------------------
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
          <span>Elevation: AWS Terrain Tiles · boundary &amp; features fetched on demand</span>
          <button id="isoClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const canvas = ov.querySelector("canvas");
    const sub = ov.querySelector(".iso-sub");
    const close = () => { cancelAnimationFrame(raf); ov.remove(); };
    ov.querySelector("#isoClose").addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });

    const spin = document.createElement("div");
    spin.className = "iso-spin";
    ov.querySelector("#isoPanel").insertBefore(spin, canvas);
    canvas.style.display = "none";

    // Boundary → bbox → heights + dressing, all best-effort.
    let boundary = null;
    try { boundary = await fetchBoundary(p); } catch (e) { /* fall through */ }
    let bbox, inside;
    if (boundary) {
      let w = 180, s2 = 90, e2 = -180, n2 = -90;
      for (const ring of boundary.rings)
        for (const [x, y] of ring) {
          if (x < w) w = x; if (x > e2) e2 = x;
          if (y < s2) s2 = y; if (y > n2) n2 = y;
        }
      const padX = (e2 - w) * .08 + 1e-4, padY = (n2 - s2) * .08 + 1e-4;
      bbox = [w - padX, s2 - padY, e2 + padX, n2 + padY];
      inside = maskFromRings(boundary.rings, bbox);
    } else {
      const acres = Number(p.acres) || 60;
      const sideM = Math.min(Math.max(Math.sqrt(acres * 4046.86) * 1.6, 500), 6000);
      const mPerDeg = 111320 * Math.cos(p.lat * Math.PI / 180);
      const dLng = sideM / mPerDeg / 2, dLat = sideM / 111320 / 2;
      bbox = [p.lng - dLng, p.lat - dLat, p.lng + dLng, p.lat + dLat];
      inside = new Uint8Array(GRID * GRID).fill(1);
    }

    // Scale the voxel grid to the terrain: ~9 m per cell, clamped so a
    // pocket park stays chunky-cute and a state forest stays smooth
    // enough to read (and the per-frame sort stays affordable).
    {
      const [w, s2, e2, n2] = bbox;
      const spanM = Math.max((e2 - w) * 111320 * Math.cos(s2 * Math.PI / 180),
                             (n2 - s2) * 111320);
      GRID = Math.max(96, Math.min(192, Math.round(spanM / 9)));
      inside = boundary ? maskFromRings(boundary.rings, bbox)
                        : new Uint8Array(GRID * GRID).fill(1);
    }

    let H;
    try { H = await fetchHeights(bbox); }
    catch (e) { H = proceduralHeights(p); }
    let dressing = { trailM: new Uint8Array(GRID * GRID),
                     waterM: new Uint8Array(GRID * GRID),
                     roadM: new Uint8Array(GRID * GRID),
                     courtM: new Uint8Array(GRID * GRID), sprites: [] };
    try { dressing = await fetchDressing(bbox); } catch (e) { /* optional */ }

    const nTrail = dressing.trailM.reduce((a, b) => a + b, 0);
    const nWater = dressing.waterM.reduce((a, b) => a + b, 0);
    const nRoad = dressing.roadM.reduce((a, b) => a + b, 0);
    sub.textContent = [
      boundary ? `boundary: ${boundary.label}` : "no boundary found — square sample",
      nTrail ? "trails" : null, nRoad ? "roads" : null, nWater ? "water" : null,
      dressing.sprites.length ? `${dressing.sprites.length} facilities` : null,
      ((p.attrs || {}).cover || null), "drag to rotate"
    ].filter(Boolean).join(" · ");

    // Minecraft-style solid sides: how far each column must extend down
    // so no gap opens between it and the cells drawn in front of it.
    // Boundary columns get a thick skirt so the island reads as a slab.
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

    spin.remove();
    canvas.style.display = "";

    // Sprite lookup by cell index, for depth-correct drawing.
    const spriteAt = new Map();
    for (const sp of dressing.sprites)
      spriteAt.set(sp.gy * GRID + sp.gx, sp.emoji);

    const S = { H, inside, ...dressing, dropM, edge, p, spriteAt,
                useSat: false, tex: null };

    // 🛰 toggle: drape real imagery over the terrain. Fetched lazily on
    // first use; if the imagery can't be read (offline, CORS) the button
    // apologises and stays in game mode.
    const satBtn = document.createElement("button");
    satBtn.id = "isoSat";
    satBtn.textContent = "🛰 Satellite";
    ov.querySelector(".iso-foot").insertBefore(satBtn, ov.querySelector("#isoClose"));
    satBtn.addEventListener("click", async () => {
      if (S.useSat) { S.useSat = false; satBtn.classList.remove("active"); return; }
      if (!S.tex) {
        satBtn.textContent = "🛰 loading…";
        try { S.tex = await fetchSatTexture(bbox); }
        catch (e) { satBtn.textContent = "🛰 unavailable"; return; }
        satBtn.textContent = "🛰 Satellite";
      }
      S.useSat = true; satBtn.classList.add("active");
    });
    let yaw = 0, target = 0, dragging = false, lastX = 0;
    canvas.addEventListener("pointerdown", e => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => { if (dragging) { target += (e.clientX - lastX) * .008; lastX = e.clientX; } });
    canvas.addEventListener("pointerup", () => dragging = false);
    const loop = () => {
      if (!document.getElementById("isoOverlay")) return;
      if (!dragging) target += 0.0012;
      yaw += (target - yaw) * .15;
      draw(canvas, S, yaw);
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  return { open };
})();
window.EveryParkIso = EveryParkIso;
