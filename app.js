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
  rootStyle.setProperty("--preserve", CONFIG.colors.preserve);
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

  // ------------------------------------------------------------------
  // Icons are generated, not files: the ring takes the owner's colour and
  // the glyph says what kind of place it is, so one marker carries both.
  // ------------------------------------------------------------------
  const GLYPH = {
    // Simple, chunky shapes that stay readable at 26px.
    park:      "M32 13l9 15h-5l10 16H36v8h-8v-8H16l10-16h-5z",                       // conifer
    forest:    "M21 15l7 12h-4l7 11H14l7-11h-4zM43 20l8 13h-4l8 12H35l8-12h-4z M28 45h8v6h-8z",
    wildlife:  "M22 44c-4-4-6-9-6-14 0-8 7-14 16-14s16 6 16 14c0 5-2 10-6 14zM26 28a3 3 0 100 6 3 3 0 000-6zm12 0a3 3 0 100 6 3 3 0 000-6z",
    preserve:  "M46 16C30 16 18 24 18 38c0 5 3 9 7 11 2-11 8-19 17-24-7 6-12 14-14 25 1 0 3 0 5 0 12 0 17-12 15-26-.4-4-1-6-2-8z",
    beach:     "M14 42c4-3 7-3 11 0s7 3 11 0 7-3 11 0 7 3 11 0v6c-4 3-7 3-11 0s-7-3-11 0-7 3-11 0-7-3-11 0zM40 14a10 10 0 00-10 10h20a10 10 0 00-10-10z",
    water:     "M32 12c7 10 12 17 12 23a12 12 0 01-24 0c0-6 5-13 12-23z",
    boat:      "M13 42h38l-5 9H18zM30 14h4v24h-4zM34 18l12 6-12 6z",
    historic:  "M32 12l20 10v5H12v-5zM18 30h5v16h-5zm10 0h5v16h-5zm10 0h5v16h-5zm10 0h5v16h-5zM12 49h40v5H12z",
    cemetery:  "M32 12c-8 0-12 6-12 13v27h24V25c0-7-4-13-12-13zm-3 8h6v6h6v6h-6v14h-6V32h-6v-6h6z",
    sports:    "M32 12a20 20 0 100 40 20 20 0 000-40zm0 5c3.5 0 6.8 1.1 9.5 3-2.4 3-4 6.8-4.4 11h-10c-.4-4.2-2-8-4.4-11a15 15 0 019.3-3z",
    field:     "M14 20h36v24H14zm18 0v24M14 32h36",
    trail:     "M20 50c6-6 4-12 8-16s10-2 12-8-2-10-6-12",
    building:  "M16 26l16-12 16 12v24H16zM28 34h8v16h-8z",
    default:   "M32 14a14 14 0 00-14 14c0 10 14 22 14 22s14-12 14-22a14 14 0 00-14-14zm0 9a5 5 0 110 10 5 5 0 010-10z"
  };

  // Which glyph for which kind of place. Matched loosely on the label.
  function glyphFor(p) {
    const k = ((p.subtype || "") + " " + (p.kind || "") + " " + p.name).toLowerCase();
    if (p.type === "cemetery" || /cemeter|burying|burial/.test(k)) return "cemetery";
    if (/boat launch|water access|marina|landing/.test(k))         return "boat";
    if (/beach|shore|sound/.test(k))                               return "beach";
    if (/forest/.test(k))                                          return "forest";
    if (/wildlife|sanctuary|refuge|hatchery/.test(k))              return "wildlife";
    if (/historic|museum|monument|fort|castle/.test(k))            return "historic";
    if (/reservoir|pond|lake|river|flood|waterbody/.test(k))       return "water";
    if (/preserve|conservation|open space|natural area|land trust/.test(k)) return "preserve";
    if (/recreation|athletic|sports|ball/.test(k))                 return "sports";
    if (/green|square|common/.test(k))                             return "field";
    if (/trail|corridor/.test(k))                                  return "trail";
    if (/park/.test(k))                                            return "park";
    return "default";
  }

  const iconCache = new Map();
  function iconFor(p) {
    const glyph = glyphFor(p);
    const ring = CONFIG.visual.owner[p.type] || CONFIG.visual.owner.preserve;
    const key = glyph + ring;
    if (iconCache.has(key)) return iconCache.get(key);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="30" height="30">
         <circle cx="32" cy="32" r="29" fill="${ring}" stroke="#fff" stroke-width="4"/>
         <g fill="#fff" stroke="#fff" stroke-width="${glyph === "field" || glyph === "trail" ? 4 : 0}"
            stroke-linecap="round" fill-rule="evenodd">
           <path d="${GLYPH[glyph]}" ${glyph === "field" || glyph === "trail" ? 'fill="none"' : ""}/>
         </g>
       </svg>`;
    const icon = L.icon({
      iconUrl: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -15]
    });
    iconCache.set(key, icon);
    return icon;
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
  const activeTypes = new Set(["state", "national", "town", "preserve"]);   // cemeteries off by default
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
    if (p.type === "national") return p.subtype || "Federal Land";
    if (p.type === "cemetery") return p.subtype || "Cemetery";
    if (p.type === "preserve") return p.subtype || "Nature Preserve";
    return p.subtype || "Town / City Park";
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
    if (A.parking) t.push("🅿️ Parking");
    if (A.terrain) t.push(`⛰️ ${A.terrain}`);
    if (!t.length) return "";
    return `<div class="popup-tags">${t.map(x => `<span class="tag">${x}</span>`).join("")}</div>`;
  }

  function accessHtml(p) {
    if (!p.attrs || !p.attrs.accessNote) return "";
    const A = p.attrs;
    const ok = A.visitable;
    let cls = ok ? "ok" : "warn";
    if (A.officialAccess === "Closed") cls = "warn";
    let html = `<div class="popup-access ${cls}">${ok ? "✅" : "⚠️"} ${A.accessNote}</div>`;
    if (A.officialOwner)
      html += `<div class="popup-fee">Owner of record: ${A.officialOwner}</div>`;
    return html;
  }

  function feeHtml(p) {
    let out = "";
    if (p.aka && p.aka.length)
      out += `<div class="popup-fee">Also known locally as <strong>${p.aka[0]}</strong>${p.akaNote ? " — " + p.akaNote : ""}</div>`;
    if (p.note) out += `<div class="popup-fee">${p.note}</div>`;
    if (p.type === "state")
      out += `<div class="popup-fee">🅿️ CT-registered vehicles park free (Passport to the Parks); out-of-state $7–22. Camping/special facilities extra.</div>`;
    else if (p.fee)
      out += `<div class="popup-fee">🎟️ ${p.fee}${p.agency ? " &middot; " + p.agency : ""}</div>`;
    else if (p.agency)
      out += `<div class="popup-fee">${p.agency}</div>`;
    return out;
  }

  const ACCESS_ICON = { open: "✅", permission: "🤝", closed: "⛔", unknown: "❓" };

  function popupHtml(p) {
    if (!p.access) classify(p);
    const acres = p.acres ? ` &middot; ${Number(p.acres).toLocaleString()} acres` : "";
    return `
      <span class="badge ${p.type}">${typeLabel(p)}</span>
      <div class="popup-name">${p.name}</div>
      <div class="popup-sub">${p.town || "Connecticut"}${acres}</div>

      <div class="pblock acc-${p.access}">
        <div class="pb-head">${ACCESS_ICON[p.access]} ${p.accessLabel}</div>
        <div class="pb-body">${p.accessWhy}</div>
      </div>

      <div class="pblock plain">
        <div class="pb-head">Maintained by</div>
        <div class="pb-body">${p.steward}</div>
      </div>

      ${tagsHtml(p)}
      ${feeHtml(p)}
      <div class="popup-links">${linksFor(p)}</div>`;
  }

  function addPark(p) {
    classify(p);
    for (const al of ALIASES) {
      if (al.match && al.match.toLowerCase() === String(p.name).toLowerCase()) {
        p.aka = al.aka || [];
        if (al.why) p.akaNote = al.why;
      }
    }
    p.marker = L.marker([p.lat, p.lng], { icon: iconFor(p), title: p.name })
      .bindPopup(popupHtml(p));
    p.marker.on("popupopen", () => loadTerrain(p));
    allParks.push(p);
  }

  // ------------------------------------------------------------------
  // Terrain, fetched only when a popup is opened (USGS 3DEP, ~1 m data).
  // Sampling every place up front would take hours, so it loads lazily
  // and the popup updates in place once the numbers arrive.
  // ------------------------------------------------------------------
  function terrainLabel(relief) {
    if (relief < 12) return "Flat";
    if (relief < 40) return "Gently rolling";
    if (relief < 90) return "Hilly";
    return "Steep";
  }

  async function loadTerrain(p) {
    if (!CONFIG.terrain.enabled || !p.attrs || p.attrs.terrain || p._terrainBusy) return;
    p._terrainBusy = true;
    try {
      // Sample a 3x3 grid scaled to the size of the place.
      const rM = parkRadiusM(p) * 0.8;
      const dLat = rM / 110574, dLng = rM / (111320 * Math.cos(p.lat * Math.PI / 180));
      const pts = [];
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++)
          pts.push([+(p.lng + b * dLng).toFixed(5), +(p.lat + a * dLat).toFixed(5)]);
      const url = CONFIG.terrain.url +
        "?geometry=" + encodeURIComponent(JSON.stringify({ points: pts, spatialReference: { wkid: 4326 } })) +
        "&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&f=json";
      const j = await fetch(url).then(r => r.json());
      const vals = (j.samples || []).map(s => +s.value).filter(v => isFinite(v) && v > -100);
      if (vals.length >= 3) {
        const relief = Math.round(Math.max(...vals) - Math.min(...vals));
        p.attrs.terrain = `${terrainLabel(relief)} · ${relief} m relief`;
        p.marker.setPopupContent(popupHtml(p));
      }
    } catch (e) { /* terrain is a nicety; ignore failures */ }
    p._terrainBusy = false;
  }

  // ------------------------------------------------------------------
  // Filtering + list rendering
  // ------------------------------------------------------------------
  const activeAttrs = new Set();   // feature filters (water, trails, …)

  // Local names for places whose official name differs — loaded from
  // data/additions.json. People search for the road or farm they know.
  let ALIASES = [];

  const activeAccess = new Set(["open", "permission"]);   // can I go there?

  function visible(p) {
    if (!p.access) classify(p);
    if (p.access === "closed") return false;              // never show closed land
    if (!activeAccess.has(p.access)) return false;
    if (!activeTypes.has(p.type)) return false;
    for (const a of activeAttrs) if (!p.attrs || !p.attrs[a]) return false;
    if (!searchTerm) return true;
    // Match on everything a person might reasonably type: the name, the
    // town, what kind of place it is, who runs it, and any local alias.
    if (!p._hay) p._hay = [p.name, p.town, p.subtype, p.steward, p.agency, (p.aka || []).join(" ")]
      .filter(Boolean).join(" ").toLowerCase();
    return p._hay.includes(searchTerm);
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
      div.innerHTML = `<img src="${iconFor(p).options.iconUrl}" alt="">
        <div><div class="pi-name">${p.name}</div>
        <div class="pi-sub">${typeLabel(p)}${p.town ? " · " + p.town : ""}</div>
        <div class="pi-steward">${ACCESS_ICON[p.access] || ""} ${p.steward || ""}</div></div>`;
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
    // Hand-added places that OpenStreetMap is missing entirely.
    try {
      const add = await fetch("data/additions.json").then(r => r.json());
      ALIASES = add.aliases || [];
      for (const a of (add.places || [])) {
        addPark({
          name: a.n, type: a.type || "preserve", subtype: a.t, lat: a.lat, lng: a.lng,
          town: a.town || findTown(a.lat, a.lng), acres: a.a || null, url: a.url || null,
          fee: a.fee || null, agency: a.agency || null, note: a.note || null,
          attrs: { trails: !!a.trails, parking: !!a.parking, manual: true }
        });
      }
    } catch (e) { /* additions are optional */ }

    for (const n of natData.parks) {
      addPark({
        name: n.n, type: "national", subtype: n.t, lat: n.lat, lng: n.lng,
        town: n.town, url: n.url, acres: n.a || null,
        fee: n.fee || null, agency: n.agency || null, note: n.note || null
      });
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
    "(beach|lake|shore|point|improvement) association|" +
    // Scout reservations and camps are members-only, not public land.
    "\\bscout\\b|scout reservation", "i");

  // Tribal burial grounds are excluded outright. Connecticut's five
  // state-recognised reservations are sovereign land — under CGS
  // ch. 824 nobody may go on a reservation without the tribe's written
  // permission — and burial grounds are not visitor destinations.
  // (Careful: "Indian Hill Cemetery" and "Indian River Cemetery" are
  // ordinary municipal cemeteries named for local landmarks, so we
  // match on burial-specific wording rather than the word alone.)
  const TRIBAL_EXCLUDE = new RegExp(
    "tribal burial|indian burial|burial site|" +
    "\\b(schaghticoke|paugussett|pequot|mohegan|montaukett|niantic|nipmuc|" +
    "mashantucket|golden hill)\\b.*(burial|reservation)|" +
    "\\breservation\\b.*(indian|tribal)", "i");
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
  // Boat launches and water access — DEEP publishes these separately
  // from its property layer.
  // ------------------------------------------------------------------
  function fetchBoatLaunches() {
    return cachedDataset("ctparks_boat_v2", CONFIG.municipal.cacheDays, async () => {
      const urls = [CONFIG.boatLaunches.url, CONFIG.boatLaunches.cartopUrl].filter(Boolean);
      const out = [];
      for (const url of urls) {
        try {
          const body = new URLSearchParams({
            where: "1=1", outFields: "ACCSS_NAME,PROPERTY,ACCSS_TOWN,WATERBODY,TRAILER,CARRY_IN,HANDICAP,LINK",
            outSR: "4326", returnGeometry: "true", resultRecordCount: "300", f: "json"
          });
          const j = await fetch(url, { method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
          for (const f of (j.features || [])) {
            if (!f.geometry) continue;
            const a = f.attributes;
            out.push({ n: a.ACCSS_NAME || a.PROPERTY, town: a.ACCSS_TOWN || "",
                       w: a.WATERBODY || "", trailer: a.TRAILER, carry: a.CARRY_IN,
                       hc: a.HANDICAP, url: a.LINK || null,
                       lat: +f.geometry.y.toFixed(5), lng: +f.geometry.x.toFixed(5) });
          }
        } catch (e) { /* one dataset failing shouldn't lose the other */ }
      }
      // Same launch can appear in both datasets.
      const seen = new Set();
      return out.filter(b => {
        const k = String(b.n).toLowerCase() + "|" + Math.round(b.lat * 2000) + "|" + Math.round(b.lng * 2000);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    });
  }

  async function loadBoatLaunches() {
    if (!CONFIG.boatLaunches.enabled) return;
    try {
      for (const b of await fetchBoatLaunches()) {
        if (!b.n) continue;
        const bits = [];
        if (b.w) bits.push("On " + b.w + ".");
        const kinds = [];
        if (/y|1|true/i.test(String(b.trailer))) kinds.push("trailer launch");
        if (/y|1|true/i.test(String(b.carry))) kinds.push("car-top / carry-in");
        if (kinds.length) bits.push("Suitable for " + kinds.join(" and ") + ".");
        if (/y|1|true/i.test(String(b.hc))) bits.push("Accessible facilities.");
        addPark({
          name: b.n, type: "state", subtype: "Boat Launch / Water Access",
          lat: b.lat, lng: b.lng, town: b.town || findTown(b.lat, b.lng),
          url: b.url, agency: "CT DEEP", note: bits.join(" ") || null,
          attrs: { water: true, waterName: b.w || "Water access", parking: true }
        });
      }
      refresh();
    } catch (e) { console.warn("Boat launches failed:", e); }
  }

  // ------------------------------------------------------------------
  // Museum & historic-site grounds. OSM rarely records admission, so we
  // only take sites that are explicitly free or tagged historic, and we
  // word the popup so nobody assumes the building is free too.
  // ------------------------------------------------------------------
  function fetchMuseums() {
    return cachedDataset("ctparks_museum_v1", CONFIG.municipal.cacheDays, async () => {
      const out = [];
      // Tourism is a POINT layer — same centroid limitation as POIs.
      await pagedQuery(CONFIG.museums.url, {
        where: "tourism='museum' AND name IS NOT NULL AND historic IS NOT NULL",
        outFields: "name,historic,operator,website",
        returnGeometry: "true"
      }, f => {
        const a = f.attributes, c = pointOf(f);
        if (!a.name || !c) return;
        out.push({ n: a.name, lat: +c.y.toFixed(5), lng: +c.x.toFixed(5),
                   h: a.historic || "", op: a.operator || "",
                   w: (a.website && /^https?:/i.test(a.website)) ? a.website : null });
      });
      return out;
    });
  }

  async function loadMuseums() {
    if (!CONFIG.museums.enabled) return;
    try {
      const items = await fetchMuseums();
      const existing = new Set(allParks.map(p =>
        p.name.toLowerCase() + "|" + Math.round(p.lat * 300) + "|" + Math.round(p.lng * 300)));
      for (const m of items) {
        const key = m.n.toLowerCase() + "|" + Math.round(m.lat * 300) + "|" + Math.round(m.lng * 300);
        if (existing.has(key)) continue;
        existing.add(key);
        const town = findTown(m.lat, m.lng);
        if (!town) continue;
        addPark({
          name: m.n, type: "town", subtype: "Historic Site Grounds",
          lat: m.lat, lng: m.lng, town, url: m.w, agency: m.op || null,
          note: "Grounds are usually open and free to walk; admission to the building may be charged. Check before visiting.",
          attrs: { historic: true }
        });
      }
      refresh();
    } catch (e) { console.warn("Museums failed:", e); }
  }

  // ------------------------------------------------------------------
  // State land beyond parks and forests: Wildlife Management Areas,
  // sanctuaries, flood control land and hatcheries. All public.
  // ------------------------------------------------------------------
  function fetchStateExtra() {
    return cachedDataset("ctparks_stateextra_v1", CONFIG.municipal.cacheDays, async () => {
      const legends = CONFIG.stateExtra.legends.map(l => "'" + l + "'").join(",");
      const best = {};
      await pagedQuery(CONFIG.stateExtra.url, {
        where: "AV_LEGEND IN (" + legends + ")",
        outFields: "PROPERTY,AV_LEGEND,ACRE_GIS",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        const a = f.attributes, c = f.centroid;
        if (!a.PROPERTY || !c) return;
        const acres = Math.round(a.ACRE_GIS || 0);
        // A property can span many parcels; keep the biggest as its pin.
        if (!best[a.PROPERTY] || acres > best[a.PROPERTY].a)
          best[a.PROPERTY] = { n: a.PROPERTY, t: a.AV_LEGEND, a: acres,
                               lat: +c.y.toFixed(5), lng: +c.x.toFixed(5) };
      });
      return Object.values(best).filter(x => x.a >= CONFIG.stateExtra.minAcres);
    });
  }

  const LEGEND_LABEL = {
    "Wildlife Area": "Wildlife Management Area",
    "Wildlife Sanctuary": "Wildlife Sanctuary",
    "Flood Control": "Flood Control Area",
    "Fish Hatchery": "Fish Hatchery"
  };

  async function loadStateExtra() {
    if (!CONFIG.stateExtra.enabled) return;
    try {
      for (const s of await fetchStateExtra()) {
        addPark({
          name: s.n, type: "state", subtype: LEGEND_LABEL[s.t] || s.t,
          lat: s.lat, lng: s.lng, acres: s.a, town: findTown(s.lat, s.lng),
          agency: "CT DEEP"
        });
      }
      refresh();
    } catch (e) { console.warn("State extra failed:", e); }
  }

  // Town greens and recreation grounds live under landuse, not leisure.
  function fetchExtraLanduse() {
    return cachedDataset("ctparks_landuse_v1", CONFIG.municipal.cacheDays, async () => {
      const kinds = CONFIG.extraLanduse.kinds.map(k => "'" + k + "'").join(",");
      const out = [];
      await pagedQuery(CONFIG.extraLanduse.url, {
        where: "landuse IN (" + kinds + ") AND name IS NOT NULL AND " +
               "(access IS NULL OR access NOT IN ('private','no'))",
        outFields: "name,landuse,operator,Shape__Area",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        const a = f.attributes, c = f.centroid;
        if (!a.name || !c) return;
        const lat = +c.y.toFixed(5);
        const k = Math.cos(lat * Math.PI / 180);
        const acres = Math.round((a.Shape__Area || 0) * k * k * 0.000247105);
        out.push({ n: a.name, lat, lng: +c.x.toFixed(5), k: a.landuse,
                   op: a.operator || "", a: acres });
      });
      return out;
    });
  }

  const LANDUSE_LABEL = { recreation_ground: "Recreation Area",
                          village_green: "Town Green", forest: "Forest" };

  async function loadExtraLanduse() {
    if (!CONFIG.extraLanduse.enabled) return;
    try {
      const items = await fetchExtraLanduse();
      const existing = new Set(allParks.map(p =>
        p.name.toLowerCase() + "|" + Math.round(p.lat * 300) + "|" + Math.round(p.lng * 300)));
      for (const m of items) {
        const key = m.n.toLowerCase() + "|" + Math.round(m.lat * 300) + "|" + Math.round(m.lng * 300);
        if (existing.has(key)) continue;
        existing.add(key);
        const town = findTown(m.lat, m.lng);
        if (!town) continue;
        if (EXCLUDE.test(m.n) && !ALLOW.has(m.n.toLowerCase())) continue;
        const isState = /State Forest|State of Connecticut/i.test(m.n + " " + m.op);
        addPark({
          name: m.n, type: isState ? "state" : "town",
          subtype: LANDUSE_LABEL[m.k] || "Open Space",
          lat: m.lat, lng: m.lng, town, acres: m.a || null,
          agency: m.op || null
        });
      }
      refresh();
    } catch (e) { console.warn("Extra landuse failed:", e); }
  }

  // ------------------------------------------------------------------
  // Land trust preserves & open space (leisure=nature_reserve)
  //   land trust / conservancy / nonprofit  -> "preserve" layer
  //   town or city run                      -> Town layer, "Open Space"
  //   state run                             -> skipped (already mapped)
  //   water-supply watershed                -> skipped (permit-only)
  // ------------------------------------------------------------------
  const PRES_CACHE = "ctparks_pres_v5";
  const OP_STATE = /Department of Energy and Environmental|State of Connecticut|\bDEEP\b|Connecticut DEP/i;
  // Federal land held as parcels — in Connecticut this is overwhelmingly
  // the Appalachian Trail protective corridor, which the NPS owns
  // outright. It's real walkable public land, not just a line.
  const OP_FED   = /National Park Service|United States of America|U\.?S\.? Fish|Fish and Wildlife|Army Corps/i;
  const OP_WATER = /Water Supply|Water Authority|Water Company|Bureau of Water|Aquarion|Regional Water/i;
  const OP_TOWN  = /^(Town|City|Borough|Village) of\b|^City\b|Parks (and|&) Recreation/i;
  const OP_UNI   = /University|College|Yale|UConn|Academy/i;
  const OP_TRUST = /Land Trust|Conservancy|Conservation Trust|Land Conservation|Audubon|Nature Center|Nature Conservancy|Preservation|\bTrust\b/i;

  function preserveClass(op) {
    if (!op) return { kind: "preserve", label: "Nature Preserve" };
    if (OP_FED.test(op))   return { kind: "national", label: "National Park Service Land" };
    if (OP_STATE.test(op)) return null;                 // duplicate of the DEEP layer
    if (OP_WATER.test(op)) return null;                 // permit-only watershed land
    if (OP_TOWN.test(op))  return { kind: "town", label: "Town Open Space" };
    if (OP_UNI.test(op))   return { kind: "preserve", label: "University Land" };
    if (OP_TRUST.test(op)) return { kind: "preserve", label: "Land Trust Preserve" };
    return { kind: "preserve", label: "Nature Preserve" };
  }

  // Turn one raw nature_reserve row into a preserve record, or null if it
  // shouldn't become a place. Shared by the live fetch and the baked file
  // so the rules only exist in one spot.
  function preserveRow(name, operator, lat, lng, website) {
    const cls = preserveClass(operator);
    if (!cls) return null;
    let nm = name;
    if (!nm) {
      if (!operator) return null;
      nm = cls.kind === "national"
         ? "Appalachian Trail Corridor"
         : operator.replace(/,?\s*Inc\.?$/i, "") + " land";
    }
    const rec = { n: nm, lat, lng, k: cls.kind, l: cls.label };
    if (!name) rec.un = 1;
    if (operator) rec.op = operator;
    if (website) rec.w = website;
    return rec;
  }

  function fetchPreserves() {
    // Baked file stores the raw parcels; classify them here.
    const rawBaked = BAKED && BAKED.cache && BAKED.cache["ctparks_preserve_raw_v1"];
    if (rawBaked && rawBaked.length) {
      const out = [];
      for (const r of rawBaked) {
        const rec = preserveRow(r.n, r.op, r.lat, r.lng, r.w);
        if (rec) out.push(rec);
      }
      return Promise.resolve(out);
    }
    return cachedDataset(PRES_CACHE, CONFIG.municipal.cacheDays, async () => {
      const out = [];
      // Unnamed parcels are included too: a lot of land trust and open
      // space land has no name in OSM, and dropping it hid real places.
      // Unnamed ones are labelled by their operator instead.
      await pagedQuery(CONFIG.preserves.serviceUrl, {
        where: "leisure='nature_reserve' AND (access IS NULL OR access NOT IN ('private','no'))",
        outFields: "name,operator,website,Shape__Area",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        const a = f.attributes, c = f.centroid;
        if (!c) return;
        const cls = preserveClass(a.operator);
        if (!cls) return;
        const lat = +c.y.toFixed(5);
        let nm = a.name;
        if (!nm) {
          // Skip nameless scraps with no steward — they're usually
          // fragments and just add noise. (This OSM view doesn't return
          // Shape__Area, so a named operator is our quality signal.)
          if (!a.operator) return;
          nm = cls.kind === "national"
             ? "Appalachian Trail Corridor"
             : a.operator.replace(/,?\s*Inc\.?$/i, "") + " land";
        }
        const rec = { n: nm, lat, lng: +c.x.toFixed(5), k: cls.kind, l: cls.label };
        if (!a.name) rec.un = 1;
        if (a.operator) rec.op = a.operator;
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

  async function loadPreserves() {
    if (!CONFIG.preserves.enabled) return;
    try {
      const items = await fetchPreserves();
      // Don't re-add something already on the map under the same name nearby.
      const existing = new Set(allParks.map(p =>
        p.name.toLowerCase() + "|" + Math.round(p.lat * 300) + "|" + Math.round(p.lng * 300)));
      const seen = new Set();
      for (const m of items) {
        const key = m.n.toLowerCase() + "|" + Math.round(m.lat * 300) + "|" + Math.round(m.lng * 300);
        if (existing.has(key) || seen.has(key)) continue;
        seen.add(key);
        const town = findTown(m.lat, m.lng);
        if (!town) continue;
        if (EXCLUDE.test(m.n) && !ALLOW.has(m.n.toLowerCase())) continue;
        addPark({
          name: m.n, type: m.k, subtype: m.l, lat: m.lat, lng: m.lng, town,
          acres: m.a || null, url: m.w || null,
          agency: m.op || null, fee: m.k === "preserve" ? "Free" : "Free",
          note: m.k === "national"
            ? "Federally owned parcel. In Connecticut these are almost entirely the Appalachian Trail protective corridor — the land itself is public, though it may be a narrow strip with private property either side."
            : null
        });
      }
      refresh();
    } catch (err) {
      console.warn("Preserve load failed:", err);
    }
  }

  // ------------------------------------------------------------------
  // Cemeteries & historic burying grounds (public land that isn't a park)
  // ------------------------------------------------------------------
  const CEM_CACHE = "ctparks_cem_v2";
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
        if (TRIBAL_EXCLUDE.test(a.name)) return;
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

  // ------------------------------------------------------------------
  // Baked data. If data/baked.json exists it supplies everything, and no
  // service is called at all. Generate it with build.html. Without it the
  // map still works — it just fetches live on first visit.
  // ------------------------------------------------------------------
  let BAKED = null;
  async function loadBaked() {
    try {
      const r = await fetch("data/baked.json", { cache: "force-cache" });
      if (!r.ok) return;
      BAKED = await r.json();
      const n = Object.keys(BAKED.cache || {}).length;
      console.info(`Using baked data from ${BAKED.built} (${n} datasets).`);
    } catch (e) { /* no baked file — fetch live */ }
  }

  function cachedDataset(key, days, fetcher) {
    if (BAKED && BAKED.cache && BAKED.cache[key] && BAKED.cache[key].length)
      return Promise.resolve(BAKED.cache[key]);
    try {
      const c = JSON.parse(localStorage.getItem(key));
      // Only trust a cache entry that actually has rows: an empty result is
      // almost always a transient network failure, and caching it would
      // silently break the feature for a week.
      if (c && c.data && c.data.length && Date.now() - c.time < days * 864e5) return Promise.resolve(c.data);
    } catch (e) { /* ignore */ }
    return fetcher().then(data => {
      if (data && data.length) {
        try { localStorage.setItem(key, JSON.stringify({ time: Date.now(), data })); }
        catch (e) { /* over quota — fine, we just refetch next time */ }
      }
      return data;
    });
  }

  // Drop cache entries from older versions of the site so they don't
  // sit in localStorage forever.
  (function pruneOldCaches() {
    const keep = new Set(["ctparks_municipal_v3", "ctparks_cem_v2", "ctparks_pres_v5",
                          "ctparks_fac_v1", "ctparks_trl_v1", "ctparks_wtr_v1"]);
    try {
      for (const k of Object.keys(localStorage))
        if (k.startsWith("ctparks_") && !keep.has(k)) localStorage.removeItem(k);
    } catch (e) { /* ignore */ }
  })();

  async function pagedQuery(url, extraParams, perFeature) {
    let offset = 0;
    for (let i = 0; i < 45; i++) {
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

  // --- Trail coverage grid -------------------------------------------
  // We don't care about individual trails, only "is there a trail here".
  // So every trail vertex collapses into a ~165 m grid cell and we cache
  // the set of occupied cells: small to store, instant to test against.
  const TRAIL_CELL = 0.0015;
  function cellKey(lat, lng) {
    return Math.floor(lat / TRAIL_CELL) * 1000000 + (Math.floor(lng / TRAIL_CELL) + 500000);
  }

  const TRAIL_WHERE = "highway IN ('path','track','bridleway')";

  async function countQuery(url, where) {
    const body = new URLSearchParams({
      where, geometry: CT_BBOX, geometryType: "esriGeometryEnvelope",
      inSR: "4326", returnCountOnly: "true", f: "json"
    });
    const j = await fetch(url, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
    return j.count || 0;
  }

  // Connecticut has ~30,000 trail segments. Requesting full geometry for
  // all of them locks up the browser, so we ask the server to simplify
  // heavily (maxAllowableOffset) and fetch pages several at a time.
  function fetchTrailCells() {
    return cachedDataset("ctparks_trailgrid_v2", CONFIG.municipal.cacheDays, async () => {
      const cells = new Set();
      const PAGE = 2000, CONCURRENCY = 4;
      const total = await countQuery(CONFIG.enrichment.trailsUrl, TRAIL_WHERE);
      if (!total) return [];
      const offsets = [];
      for (let o = 0; o < total; o += PAGE) offsets.push(o);

      async function grab(offset) {
        const body = new URLSearchParams({
          where: TRAIL_WHERE, geometry: CT_BBOX, geometryType: "esriGeometryEnvelope",
          inSR: "4326", outSR: "4326", outFields: "",
          returnGeometry: "true", maxAllowableOffset: "0.004", geometryPrecision: "4",
          resultOffset: String(offset), resultRecordCount: String(PAGE), f: "json"
        });
        try {
          const j = await fetch(CONFIG.enrichment.trailsUrl, { method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
          for (const f of j.features || [])
            for (const path of (f.geometry && f.geometry.paths) || [])
              for (const pt of path) cells.add(cellKey(pt[1], pt[0]));
        } catch (e) { /* skip this page */ }
      }

      for (let i = 0; i < offsets.length; i += CONCURRENCY)
        await Promise.all(offsets.slice(i, i + CONCURRENCY).map(grab));
      return [...cells];
    });
  }

  // A feature's location, whichever way the service gave it to us.
  // Polygon layers answer returnCentroid; point layers can't, and hand
  // back a plain geometry instead. Getting this wrong fails silently —
  // the query succeeds and every feature is skipped.
  function pointOf(f) {
    if (f.centroid) return f.centroid;
    const g = f.geometry;
    if (g && typeof g.x === "number" && typeof g.y === "number") return g;
    return null;
  }

  function trailNear(lat, lng, radiusM, cellSet) {
    const span = Math.min(6, Math.ceil(radiusM / 111000 / TRAIL_CELL));
    const i0 = Math.floor(lat / TRAIL_CELL), j0 = Math.floor(lng / TRAIL_CELL);
    for (let i = i0 - span; i <= i0 + span; i++)
      for (let j = j0 - span; j <= j0 + span; j++)
        if (cellSet.has(i * 1000000 + (j + 500000))) return true;
    return false;
  }

  function fetchParking() {
    return cachedDataset("ctparks_park_v1", CONFIG.municipal.cacheDays, async () => {
      const out = [];
      // POIs is a POINT layer, so it rejects returnCentroid outright
      // (supportsReturningGeometryCentroid: false) — ask for the geometry.
      await pagedQuery(CONFIG.enrichment.poisUrl, {
        where: "amenity='parking' AND (access IS NULL OR access NOT IN ('private','no','customers','permit'))",
        outFields: "OBJECTID", returnGeometry: "true"
      }, f => {
        const g = pointOf(f);
        if (g) out.push([+g.y.toFixed(5), +g.x.toFixed(5)]);
      });
      return out;
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
      const [fac, park, wtr, coast] = await Promise.all([
        fetchFacilities(), fetchParking(), fetchWater(),
        fetch("data/coast.json").then(r => r.json()).catch(() => ({ pts: [] }))
      ]);

      const facGrid = makeGrid(0.01), parkGrid = makeGrid(0.01),
            wtrGrid = makeGrid(0.02), cstGrid = makeGrid(0.01);
      for (const [la, ln, leis, sp] of fac) facGrid.add(la, ln, [leis, sp]);
      for (const [la, ln] of park) parkGrid.add(la, ln, 1);
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

        // Public parking means you can at least reach and enter.
        // (Trails are added afterwards — see applyTrailAccess.)
        if (parkGrid.near(p.lat, p.lng, Math.max(r, CONFIG.access.parkingRadiusM)).length)
          A.parking = true;
        scoreAccess(p);

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
      applyTrailAccess()      // slower; fills in behind the scenes
        .then(loadPadus);     // official ratings last — they override ours
    } catch (err) {
      console.warn("Enrichment failed:", err);
      hideStatus();
    }
  }

  // ------------------------------------------------------------------
  // PAD-US — official Public Access rating from USGS.
  // Dormant while USGS's service is down; probes and self-activates.
  // ------------------------------------------------------------------
  async function probePadus() {
    for (const base of CONFIG.padus.endpoints) {
      try {
        const meta = await fetch(base + "?f=json").then(r => r.json());
        if (meta.error) continue;
        const body = new URLSearchParams({
          where: "1=1", geometry: CT_BBOX, geometryType: "esriGeometryEnvelope",
          inSR: "4326", returnCountOnly: "true", f: "json"
        });
        const c = await fetch(base + "/query", { method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
        if (c.count > 0) return base;      // has Connecticut coverage
      } catch (e) { /* try the next one */ }
    }
    return null;
  }

  const ACCESS_WORD = { OA: "Open", RA: "Restricted", XA: "Closed", UK: "Unknown",
                        "Open Access": "Open", "Restricted Access": "Restricted",
                        "Closed": "Closed", "Closed Access": "Closed", "Unknown": "Unknown" };

  // PAD-US owner codes, decoded for humans.
  const OWNER_WORD = {
    NPS: "National Park Service", FWS: "US Fish & Wildlife Service", USFS: "US Forest Service",
    USACE: "Army Corps of Engineers", DOD: "Department of Defense", BLM: "Bureau of Land Management",
    TRIB: "Tribal land", SPR: "State Parks & Recreation", SDC: "State Dept. of Conservation",
    SFW: "State Fish & Wildlife", SDNR: "State Dept. of Natural Resources", OTHS: "State land",
    CITY: "City", CNTY: "County", REG: "Regional agency", RWD: "Regional water district",
    UNKL: "Local government", NGO: "Non-profit / land trust", PVT: "Private",
    JNT: "Jointly held", DESG: "Designation", OTHR: "Other", UNK: "Unknown", OTHF: "Federal land"
  };

  // Designation types worth spelling out — they explain the access rating.
  const DESIG_WORD = {
    PAGR: "Private agricultural", PRAN: "Private ranch", PFOR: "Private forest stewardship",
    PCON: "Private conservation", PPRK: "Private park", PREC: "Private recreation",
    CONE: "Conservation easement", AGRE: "Agricultural easement", RANE: "Ranch easement",
    FORE: "Forest stewardship easement", RECE: "Recreation easement", OTHE: "Easement",
    UNKE: "Easement (type unrecorded)", SP: "State park", SCA: "State conservation area",
    SREC: "State recreation area", LP: "Local park", LCA: "Local conservation area",
    LREC: "Local recreation area", NWR: "National wildlife refuge", NP: "National park",
    NT: "National scenic or historic trail", WPA: "Watershed protection area"
  };

  // --- PAD-US access layer: the definitive public/private picture ------
  map.createPane("padusPane");
  map.getPane("padusPane").style.zIndex = 378;
  const padusLayer = L.layerGroup();
  const padusRenderer = L.canvas({ pane: "padusPane" });
  const loadedPadusIds = new Set();
  let padusOn = false, padusBase = null;

  async function refreshPadusLayer() {
    const P = CONFIG.padus;
    if (!padusOn || !padusBase || map.getZoom() < P.minZoom) return;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(x => x.toFixed(4)).join(",");
    try {
      const body = new URLSearchParams({
        where: "1=1", geometry: bbox, geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326",
        outFields: "OBJECTID,Unit_Nm,Pub_Access,Own_Name,Mang_Name,GIS_Acres",
        returnGeometry: "true", maxAllowableOffset: "0.00008",
        resultRecordCount: "900", f: "geojson"
      });
      const gj = await fetch(padusBase + "/query", { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
      for (const f of (gj.features || [])) {
        const pr = f.properties || {};
        const id = pr.OBJECTID || f.id;
        if (id == null || loadedPadusIds.has(id)) continue;
        loadedPadusIds.add(id);
        const code = pr.Pub_Access || "UK";
        const col = P.colors[code] || P.colors.UK;
        const word = ACCESS_WORD[code] || code;
        const owner = OWNER_WORD[pr.Own_Name] || pr.Own_Name || "Unknown";
        const desg = DESIG_WORD[pr.Des_Tp] || "";
        // "Restricted" on land-trust or private conservation land almost
        // always means "walkable by permission, not by legal right" —
        // not "keep out". Say so, or the map scares people off land
        // they're welcome on.
        const byPermission = /NGO|PVT|UNK/.test(pr.Own_Name || "") &&
                             /^(RA|UK)$/.test(code);
        const explain = code === "OA"
          ? "No special requirement to enter."
          : code === "XA"
          ? "No public access permitted."
          : byPermission
          ? "<strong>Restricted doesn't necessarily mean closed.</strong> On land-trust and private conservation land it usually means there's no guaranteed <em>right</em> of access — you're there by the owner's permission, which they can vary or withdraw. Many such places are walked freely every day. Check the owner's website or posted signs."
          : "Requires a permit, registration, or has limited hours.";
        L.geoJSON(f, {
          renderer: padusRenderer, pane: "padusPane",
          // Borders were getting lost on canvas — give them real weight.
          style: { color: col, weight: 2.2, opacity: 1, fillColor: col, fillOpacity: 0.22 }
        }).bindPopup(
          `<span class="badge" style="background:${col}">${word} access</span>
           <div class="popup-name">${pr.Unit_Nm && pr.Unit_Nm !== "Unknown" ? pr.Unit_Nm : "Protected area"}</div>
           <div class="popup-sub">Owner: ${owner}${desg ? " &middot; " + desg : ""}${pr.GIS_Acres ? " &middot; " + Number(pr.GIS_Acres).toLocaleString() + " acres" : ""}</div>
           <div class="popup-fee">${explain}</div>
           <div class="popup-fee" style="opacity:.7">Classification from USGS PAD-US.</div>`
        ).addTo(padusLayer);
      }
    } catch (e) { console.warn("PAD-US layer failed:", e); }
  }

  async function loadPadus() {
    if (!CONFIG.padus.enabled) return;
    let base = null;
    try { base = await probePadus(); } catch (e) { return; }
    if (!base) { console.info("PAD-US unavailable — skipping official access ratings."); return; }
    padusBase = base;
    document.getElementById("padusToggle").removeAttribute("disabled");
    // Now that PAD-US is confirmed reachable, redraw so land-trust
    // boundaries appear for the view we're already looking at.
    refreshOverlays();
    try {
      showStatus("Applying official PAD-US access ratings…");
      const areas = [];
      await pagedQuery(base + "/query", {
        where: "1=1", outFields: "Unit_Nm,Loc_Nm,Pub_Access,Own_Name,Mang_Name,Des_Tp,GIS_Acres",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        const a = f.attributes, c = f.centroid;
        if (!c) return;
        areas.push({ n: a.Unit_Nm || a.Loc_Nm || "", acc: a.Pub_Access || "",
                     own: a.Own_Name || "", mang: a.Mang_Name || "",
                     lat: c.y, lng: c.x });
      });
      if (!areas.length) { hideStatus(); return; }

      const grid = makeGrid(0.01);
      for (const a of areas) grid.add(a.lat, a.lng, a);
      let tagged = 0;
      for (const p of allParks) {
        const near = grid.near(p.lat, p.lng, CONFIG.padus.matchRadiusM);
        if (!near.length) continue;
        near.sort((x, y) => x[0] - y[0]);
        const best = near[0][1];
        const word = ACCESS_WORD[best.acc] || best.acc;
        if (!word) continue;
        const A = p.attrs || (p.attrs = {});
        A.officialAccess = word;
        if (best.own) A.officialOwner = OWNER_WORD[best.own] || best.own;
        if (word === "Open") { A.visitable = true; A.accessNote = "Open to the public (USGS PAD-US)"; }
        else if (word === "Closed") { A.visitable = false; A.accessNote = "Closed to public access (USGS PAD-US)"; }
        else if (word === "Restricted") { A.accessNote = "Restricted access (USGS PAD-US) — check before visiting"; }
        p.marker.setPopupContent(popupHtml(p));
        tagged++;
      }
      hideStatus();
      refresh();
      if (tagged) { showStatus(`PAD-US: official access applied to ${tagged.toLocaleString()} places`); setTimeout(hideStatus, 3000); }
      await loadPadusPlaces();     // then add what PAD-US knows and we don't
    } catch (e) { console.warn("PAD-US enrichment failed:", e); hideStatus(); }
  }

  // ------------------------------------------------------------------
  // PAD-US as a source of PLACES. It carries names for land that
  // OpenStreetMap has never heard of — "Upland Pastures" being the
  // case that started this. Adds only genuinely new, named, open land.
  // ------------------------------------------------------------------
  const PADUS_TYPE = {
    NPS: "national", FWS: "national", USFS: "national", USACE: "national",
    DOD: "national", BLM: "national", OTHF: "national", BOEM: "national",
    USBR: "national", NOAA: "national", NRCS: "national", ARS: "national",
    SPR: "state", SDC: "state", SFW: "state", SDNR: "state", SLB: "state",
    SDOL: "state", OTHS: "state",
    CITY: "town", CNTY: "town", UNKL: "town", REG: "town", RWD: "town",
    NGO: "preserve", PVT: "preserve", JNT: "preserve", OTHR: "preserve", UNK: "preserve"
  };
  // Names that aren't really names — they'd fill the list with noise.
  const GENERIC_NAME = /^(town|city|borough|village) of\b|^private\b|^unknown$|^state of\b|^designation$/i;

  function fetchPadusPlaces() {
    return cachedDataset("ctparks_padusplaces_v1", CONFIG.municipal.cacheDays, async () => {
      if (!padusBase) return [];
      const out = [];
      await pagedQuery(padusBase + "/query", {
        where: "Unit_Nm<>'Unknown' AND Pub_Access<>'XA'",
        outFields: "Unit_Nm,Own_Name,Mang_Name,Pub_Access,Des_Tp,GIS_Acres",
        returnGeometry: "false", returnCentroid: "true"
      }, f => {
        const a = f.attributes, c = f.centroid;
        if (!a.Unit_Nm || !c) return;
        if (a.Own_Name === "TRIB" || a.Mang_Name === "TRIB") return;   // sovereign land
        if (GENERIC_NAME.test(a.Unit_Nm.trim())) return;
        out.push({ n: a.Unit_Nm.trim(), own: a.Own_Name || "UNK",
                   acc: a.Pub_Access || "UK", des: a.Des_Tp || "",
                   a: Math.round(a.GIS_Acres || 0),
                   lat: +c.y.toFixed(5), lng: +c.x.toFixed(5) });
      });
      return out;
    });
  }

  async function loadPadusPlaces() {
    if (!CONFIG.padus.enabled || !padusBase) return;
    try {
      showStatus("Adding places from PAD-US…");
      const items = await fetchPadusPlaces();
      // Existing places, keyed by simplified name, for match-checking.
      const byName = new Map();
      const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      for (const p of allParks) {
        const k = norm(p.name);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(p);
      }
      const seen = new Set();
      let added = 0;
      for (const m of items) {
        const key = norm(m.n) + "|" + Math.round(m.lat * 200) + "|" + Math.round(m.lng * 200);
        if (seen.has(key)) continue;         // PAD-US overlaps itself (fee + easement)
        seen.add(key);
        // Already on the map under this name and close by? Skip.
        const same = byName.get(norm(m.n)) || [];
        if (same.some(p => distM(p.lat, p.lng, m.lat, m.lng) < 800)) continue;
        const town = findTown(m.lat, m.lng);
        if (!town) continue;                 // outside Connecticut
        if (EXCLUDE.test(m.n) && !ALLOW.has(m.n.toLowerCase())) continue;
        if (TRIBAL_EXCLUDE.test(m.n)) continue;
        const type = PADUS_TYPE[m.own] || "preserve";
        const word = ACCESS_WORD[m.acc] || "Unknown";
        const byPermission = /NGO|PVT|UNK/.test(m.own) && /^(RA|UK)$/.test(m.acc);
        addPark({
          name: m.n, type, subtype: DESIG_WORD[m.des] || "Protected land",
          lat: m.lat, lng: m.lng, town, acres: m.a || null,
          agency: OWNER_WORD[m.own] || null,
          fee: m.acc === "OA" ? "Open access" : null,
          note: byPermission
            ? "Listed by USGS as restricted, which for land-trust and private conservation land usually means open by the owner's permission rather than by legal right. Check the owner's website or posted signs."
            : null,
          attrs: { officialAccess: word, officialOwner: OWNER_WORD[m.own] || m.own,
                   fromPadus: true }
        });
        added++;
      }
      hideStatus();
      refresh();
      if (added) { showStatus(`Added ${added.toLocaleString()} places from PAD-US`); setTimeout(hideStatus, 4500); }
    } catch (e) { console.warn("PAD-US places failed:", e); hideStatus(); }
  }

  // ------------------------------------------------------------------
  // The three questions this map exists to answer:
  //   1. Can I go there?      -> p.access   open | permission | unknown
  //   2. Who maintains it?    -> p.steward
  //   3. What kind of place?  -> p.kind  (+ p.attrs for what's there)
  // Everything else is presentation.
  // ------------------------------------------------------------------
  const STEWARD_BY_TYPE = {
    state: "State of Connecticut (DEEP)",
    national: "Federal government",
    town: "Town or city",
    preserve: "Land trust or non-profit",
    cemetery: "Cemetery association or town"
  };

  function classify(p) {
    const A = p.attrs || (p.attrs = {});

    // --- 1. Can I go there? ---
    // Official rating wins. Otherwise: state, federal and town land is
    // public by default; land trust land is open by permission, which in
    // Connecticut is the normal arrangement rather than an exception.
    if (A.officialAccess === "Open")            p.access = "open";
    else if (A.officialAccess === "Closed")     p.access = "closed";
    else if (A.officialAccess === "Restricted") p.access = "permission";
    else if (p.type === "state" || p.type === "national" || p.type === "town")
                                                p.access = "open";
    else if (p.type === "preserve" || p.type === "cemetery")
                                                p.access = "permission";
    else                                        p.access = "unknown";

    // Somewhere with no trail, no parking and no facilities is a place we
    // can't vouch for, whoever owns it.
    A.visitable = !!(A.trails || A.parking || A.sports || A.playground || A.beach || A.pool);
    if (!A.visitable && p.access !== "closed" && !A.officialAccess) p.access = "unknown";

    p.accessLabel = { open: "Open to all", permission: "Open by permission",
                      closed: "Closed to the public", unknown: "Access unverified" }[p.access];
    p.accessWhy =
      p.access === "open"
        ? (A.officialAccess === "Open" ? "Officially open (USGS PAD-US)."
           : p.type === "state" ? "State land — public by default."
           : p.type === "national" ? "Federal land — public by default."
           : "Municipal land — Connecticut town parks must admit non-residents.")
      : p.access === "permission"
        ? "Privately held but customarily open. You're here by the owner's permission, not by legal right — Connecticut's Recreational Use Statute is what makes this common. Respect posted signs."
      : p.access === "closed"
        ? "Recorded as closed to public access."
      : "We found no trail, parking or facility here, and no official rating. It may still be open — we just can't confirm it.";

    // --- 2. Who maintains it? ---
    p.steward = A.officialOwner || p.agency || STEWARD_BY_TYPE[p.type] || "Unknown";

    // --- 3. What kind of place? ---
    p.kind = p.subtype || { state: "State Park", national: "Federal Land",
                            town: "Town Park", preserve: "Preserve",
                            cemetery: "Cemetery" }[p.type] || "Public land";
  }

  // Kept for the trail pass, which re-scores then re-classifies.
  function scoreAccess(p) {
    const A = p.attrs || (p.attrs = {});
    A.visitable = !!(A.trails || A.parking || A.sports || A.playground || A.beach || A.pool);
    A.accessNote = A.trails ? "Trails mapped"
                 : A.parking ? "Parking nearby, no mapped trail"
                 : A.visitable ? "Facilities on site"
                 : "No mapped trail or parking";
    classify(p);
  }

  async function applyTrailAccess() {
    try {
      showStatus("Checking trail access…");
      const cells = await fetchTrailCells();
      const trailSet = new Set(cells);
      if (!trailSet.size) { hideStatus(); return; }
      for (const p of allParks) {
        const A = p.attrs || (p.attrs = {});
        if (trailNear(p.lat, p.lng, parkRadiusM(p) + 150, trailSet)) A.trails = true;
        scoreAccess(p);
        p.marker.setPopupContent(popupHtml(p));
      }
      hideStatus();
      refresh();
    } catch (e) {
      console.warn("Trail access check failed:", e);
      hideStatus();
    }
  }

  // ------------------------------------------------------------------
  // Park boundary overlays (actual shapes) — load per viewport when
  // zoomed in, so the map stays fast. State + town, color-coded.
  // ------------------------------------------------------------------
  // Trails sit in their own pane below the park polygons so the shapes
  // stay readable while the routes show through.
  map.createPane("trailPane");
  map.getPane("trailPane").style.zIndex = 390;
  const trailLayer = L.layerGroup().addTo(map);
  const loadedTrailIds = new Set();

  const overlayLayer = L.layerGroup().addTo(map);
  const loadedOverlayIds = new Set();
  let overlayTimer = null;

  // One green for "you can go here"; the border says who owns it.
  function landStyle(ownerType) {
    const V = CONFIG.visual;
    return {
      color: V.owner[ownerType] || V.owner.preserve,
      weight: V.borderWeight,
      opacity: 0.95,
      fillColor: V.publicFill,
      fillOpacity: V.fillOpen
    };
  }

  function overlayStyle(kind) { return landStyle(kind); }

  // ------------------------------------------------------------------
  // Hover: lift the parcel you're pointing at so its edges are obvious.
  // Land boundaries are irregular and often adjacent, so being able to
  // see where one ends is most of the value.
  // ------------------------------------------------------------------
  function attachHover(lyr, base, label) {
    const hot = {
      weight: base.weight * 2.6,
      opacity: 1,
      color: base.color,
      fillOpacity: Math.min(0.55, base.fillOpacity + 0.18)
    };
    lyr.on("mouseover", () => {
      lyr.setStyle(hot);
      if (lyr.bringToFront) { try { lyr.bringToFront(); } catch (e) {} }
      if (label) showHoverLabel(label);
    });
    lyr.on("mouseout", () => {
      lyr.setStyle(base);
      hideHoverLabel();
    });
    return lyr;
  }

  // A small floating caption, so hovering also tells you what it is.
  const hoverEl = document.createElement("div");
  hoverEl.id = "hoverLabel";
  hoverEl.style.display = "none";
  document.getElementById("map").appendChild(hoverEl);
  let hoverHideTimer = null;

  function showHoverLabel(text) {
    clearTimeout(hoverHideTimer);
    hoverEl.textContent = text;
    hoverEl.style.display = "block";
  }
  function hideHoverLabel() {
    hoverHideTimer = setTimeout(() => { hoverEl.style.display = "none"; }, 90);
  }

  // ------------------------------------------------------------------
  // Overlap control. The same patch of ground turns up in several
  // sources — OSM has a preserve, PAD-US has the fee parcel AND the
  // easement over it, DEEP has the state parcel. Drawing all of them
  // stacks borders and muddies the fill, so we register every shape we
  // draw and refuse anything that lands on top of one.
  // ------------------------------------------------------------------
  // State land is drawn once and never cleared, so it gets its own
  // permanent registry; viewport shapes use one that resets on zoom-out.
  const publicGrid = makeGrid(0.004);
  let drawnGrid = makeGrid(0.004);            // ~400 m cells
  const normName = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  function shapeCentre(f) {
    const g = f.geometry;
    if (!g) return null;
    const rings = g.type === "Polygon" ? g.coordinates
                : g.type === "MultiPolygon" ? g.coordinates.flat() : null;
    if (!rings || !rings.length) return null;
    let minX = 180, minY = 90, maxX = -180, maxY = -90, n = 0;
    for (const r of rings) for (const pt of r) {
      if (pt[0] < minX) minX = pt[0]; if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1]; if (pt[1] > maxY) maxY = pt[1];
      n++;
    }
    if (!n) return null;
    return { lat: (minY + maxY) / 2, lng: (minX + maxX) / 2,
             span: Math.max(maxX - minX, maxY - minY) };
  }

  // Already drawn if something with the same name sits nearby, or if any
  // shape's centre is nearly on top of this one.
  function alreadyDrawn(name, c) {
    if (!c) return false;
    const key = normName(name);
    // Bigger parcels tolerate a bigger offset before we call it the same.
    const tol = Math.min(400, Math.max(90, c.span * 111000 * 0.28));
    for (const grid of [drawnGrid, publicGrid])
      for (const [dist, prev] of grid.near(c.lat, c.lng, 1600)) {
        if (prev.key && key && prev.key === key && dist < 1600) return true;
        if (dist < tol) return true;
      }
    return false;
  }

  function registerDrawn(name, c) {
    if (c) drawnGrid.add(c.lat, c.lng, { key: normName(name) });
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
      const c = shapeCentre(f);
      if (alreadyDrawn(nm, c)) { loadedOverlayIds.add(id); continue; }
      loadedOverlayIds.add(id);
      registerDrawn(nm, c);
      const st = overlayStyle(kind);
      const lyr = L.geoJSON(f, { style: () => st });
      attachHover(lyr, st, nm);
      if (nm) lyr.bindPopup(`<span class="badge ${kind}">${labelFn(f)}</span><div class="popup-name">${nm}</div>`);
      overlayLayer.addLayer(lyr);
    }
  }

  // Land-trust and private-conservation boundaries from PAD-US, drawn in
  // the same visual language as everything else: green fill, owner-colour
  // border, dashed because access is by permission.
  function addPadusBoundaries(gj) {
    for (const f of (gj.features || [])) {
      const pr = f.properties || {};
      const id = "pad:" + (pr.OBJECTID || "");
      if (loadedOverlayIds.has(id)) continue;
      const nm = pr.Unit_Nm;
      if (!nm || nm === "Unknown") continue;
      if (GENERIC_NAME.test(nm) || TRIBAL_EXCLUDE.test(nm)) continue;
      if (EXCLUDE.test(nm) && !ALLOW.has(nm.toLowerCase())) continue;
      const c = shapeCentre(f);
      // PAD-US is drawn last, so this catches its duplicates of OSM
      // preserves and its own overlapping fee/easement records.
      if (alreadyDrawn(nm, c)) { loadedOverlayIds.add(id); continue; }
      loadedOverlayIds.add(id);
      registerDrawn(nm, c);
      const open = pr.Pub_Access === "OA";
      const padStyle = landStyle("preserve");
      const lyr = L.geoJSON(f, { style: padStyle });
      attachHover(lyr, padStyle, nm);
      lyr.bindPopup(
        `<span class="badge preserve">${DESIG_WORD[pr.Des_Tp] || "Protected land"}</span>
         <div class="popup-name">${nm}</div>
         <div class="popup-sub">${OWNER_WORD[pr.Own_Name] || "Private / non-profit"}</div>
         <div class="pblock ${open ? "acc-open" : "acc-permission"}">
           <div class="pb-head">${open ? "✅ Open to all" : "🤝 Open by permission"}</div>
           <div class="pb-body">${open
             ? "Officially open (USGS PAD-US)."
             : "Privately held but customarily open. You're here by the owner's permission rather than by legal right. Respect posted signs."}</div>
         </div>`);
      overlayLayer.addLayer(lyr);
    }
  }

  async function refreshOverlays() {
    if (!CONFIG.overlays.enabled) return;
    if (map.getZoom() < CONFIG.overlays.minZoom) {
      overlayLayer.clearLayers();
      loadedOverlayIds.clear();
      drawnGrid = makeGrid(0.004);      // forget viewport shapes too
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map(x => x.toFixed(4)).join(",");
    try {
      // State land is drawn once, statewide, by the public-land layer —
      // no need to re-fetch it per viewport here.
      const jobs = [
        Promise.resolve(null),
        fetchOverlayGeojson(CONFIG.municipal.serviceUrl, {
          where: "leisure='park' AND (access IS NULL OR access NOT IN ('private','no'))",
          geometry: bbox, outFields: "OBJECTID,name"
        })
      ];
      jobs.push(activeTypes.has("preserve")
        ? fetchOverlayGeojson(CONFIG.preserves.serviceUrl, {
            where: "leisure='nature_reserve' AND (access IS NULL OR access NOT IN ('private','no'))",
            geometry: bbox, outFields: "OBJECTID,name,operator"
          })
        : Promise.resolve(null));
      jobs.push(activeTypes.has("cemetery")
        ? fetchOverlayGeojson(CONFIG.cemeteries.serviceUrl, {
            where: "landuse='cemetery' AND (access IS NULL OR access NOT IN ('private','no'))",
            geometry: bbox, outFields: "OBJECTID,name"
          })
        : Promise.resolve(null));
      // PAD-US supplies boundaries for NON-government land only. State
      // land already comes from DEEP and town land from OSM, so limiting
      // it this way fills the land-trust gap without stacking duplicate
      // parcels on top of each other.
      jobs.push(padusBase && activeTypes.has("preserve")
        ? fetchOverlayGeojson(padusBase + "/query", {
            where: "Unit_Nm<>'Unknown' AND Pub_Access<>'XA' AND " +
                   "Own_Name IN ('NGO','PVT','JNT','OTHR','UNK')",
            geometry: bbox, outFields: "OBJECTID,Unit_Nm,Own_Name,Pub_Access,Des_Tp"
          })
        : Promise.resolve(null));
      const [, townGj, presGj, cemGj, padGj] = await Promise.all(jobs);
      addOverlayFeatures(townGj, "town", "name", () => "Town / City Park");
      if (presGj) {
        // Re-use the same operator rules so colors match the pins.
        presGj.features = (presGj.features || []).filter(f => {
          const cls = preserveClass(f.properties && f.properties.operator);
          if (!cls) return false;
          f.properties._label = cls.label;
          f.properties._kind = cls.kind;
          return true;
        });
        for (const f of presGj.features) {
          addOverlayFeatures({ features: [f] }, f.properties._kind, "name",
            g => g.properties._label);
        }
      }
      if (cemGj) addOverlayFeatures(cemGj, "cemetery", "name", () => "Cemetery");
      if (padGj) addPadusBoundaries(padGj);
    } catch (err) {
      console.warn("Overlay load failed:", err);
    }
  }

  // --- PUBLIC LAND: the primary visual --------------------------------
  // Every state-owned parcel, statewide, at every zoom. Tinted = public,
  // untinted = private. Drawn on canvas so 491 polygons stay smooth.
  map.createPane("publicPane");
  map.getPane("publicPane").style.zIndex = 380;
  const publicRenderer = L.canvas({ pane: "publicPane" });
  const publicLandLayer = L.layerGroup().addTo(map);

  // Which DEEP categories count as land you can walk on. DEP-owned
  // waterbodies are lakes, so they're styled but not called walkable.
  const LEGEND_LABELS = {
    "State Forest": "State Forest", "State Park": "State Park",
    "Wildlife Area": "Wildlife Management Area", "Wildlife Sanctuary": "Wildlife Sanctuary",
    "State Park Scenic Reserve": "Scenic Reserve", "Natural Area Preserve": "Natural Area Preserve",
    "Flood Control": "Flood Control Area", "Fish Hatchery": "Fish Hatchery",
    "Historic Preserve": "Historic Preserve", "Water Access": "Water Access",
    "DEP Owned Waterbody": "State Waterbody", "State Park Trail": "State Park Trail",
    "Other": "Other State Land"
  };

  function fetchPublicLand() {
    if (BAKED && BAKED.stateLand && BAKED.stateLand.length)
      return Promise.resolve(BAKED.stateLand);
    return cachedDataset("ctparks_publicland_v1", CONFIG.municipal.cacheDays, async () => {
      const body = new URLSearchParams({
        where: "1=1", outFields: "AV_LEGEND,PROPERTY,ACRE_GIS",
        outSR: "4326", returnGeometry: "true",
        maxAllowableOffset: CONFIG.publicLand.simplify,
        geometryPrecision: "5", resultRecordCount: "1000", f: "geojson"
      });
      const gj = await fetch(CONFIG.publicLand.url, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
      return gj.features || [];
    });
  }

  async function loadPublicLand() {
    if (!CONFIG.publicLand.enabled) return;
    try {
      const feats = await fetchPublicLand();
      const P = CONFIG.publicLand;
      for (const f of feats) {
        const legend = (f.properties && f.properties.AV_LEGEND) || "Other";
        const nm = (f.properties && f.properties.PROPERTY) || "State land";
        const ac = Math.round((f.properties && f.properties.ACRE_GIS) || 0);
        const pc = shapeCentre(f);
        if (pc) publicGrid.add(pc.lat, pc.lng, { key: normName(nm) });
        const stStyle = landStyle("state");
        const stLyr = L.geoJSON(f, {
          renderer: publicRenderer, pane: "publicPane",
          style: stStyle
        });
        attachHover(stLyr, stStyle, nm);
        stLyr.bindPopup(
          `<span class="badge state">${LEGEND_LABELS[legend] || legend}</span>
           <div class="popup-name">${nm}</div>
           <div class="popup-sub">Connecticut${ac ? " &middot; " + ac.toLocaleString() + " acres" : ""}</div>
           <div class="popup-access ok">✅ Public land — owned by the State of Connecticut</div>`
        ).addTo(publicLandLayer);
      }
    } catch (e) { console.warn("Public land layer failed:", e); }
  }

  // --- Protected open-space parcels (CT DEEP POSM) --------------------
  // Owner-less parcel geometry. Shows the real extent of protected land
  // even where nothing in our data has a name or a shape for it.
  map.createPane("parcelPane");
  map.getPane("parcelPane").style.zIndex = 385;
  const parcelLayer = L.layerGroup();
  const loadedParcelIds = new Set();
  let parcelsOn = false;

  async function refreshParcels() {
    const P = CONFIG.protectedParcels;
    if (!P.enabled || !parcelsOn) return;
    if (map.getZoom() < P.minZoom) return;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map(x => x.toFixed(4)).join(",");
    try {
      const body = new URLSearchParams({
        where: "1=1", geometry: bbox, geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326", outFields: "OBJECTID,TOWN,ACRES",
        returnGeometry: "true", maxAllowableOffset: "0.00006",
        resultRecordCount: "600", f: "geojson"
      });
      const gj = await fetch(P.url, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
      for (const f of (gj.features || [])) {
        const id = (f.properties && f.properties.OBJECTID) || f.id;
        if (id == null || loadedParcelIds.has(id)) continue;
        loadedParcelIds.add(id);
        const ac = Math.round((f.properties && f.properties.ACRES) || 0);
        L.geoJSON(f, { pane: "parcelPane",
          style: { color: P.color, weight: P.weight, opacity: 0.85,
                   fillColor: P.color, fillOpacity: P.fillOpacity } })
          .bindPopup(
            `<span class="badge" style="background:${P.color}">Protected open space</span>
             <div class="popup-name">${ac ? ac.toLocaleString() + " acres" : "Protected parcel"}</div>
             <div class="popup-sub">${(f.properties && f.properties.TOWN) || ""}</div>
             <div class="popup-fee">CT DEEP records this parcel as protected open space but doesn't record who owns it. It may belong to a preserve, town or land trust listed elsewhere on this map — or to one nothing has named yet.</div>`)
          .addTo(parcelLayer);
      }
    } catch (e) { console.warn("Parcel overlay failed:", e); }
  }

  // --- Blue-Blazed Hiking Trail System (CFPA) -------------------------
  // Loaded once for the whole state — only 351 segments — so the network
  // reads at any zoom. Own pane above the OSM paths.
  map.createPane("bbPane");
  map.getPane("bbPane").style.zIndex = 395;
  const bbLayer = L.layerGroup();
  let bbLoaded = false;

  async function loadBlueBlazed() {
    if (bbLoaded || !CONFIG.blueBlazed.enabled) return;
    const B = CONFIG.blueBlazed;
    showStatus("Loading Blue-Blazed trails…");
    try {
      const body = new URLSearchParams({
        where: "1=1", outFields: "TrailName,Blaze,Length",
        outSR: "4326", returnGeometry: "true",
        maxAllowableOffset: "0.0002", geometryPrecision: "5",
        resultRecordCount: "400", f: "geojson"
      });
      const gj = await fetch(B.url, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
      for (const f of (gj.features || [])) {
        const p = f.properties || {};
        const miles = p.Length ? (+p.Length).toFixed(1) + " mi" : "";
        const line = L.geoJSON(f, { pane: "bbPane",
          style: { color: B.color, weight: B.weight, opacity: B.opacity } });
        line.bindPopup(
          `<span class="badge" style="background:${B.color}">Blue-Blazed Trail</span>
           <div class="popup-name">${p.TrailName || "Blue-Blazed Trail"}</div>
           <div class="popup-sub">${[p.Blaze ? p.Blaze + " blaze" : "", miles].filter(Boolean).join(" &middot; ")}</div>
           <div class="popup-fee">Part of the Connecticut Forest &amp; Park Association's Blue-Blazed system (~825 miles, since 1929). Much of it crosses private land by easement or landowner permission — <strong>the footpath is public, the land beside it often isn't</strong>. Stay on the trail.</div>`
        );
        if (p.TrailName) line.bindTooltip(p.TrailName, { sticky: true });
        bbLayer.addLayer(line);
      }
      bbLoaded = true;
    } catch (e) { console.warn("Blue-Blazed load failed:", e); }
    hideStatus();
  }

  // --- Visible trail lines -------------------------------------------
  async function refreshTrailLines() {
    const T = CONFIG.trailLines;
    if (!T.enabled) return;
    if (map.getZoom() < T.minZoom) {
      trailLayer.clearLayers();
      loadedTrailIds.clear();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map(x => x.toFixed(4)).join(",");
    try {
      const body = new URLSearchParams({
        where: TRAIL_WHERE, geometry: bbox, geometryType: "esriGeometryEnvelope",
        inSR: "4326", outSR: "4326", outFields: "OBJECTID,name,highway",
        returnGeometry: "true", geometryPrecision: "6",
        resultRecordCount: "1200", f: "geojson"
      });
      const gj = await fetch(CONFIG.enrichment.trailsUrl, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }).then(r => r.json());
      for (const f of (gj.features || [])) {
        const id = (f.properties && f.properties.OBJECTID) || f.id;
        if (id == null || loadedTrailIds.has(id)) continue;
        loadedTrailIds.add(id);
        const nm = f.properties && f.properties.name;
        const line = L.geoJSON(f, {
          pane: "trailPane",
          style: { color: T.color, weight: T.weight, opacity: T.opacity, dashArray: T.dashArray }
        });
        if (nm) line.bindTooltip(nm, { sticky: true });
        trailLayer.addLayer(line);
      }
    } catch (err) {
      console.warn("Trail lines failed:", err);
    }
  }

  map.on("moveend zoomend", () => {
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      refreshOverlays(); refreshTrailLines(); refreshParcels(); refreshPadusLayer();
    }, 350);
  });

  // ------------------------------------------------------------------
  // Gap finder — trails that don't belong to any mapped place.
  // Inverts the access check: cells that have a trail but no park
  // nearby are probably somewhere we're missing.
  // ------------------------------------------------------------------
  const gapLayer = L.layerGroup();
  let gapsBuilt = false;

  async function buildGaps() {
    if (gapsBuilt) return;
    showStatus("Looking for unmapped trail areas…");
    const cells = await fetchTrailCells();
    // A cell is "covered" if it falls inside any place's own footprint
    // (scaled from acreage) plus a small margin — measuring to the
    // centre alone made big parks flag their own trails.
    const parkGrid = makeGrid(0.02);
    for (const p of allParks) parkGrid.add(p.lat, p.lng, parkRadiusM(p));
    const orphan = new Set();
    for (const key of cells) {
      const i = Math.floor(key / 1000000), j = (key % 1000000) - 500000;
      const lat = (i + 0.5) * TRAIL_CELL, lng = (j + 0.5) * TRAIL_CELL;
      if (!findTown(lat, lng)) continue;                 // outside Connecticut
      const near = parkGrid.near(lat, lng, 2600);
      let covered = false;
      for (const [dist, rad] of near) if (dist <= rad + 300) { covered = true; break; }
      if (covered) continue;
      orphan.add(i + "," + j);
    }
    // Group touching cells so one trail network = one pin, not fifty.
    const seen = new Set(), clusters = [];
    for (const k of orphan) {
      if (seen.has(k)) continue;
      const queue = [k], members = [];
      seen.add(k);
      while (queue.length) {
        const cur = queue.pop();
        members.push(cur);
        const [ci, cj] = cur.split(",").map(Number);
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const nk = (ci + di) + "," + (cj + dj);
          if (orphan.has(nk) && !seen.has(nk)) { seen.add(nk); queue.push(nk); }
        }
      }
      if (members.length < 4) continue;   // ignore stray driveway-sized bits
      let si = 0, sj = 0;
      for (const m of members) { const [a, b] = m.split(",").map(Number); si += a; sj += b; }
      clusters.push({
        lat: (si / members.length + 0.5) * TRAIL_CELL,
        lng: (sj / members.length + 0.5) * TRAIL_CELL,
        size: members.length
      });
    }
    clusters.sort((a, b) => b.size - a.size);
    for (const c of clusters.slice(0, 400)) {
      const town = findTown(c.lat, c.lng) || "Connecticut";
      const approxAcres = Math.round(c.size * 6.7);   // ~165 m cell
      L.circleMarker([c.lat, c.lng], {
        radius: Math.min(16, 5 + Math.sqrt(c.size)),
        color: "#ff5252", weight: 2, fillColor: "#ff5252", fillOpacity: 0.35
      }).bindPopup(
        `<span class="badge" style="background:#ff5252">Unmapped trail area</span>
         <div class="popup-name">Trails with no listed place</div>
         <div class="popup-sub">${town} &middot; roughly ${approxAcres.toLocaleString()} acres of trail coverage</div>
         <div class="popup-fee">Something is here but nothing in our data claims it. Worth checking whether it's a preserve we're missing, or private land.</div>
         <div class="popup-links"><a href="https://www.google.com/maps/search/?api=1&query=${c.lat},${c.lng}" target="_blank" rel="noopener">Look at it</a></div>`
      ).addTo(gapLayer);
    }
    gapsBuilt = true;
    hideStatus();
    showStatus(`Found ${clusters.length} unmapped trail areas`);
    setTimeout(hideStatus, 4000);
  }

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

  document.querySelectorAll(".chip[data-access]").forEach(chip => {
    chip.addEventListener("click", () => {
      const a = chip.dataset.access;
      if (activeAccess.has(a)) { activeAccess.delete(a); chip.classList.remove("active"); }
      else { activeAccess.add(a); chip.classList.add("active"); }
      refresh();
    });
  });

  const layersPanel = document.getElementById("layersPanel");
  document.getElementById("layersBtn").addEventListener("click", (e) => {
    layersPanel.hidden = !layersPanel.hidden;
    e.currentTarget.classList.toggle("active", !layersPanel.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!layersPanel.hidden && !layersPanel.contains(e.target) &&
        e.target.id !== "layersBtn") {
      layersPanel.hidden = true;
      document.getElementById("layersBtn").classList.remove("active");
    }
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

  document.getElementById("padusToggle").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (map.hasLayer(padusLayer)) {
      map.removeLayer(padusLayer);
      padusOn = false;
      btn.classList.remove("active");
      document.getElementById("legend").classList.remove("padus");
    } else {
      if (!padusBase) { showStatus("Still checking PAD-US…"); setTimeout(hideStatus, 2500); return; }
      padusOn = true;
      btn.classList.add("active");
      padusLayer.addTo(map);
      document.getElementById("legend").classList.add("padus");
      if (map.getZoom() < CONFIG.padus.minZoom) {
        showStatus("Zoom in to see official access areas");
        setTimeout(hideStatus, 3000);
      }
      await refreshPadusLayer();
    }
  });

  document.getElementById("parcelToggle").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (map.hasLayer(parcelLayer)) {
      map.removeLayer(parcelLayer);
      parcelsOn = false;
      btn.classList.remove("active");
    } else {
      parcelsOn = true;
      btn.classList.add("active");
      parcelLayer.addTo(map);
      if (map.getZoom() < CONFIG.protectedParcels.minZoom) {
        showStatus("Zoom in to see protected land parcels");
        setTimeout(hideStatus, 3000);
      }
      await refreshParcels();
    }
  });

  document.getElementById("bbToggle").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (map.hasLayer(bbLayer)) {
      map.removeLayer(bbLayer);
      btn.classList.remove("active");
    } else {
      btn.classList.add("active");
      await loadBlueBlazed();
      bbLayer.addTo(map);
    }
  });

  document.getElementById("gapToggle").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (map.hasLayer(gapLayer)) {
      map.removeLayer(gapLayer);
      btn.classList.remove("active");
    } else {
      btn.classList.add("active");
      await buildGaps();
      gapLayer.addTo(map);
    }
  });

  document.getElementById("listToggle").addEventListener("click", () => {
    document.getElementById("listPanel").classList.toggle("hidden");
  });

  // ------------------------------------------------------------------
  // Baked data first if it's there, then public land — the thing the map
  // is actually for — then everything else.
  loadBaked().then(loadPublicLand);

  document.querySelector("#legend .legend-title").addEventListener("click", () => {
    document.getElementById("legend").classList.toggle("collapsed");
  });

  loadStatic().then(loadStateExtra).then(loadBoatLaunches).then(fetchMunicipal)
              .then(loadExtraLanduse).then(loadMuseums)
              .then(loadPreserves).then(loadCemeteries)
              .then(enrich).then(refreshOverlays).then(refreshTrailLines).catch(err => {
    console.error(err);
    showStatus("Something went wrong loading park data. Try refreshing.");
  });
})();
