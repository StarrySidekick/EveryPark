/* CT Parks Explorer — core logic.
   Customization lives in config.js; you shouldn't need to edit this file. */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------
  document.title = CONFIG.siteTitle;
  document.getElementById("siteTitle").textContent = CONFIG.siteTitle;
  document.getElementById("tagline").textContent = CONFIG.tagline;

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--state", CONFIG.colors.state);
  rootStyle.setProperty("--national", CONFIG.colors.national);
  rootStyle.setProperty("--town", CONFIG.colors.town);
  rootStyle.setProperty("--cemetery", CONFIG.colors.cemetery);
  rootStyle.setProperty("--accent", CONFIG.colors.accent);

  const map = L.map("map", { zoomControl: true }).setView(CONFIG.mapCenter, CONFIG.mapZoom);
  const baseLayers = {};
  CONFIG.basemaps.forEach((b, i) => {
    const parts = [L.tileLayer(b.url, { attribution: b.attribution, maxZoom: 19 })];
    if (b.labelsUrl) parts.push(L.tileLayer(b.labelsUrl, { maxZoom: 19 }));
    baseLayers[b.label] = L.layerGroup(parts);
    if (i === 0) baseLayers[b.label].addTo(map);
  });
  L.control.layers(baseLayers, null, { position: "bottomright" }).addTo(map);

  const icons = {};
  for (const [key, def] of Object.entries(CONFIG.icons)) {
    icons[key] = L.icon({
      iconUrl: def.file,
      iconSize: [def.size, def.size],
      iconAnchor: [def.size / 2, def.size / 2],
      popupAnchor: [0, -def.size / 2]
    });
  }

  const cluster = L.markerClusterGroup({
    maxClusterRadius: 46,
    showCoverageOnHover: false,
    iconCreateFunction: (c) => L.divIcon({
      html: `<div class="cluster-icon" style="width:${34 + Math.min(c.getChildCount(), 60) / 4}px;height:${34 + Math.min(c.getChildCount(), 60) / 4}px">${c.getChildCount()}</div>`,
      className: "",
      iconSize: null
    })
  });
  map.addLayer(cluster);

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const allParks = [];          // {name, type, lat, lng, town, acres, url, marker}
  const activeTypes = new Set(["state", "national", "town"]);   // cemeteries off by default
  let searchTerm = "";
  let townIndex = null;         // for point-in-polygon town lookup

  const statusEl = document.getElementById("status");
  const listEl = document.getElementById("parkList");
  const metaEl = document.getElementById("listMeta");

  function showStatus(msg) { statusEl.textContent = msg; statusEl.style.display = "block"; }
  function hideStatus() { statusEl.style.display = "none"; }

  // ------------------------------------------------------------------
  // Town lookup (point-in-polygon on simplified town boundaries)
  // ------------------------------------------------------------------
  function buildTownIndex(geojson) {
    townIndex = geojson.features.map(f => {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      let minX = 180, minY = 90, maxX = -180, maxY = -90;
      for (const poly of polys) for (const pt of poly[0]) {
        if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minY) minY = pt[1]; if (pt[1] > maxY) maxY = pt[1];
      }
      return { name: f.properties.name, polys, bbox: [minX, minY, maxX, maxY] };
    });
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function findTown(lat, lng) {
    if (!townIndex) return "";
    for (const t of townIndex) {
      const b = t.bbox;
      if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
      for (const poly of t.polys) {
        if (pointInRing(lng, lat, poly[0])) {
          let inHole = false;
          for (let h = 1; h < poly.length; h++) if (pointInRing(lng, lat, poly[h])) { inHole = true; break; }
          if (!inHole) return t.name;
        }
      }
    }
    return "";
  }

  // ------------------------------------------------------------------
  // Park plumbing
  // ------------------------------------------------------------------
  function linksFor(p) {
    const dir = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    let links = `<a href="${dir}" target="_blank" rel="noopener">Directions</a>`;
    if (p.url) {
      links += `<a href="${p.url}" target="_blank" rel="noopener">Official site</a>`;
    } else {
      const q = encodeURIComponent(`${p.name} ${p.town || ""} CT`);
      links += `<a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">More info</a>`;
    }
    return links;
  }

  function typeLabel(p) {
    if (p.type === "state") return p.subtype || "State Park";
    if (p.type === "national") return "National Park Site";
    if (p.type === "cemetery") return p.subtype || "Cemetery";
    return "Town / City Park";
  }

  function tagsHtml(p) {
    if (!p.attrs) return "";
    const t = [];
    const A = p.attrs;
    if (A.water) t.push(`🌊 ${A.waterName || "Waterfront"}`);
    if (A.beach) t.push("🏖️ Beach");
    if (A.trails) t.push("🥾 Trails");
    if (A.sportList && A.sportList.length) t.push("🏀 " + A.sportList.slice(0, 5).join(", "));
    if (A.playground) t.push("🛝 Playground");
    if (A.dogpark) t.push("🐕 Dog park");
    if (A.pool) t.push("🏊 Pool");
    if (A.historic) t.push("🏛️ Historic");
    if (!t.length) return "";
    return `<div class="popup-tags">${t.map(x => `<span class="tag">${x}</span>`).join("")}</div>`;
  }

  function feeHtml(p) {
    if (p.type === "state") return `<div class="popup-fee">🅿️ CT-registered vehicles park free (Passport to the Parks); out-of-state $7–22. Camping/special facilities extra.</div>`;
    if (p.type === "national") return `<div class="popup-fee">🎟️ Free admission.</div>`;
    return "";
  }

  function popupHtml(p) {
    const acres = p.acres ? ` &middot; ${Number(p.acres).toLocaleString()} acres` : "";
    return `
      <span class="badge ${p.type}">${typeLabel(p)}</span>
      <div class="popup-name">${p.name}</div>
      <div class="popup-sub">${p.town || "Connecticut"}${acres}</div>
      ${tagsHtml(p)}${feeHtml(p)}
      <div class="popup-links">${linksFor(p)}</div>`;
  }

  function addPark(p) {
    p.marker = L.marker([p.lat, p.lng], { icon: icons[p.type], title: p.name })
      .bindPopup(popupHtml(p));
    allParks.push(p);
  }

  // ------------------------------------------------------------------
  // Filtering + list rendering
  // ------------------------------------------------------------------
  const activeAttrs = new Set();   // feature filters (water, trails, …)

  function visible(p) {
    if (!activeTypes.has(p.type)) return false;
    for (const a of activeAttrs) if (!p.attrs || !p.attrs[a]) return false;
    if (!searchTerm) return true;
    return (p.name + " " + (p.town || "")).toLowerCase().includes(searchTerm);
  }

  function refresh() {
    const shown = [];
    cluster.clearLayers();
    const batch = [];
    for (const p of allParks) {
      if (visible(p)) { batch.push(p.marker); shown.push(p); }
    }
    cluster.addLayers(batch);

    shown.sort((a, b) => a.name.localeCompare(b.name));
    const frag = document.createDocumentFragment();
    for (const p of shown.slice(0, 800)) {
      const div = document.createElement("div");
      div.className = "park-item";
      div.innerHTML = `<img src="${CONFIG.icons[p.type].file}" alt="">
        <div><div class="pi-name">${p.name}</div>
        <div class="pi-sub">${typeLabel(p)}${p.town ? " · " + p.town : ""}</div></div>`;
      div.addEventListener("click", () => {
        map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), 13), { duration: 0.7 });
        setTimeout(() => { cluster.zoomToShowLayer(p.marker, () => p.marker.openPopup()); }, 750);
        if (window.innerWidth <= 760) document.getElementById("listPanel").classList.add("hidden");
      });
      frag.appendChild(div);
    }
    listEl.replaceChildren(frag);
    metaEl.textContent = `${shown.length.toLocaleString()} parks shown` +
      (shown.length > 800 ? " (list capped at 800 — use search to narrow)" : "");
  }

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  async function loadStatic() {
    const [stateData, natData, towns] = await Promise.all([
      fetch("data/state.json").then(r => r.json()),
      fetch("data/national.json").then(r => r.json()),
      fetch("data/towns.geojson").then(r => r.json())
    ]);

    buildTownIndex(towns);
    if (CONFIG.townBorders.show) {
      L.geoJSON(towns, {
        style: {
          color: CONFIG.townBorders.color,
          weight: CONFIG.townBorders.weight,
          opacity: CONFIG.townBorders.opacity,
          fill: false,
          interactive: false
        }
      }).addTo(map);
    }

    for (const s of stateData.parks) {
      addPark({
        name: s.n, type: "state", subtype: s.t, lat: s.lat, lng: s.lng,
        acres: s.a || null, town: findTown(s.lat, s.lng)
      });
    }
    for (const n of natData.parks) {
      addPark({ name: n.n, type: "national", lat: n.lat, lng: n.lng, town: n.town, url: n.url });
    }
    refresh();
  }

  // Municipal parks: live from OpenStreetMap via Esri's mirror, cached locally.
  const CACHE_KEY = "ctparks_municipal_v3";

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && Date.now() - c.time < CONFIG.municipal.cacheDays * 864e5) return c.parks;
    } catch (e) { /* ignore */ }
    return null;
  }

  // Excluded from the municipal layer:
  //  - state/national lands (shown via their own layers)
  //  - members-only places: clubs, beach/lake associations, HOAs.
  //    Rule of thumb: paid-but-open-to-anyone stays; exclusive-entry goes.
  const EXCLUDE = new RegExp(
    "state (park|forest)|scenic reserve|national (park|historical|scenic)|" +
    "\\bclub\\b|racquet|members only|homeowners|\\bhoa\\b|" +
    "(beach|lake|shore|point|improvement) association", "i");
  // Public parks that would wrongly trip the EXCLUDE rules (e.g. town-owned
  // parks with "Club" in the name). Add lowercase names here to keep them.
  const ALLOW = new Set([
    "westport longshore club park",
    "longshore club park"
  ]);
  const PRIVATE_ACCESS = new Set(["private", "no", "members", "customers"]);

  async function fetchMunicipal() {
    const cached = readCache();
    if (cached) { integrateMunicipal(cached, false); return; }
    if (!CONFIG.municipal.enabled) return;

    showStatus("Loading town & city parks from OpenStreetMap…");
    const parks = [];
    let offset = 0;
    const page = 1000;
    try {
      for (let i = 0; i < 20; i++) {   // safety cap: 20k features
        const body = new URLSearchParams({
          where: "leisure='park' AND name IS NOT NULL AND (access IS NULL OR access NOT IN ('private','no'))",
          geometry: "-73.75,40.95,-71.77,42.06",
          geometryType: "esriGeometryEnvelope",
          inSR: "4326",
          outSR: "4326",
          outFields: "name,access,website,Shape__Area",
          returnGeometry: "false",
          returnCentroid: "true",
          resultOffset: String(offset),
          resultRecordCount: String(page),
          f: "json"
        });
        const r = await fetch(CONFIG.municipal.serviceUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body
        });
        const j = await r.json();
        if (j.error || !j.features) break;
        for (const f of j.features) {
          const a = f.attributes;
          const c = f.centroid;
          if (!a.name || !c) continue;
          if (EXCLUDE.test(a.name) && !ALLOW.has(a.name.toLowerCase())) continue;
          if (a.access && PRIVATE_ACCESS.has(String(a.access).toLowerCase())) continue;
          const p = { n: a.name, lat: +c.y.toFixed(5), lng: +c.x.toFixed(5) };
          if (a.Shape__Area) {
            // Web-Mercator areas are inflated by 1/cos^2(lat); correct it.
            const k = Math.cos(c.y * Math.PI / 180);
            const acres = a.Shape__Area * k * k * 0.000247105;
            if (acres >= 1) p.a = Math.round(acres);
          }
          if (a.website && /^https?:\/\//i.test(a.website)) p.w = a.website;
          parks.push(p);
        }
        if (!j.exceededTransferLimit && j.features.length < page) break;
        offset += page;
      }
      // de-duplicate identical name at nearly identical location
      const seen = new Set();
      const unique = parks.filter(p => {
        const k = p.n.toLowerCase() + "|" + Math.round(p.lat * 500) + "|" + Math.round(p.lng * 500);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), parks: unique })); } catch (e) {}
      integrateMunicipal(unique, true);
    } catch (err) {
      hideStatus();
      console.warn("Municipal park load failed:", err);
      showStatus("Couldn't load town parks right now — state & national parks still shown.");
      setTimeout(hideStatus, 5000);
    }
  }

  function integrateMunicipal(parks, fresh) {
    for (const m of parks) {
      const town = findTown(m.lat, m.lng);
      if (!town) continue;               // discard points outside CT borders
      addPark({ name: m.n, type: "town", lat: m.lat, lng: m.lng, town,
                acres: m.a || null, url: m.w || null });
    }
    refresh();
    hideStatus();
    if (fresh) {
      showStatus(`Loaded ${parks.length.toLocaleString()} town & city parks`);
      setTimeout(hideStatus, 3500);
    }
  }

  // ------------------------------------------------------------------
  // Cemeteries & historic burying grounds (public land that isn't a park)
  // ------------------------------------------------------------------
  const CEM_CACHE = "ctparks_cem_v1";
  // Colonial-era burying grounds are worth calling out separately.
  const BURYING_RE = /burying|burial ground|old cemetery|ancient/i;

  function fetchCemeteries() {
    return cachedDataset(CEM_CACHE, CONFIG.municipal.cacheDays, async () => {
      const out = [];
      await pagedQuery(CONFIG.cemeteries.serviceUrl, {
        where: "landuse='cemetery' AND name IS NOT NULL AND " +
               "(access IS NULL OR access NOT IN ('private','no'))",
        outFields: "name,website,Shape__Area",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        const a = f.attributes, c = f.centroid;
        if (!a.name || !c) return;
        const lat = +c.y.toFixed(5);
        const rec = { n: a.name, lat, lng: +c.x.toFixed(5) };
        if (a.Shape__Area) {
          const k = Math.cos(lat * Math.PI / 180);
          const acres = a.Shape__Area * k * k * 0.000247105;
          if (acres >= 1) rec.a = Math.round(acres);
        }
        if (a.website && /^https?:\/\//i.test(a.website)) rec.w = a.website;
        out.push(rec);
      });
      return out;
    });
  }

  async function loadCemeteries() {
    if (!CONFIG.cemeteries.enabled) return;
    try {
      const cems = await fetchCemeteries();
      const seen = new Set();
      for (const m of cems) {
        const key = m.n.toLowerCase() + "|" + Math.round(m.lat * 500) + "|" + Math.round(m.lng * 500);
        if (seen.has(key)) continue;
        seen.add(key);
        const town = findTown(m.lat, m.lng);
        if (!town) continue;
        addPark({
          name: m.n, type: "cemetery", lat: m.lat, lng: m.lng, town,
          acres: m.a || null, url: m.w || null,
          subtype: BURYING_RE.test(m.n) ? "Historic Burying Ground" : "Cemetery",
          attrs: { historic: BURYING_RE.test(m.n) }
        });
      }
      refresh();
    } catch (err) {
      console.warn("Cemetery load failed:", err);
    }
  }

  // ------------------------------------------------------------------
  // Attribute enrichment: sports, trails, water, historic, beach
  // Raw layers pulled once from OpenStreetMap mirrors, cached 7 days.
  // ------------------------------------------------------------------
  const CT_BBOX = "-73.75,40.95,-71.77,42.06";
  const SHORE_TOWNS = new Set(["Greenwich","Stamford","Darien","Norwalk","Westport",
    "Fairfield","Bridgeport","Stratford","Milford","West Haven","New Haven","East Haven",
    "Branford","Guilford","Madison","Clinton","Westbrook","Old Saybrook","Old Lyme",
    "East Lyme","Waterford","New London","Groton","Stonington"]);
  const HISTORIC_RE = /\bfort\b|castle|battle|memorial|monument|historic|heritage|lighthouse|\bmill\b|homestead|birthplace|colonial|revolutionary|\bgreen\b$/i;
  const SPORT_LABEL = {
    soccer: "soccer", baseball: "baseball", softball: "softball", basketball: "basketball",
    tennis: "tennis", pickleball: "pickleball", volleyball: "volleyball", football: "football",
    american_football: "football", skateboard: "skate park", golf: "golf", disc_golf: "disc golf",
    bocce: "bocce", cricket: "cricket", lacrosse: "lacrosse", hockey: "hockey",
    ice_hockey: "ice hockey", equestrian: "equestrian", athletics: "track", running: "track",
    multi: "multi-sport", swimming: "swimming", shuffleboard: "shuffleboard", badminton: "badminton",
    horseshoes: "horseshoes", field_hockey: "field hockey", rugby: "rugby", handball: "handball",
    beachvolleyball: "beach volleyball", table_tennis: "table tennis"
  };

  function distM(lat1, lng1, lat2, lng2) {
    const kx = 111320 * Math.cos(lat1 * Math.PI / 180), ky = 110574;
    const dx = (lng2 - lng1) * kx, dy = (lat2 - lat1) * ky;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function makeGrid(cellDeg) {
    const cells = new Map();
    return {
      add(lat, lng, item) {
        const k = Math.floor(lat / cellDeg) + "," + Math.floor(lng / cellDeg);
        let arr = cells.get(k);
        if (!arr) { arr = []; cells.set(k, arr); }
        arr.push([lat, lng, item]);
      },
      near(lat, lng, radiusM) {
        const span = Math.ceil(radiusM / 111000 / cellDeg) + 1;
        const ci = Math.floor(lat / cellDeg), cj = Math.floor(lng / cellDeg);
        const out = [];
        for (let i = ci - span; i <= ci + span; i++)
          for (let j = cj - span; j <= cj + span; j++) {
            const arr = cells.get(i + "," + j);
            if (!arr) continue;
            for (const [la, ln, item] of arr) {
              const d = distM(lat, lng, la, ln);
              if (d <= radiusM) out.push([d, item]);
            }
          }
        return out;
      }
    };
  }

  function cachedDataset(key, days, fetcher) {
    try {
      const c = JSON.parse(localStorage.getItem(key));
      if (c && Date.now() - c.time < days * 864e5) return Promise.resolve(c.data);
    } catch (e) { /* ignore */ }
    return fetcher().then(data => {
      try { localStorage.setItem(key, JSON.stringify({ time: Date.now(), data })); } catch (e) {}
      return data;
    });
  }

  async function pagedQuery(url, extraParams, perFeature) {
    let offset = 0;
    for (let i = 0; i < 30; i++) {
      const body = new URLSearchParams(Object.assign({
        geometry: CT_BBOX, geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326",
        resultOffset: String(offset), resultRecordCount: "1000", f: "json"
      }, extraParams));
      const r = await fetch(url, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const j = await r.json();
      if (j.error || !j.features || !j.features.length) break;
      for (const f of j.features) perFeature(f);
      if (!j.exceededTransferLimit && j.features.length < 1000) break;
      offset += 1000;
    }
  }

  function fetchFacilities() {
    return cachedDataset("ctparks_fac_v1", CONFIG.municipal.cacheDays, async () => {
      const out = [];
      await pagedQuery(CONFIG.municipal.serviceUrl, {
        where: "leisure IN ('pitch','track','swimming_pool','playground','dog_park'," +
               "'sports_centre','fitness_station','beach_resort') AND " +
               "(access IS NULL OR access NOT IN ('private','no'))",
        outFields: "leisure,sport", returnGeometry: "false", returnCentroid: "true"
      }, f => {
        if (!f.centroid) return;
        out.push([+f.centroid.y.toFixed(5), +f.centroid.x.toFixed(5),
                  f.attributes.leisure || "", f.attributes.sport || ""]);
      });
      return out;
    });
  }

  function fetchTrails() {
    return cachedDataset("ctparks_trl_v1", CONFIG.municipal.cacheDays, async () => {
      const pts = [];
      await pagedQuery(CONFIG.enrichment.trailsUrl, {
        where: "name IS NOT NULL", outFields: "OBJECTID",
        returnGeometry: "true", maxAllowableOffset: "0.002", geometryPrecision: "4"
      }, f => {
        const paths = f.geometry && f.geometry.paths;
        if (!paths) return;
        for (const path of paths)
          for (let i = 0; i < path.length; i += 2)   // every other vertex is plenty
            pts.push([path[i][1], path[i][0]]);
      });
      return pts;
    });
  }

  function fetchWater() {
    return cachedDataset("ctparks_wtr_v1", CONFIG.municipal.cacheDays, async () => {
      const out = [];
      await pagedQuery(CONFIG.enrichment.waterUrl, {
        where: "name IS NOT NULL", outFields: "name,Shape__Area",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        if (!f.centroid || !f.attributes.name) return;
        const lat = +f.centroid.y.toFixed(5);
        const k = Math.cos(lat * Math.PI / 180);
        const area = (f.attributes.Shape__Area || 0) * k * k;   // true m²
        if (area < 2000) return;                                // skip puddles
        out.push([lat, +f.centroid.x.toFixed(5),
                  f.attributes.name, Math.round(Math.sqrt(area / Math.PI))]);
      });
      return out;
    });
  }

  function parkRadiusM(p) {
    if (!p.acres) return 120;
    return Math.min(2200, Math.max(90, Math.sqrt(p.acres * 4047 / Math.PI)));
  }

  async function enrich() {
    if (!CONFIG.enrichment.enabled) return;
    showStatus("Analyzing parks: sports, trails & water…");
    try {
      const [fac, trl, wtr, coast] = await Promise.all([
        fetchFacilities(), fetchTrails(), fetchWater(),
        fetch("data/coast.json").then(r => r.json()).catch(() => ({ pts: [] }))
      ]);

      const facGrid = makeGrid(0.01), trlGrid = makeGrid(0.01),
            wtrGrid = makeGrid(0.02), cstGrid = makeGrid(0.01);
      for (const [la, ln, leis, sp] of fac) facGrid.add(la, ln, [leis, sp]);
      for (const [la, ln] of trl) trlGrid.add(la, ln, 1);
      for (const [la, ln, nm, rad] of wtr) wtrGrid.add(la, ln, [nm, rad]);
      for (const [ln, la] of coast.pts || []) cstGrid.add(la, ln, 1);

      for (const p of allParks) {
        const r = parkRadiusM(p);
        const A = p.attrs = p.attrs || {};

        // sports & amenities
        const sports = new Set();
        for (const [, [leis, sp]] of facGrid.near(p.lat, p.lng, r + 140)) {
          if (leis === "playground") { A.playground = true; continue; }
          if (leis === "dog_park") { A.dogpark = true; continue; }
          if (leis === "swimming_pool") { A.pool = true; sports.add("swimming"); continue; }
          if (leis === "beach_resort") { A.beach = true; continue; }
          if (leis === "track") { sports.add("track"); continue; }
          if (sp) for (const s of sp.split(";")) {
            const lbl = SPORT_LABEL[s.trim()] || null;
            if (lbl) sports.add(lbl);
          }
          else if (leis === "pitch") sports.add("ball field");
        }
        if (sports.size) { A.sports = true; A.sportList = [...sports]; }

        // trails
        if (trlGrid.near(p.lat, p.lng, r + 240).length) A.trails = true;

        // inland water: nearest named waterbody whose edge comes close
        let best = null;
        for (const [d, [nm, rad]] of wtrGrid.near(p.lat, p.lng, r + 2400)) {
          const edge = d - rad;
          if (edge < r + 150 && (!best || edge < best[0])) best = [edge, nm];
        }
        if (best) { A.water = true; A.waterName = best[1]; }

        // coast
        if (SHORE_TOWNS.has(p.town) &&
            cstGrid.near(p.lat, p.lng, Math.max(r + 250, 700)).length) {
          A.water = true;
          A.waterName = "Long Island Sound";
        }
        if (/beach/i.test(p.name)) A.beach = true;
        if (A.beach) A.water = A.water || true;

        // historic
        if (HISTORIC_RE.test(p.name) || /Historic/i.test(p.subtype || "")) A.historic = true;

        p.marker.setPopupContent(popupHtml(p));
      }
      hideStatus();
      refresh();
    } catch (err) {
      console.warn("Enrichment failed:", err);
      hideStatus();
    }
  }

  // ------------------------------------------------------------------
  // Park boundary overlays (actual shapes) — load per viewport when
  // zoomed in, so the map stays fast. State + town, color-coded.
  // ------------------------------------------------------------------
  const overlayLayer = L.layerGroup().addTo(map);
  const loadedOverlayIds = new Set();
  let overlayTimer = null;

  function overlayStyle(kind) {
    const color = CONFIG.colors[kind];
    return { color, weight: 1.6, opacity: 0.9,
             fillColor: color, fillOpacity: CONFIG.overlays.fillOpacity };
  }

  async function fetchOverlayGeojson(url, params) {
    const body = new URLSearchParams(Object.assign({
      geometryType: "esriGeometryEnvelope", inSR: "4326", outSR: "4326",
      maxAllowableOffset: "0.00008", resultRecordCount: "800", f: "geojson"
    }, params));
    const r = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.json();
  }

  function addOverlayFeatures(gj, kind, nameProp, labelFn) {
    if (!gj || !gj.features) return;
    for (const f of gj.features) {
      const id = kind + ":" + (f.id || (f.properties && (f.properties.OBJECTID || f.properties.name)) || JSON.stringify(f.properties));
      if (loadedOverlayIds.has(id)) continue;
      const nm = f.properties ? f.properties[nameProp] : null;
      if (kind === "town" && nm && EXCLUDE.test(nm) && !ALLOW.has(nm.toLowerCase())) continue;
      loadedOverlayIds.add(id);
      const lyr = L.geoJSON(f, { style: () => overlayStyle(kind) });
      if (nm) lyr.bindPopup(`<span class="badge ${kind}">${labelFn(f)}</span><div class="popup-name">${nm}</div>`);
      overlayLayer.addLayer(lyr);
    }
  }

  async function refreshOverlays() {
    if (!CONFIG.overlays.enabled) return;
    if (map.getZoom() < CONFIG.overlays.minZoom) {
      overlayLayer.clearLayers();
      loadedOverlayIds.clear();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map(x => x.toFixed(4)).join(",");
    try {
      const jobs = [
        fetchOverlayGeojson(CONFIG.overlays.stateUrl, {
          where: "AV_LEGEND IN ('State Park','State Forest','State Park Scenic Reserve','Historic Preserve','Natural Area Preserve')",
          geometry: bbox, outFields: "OBJECTID,PROPERTY,AV_LEGEND"
        }),
        fetchOverlayGeojson(CONFIG.municipal.serviceUrl, {
          where: "leisure='park' AND (access IS NULL OR access NOT IN ('private','no'))",
          geometry: bbox, outFields: "OBJECTID,name"
        })
      ];
      if (activeTypes.has("cemetery")) {
        jobs.push(fetchOverlayGeojson(CONFIG.cemeteries.serviceUrl, {
          where: "landuse='cemetery' AND (access IS NULL OR access NOT IN ('private','no'))",
          geometry: bbox, outFields: "OBJECTID,name"
        }));
      }
      const [stateGj, townGj, cemGj] = await Promise.all(jobs);
      addOverlayFeatures(stateGj, "state", "PROPERTY",
        f => f.properties.AV_LEGEND || "State land");
      addOverlayFeatures(townGj, "town", "name", () => "Town / City Park");
      if (cemGj) addOverlayFeatures(cemGj, "cemetery", "name", () => "Cemetery");
    } catch (err) {
      console.warn("Overlay load failed:", err);
    }
  }

  map.on("moveend zoomend", () => {
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(refreshOverlays, 350);
  });

  // ------------------------------------------------------------------
  // UI wiring
  // ------------------------------------------------------------------
  document.querySelectorAll(".chip[data-type]").forEach(chip => {
    chip.style.setProperty("--dot", CONFIG.colors[chip.dataset.type]);
    chip.addEventListener("click", () => {
      const t = chip.dataset.type;
      if (activeTypes.has(t)) { activeTypes.delete(t); chip.classList.remove("active"); }
      else { activeTypes.add(t); chip.classList.add("active"); }
      refresh();
      if (t === "cemetery") { loadedOverlayIds.clear(); overlayLayer.clearLayers(); refreshOverlays(); }
    });
  });

  document.querySelectorAll(".chip[data-attr]").forEach(chip => {
    chip.addEventListener("click", () => {
      const a = chip.dataset.attr;
      if (activeAttrs.has(a)) { activeAttrs.delete(a); chip.classList.remove("active"); }
      else { activeAttrs.add(a); chip.classList.add("active"); }
      refresh();
    });
  });

  let searchTimer;
  document.getElementById("search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTerm = e.target.value.trim().toLowerCase(); refresh(); }, 180);
  });

  document.getElementById("listToggle").addEventListener("click", () => {
    document.getElementById("listPanel").classList.toggle("hidden");
  });

  // ------------------------------------------------------------------
  loadStatic().then(fetchMunicipal).then(loadCemeteries).then(enrich).then(refreshOverlays).catch(err => {
    console.error(err);
    showStatus("Something went wrong loading park data. Try refreshing.");
  });
})();
