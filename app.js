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
  rootStyle.setProperty("--accent", CONFIG.colors.accent);

  const map = L.map("map", { zoomControl: true }).setView(CONFIG.mapCenter, CONFIG.mapZoom);
  L.tileLayer(CONFIG.basemap.url, {
    attribution: CONFIG.basemap.attribution,
    maxZoom: 19
  }).addTo(map);

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
  const activeTypes = new Set(["state", "national", "town"]);
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
    return "Town / City Park";
  }

  function popupHtml(p) {
    const acres = p.acres ? ` &middot; ${Number(p.acres).toLocaleString()} acres` : "";
    return `
      <span class="badge ${p.type}">${typeLabel(p)}</span>
      <div class="popup-name">${p.name}</div>
      <div class="popup-sub">${p.town || "Connecticut"}${acres}</div>
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
  function visible(p) {
    if (!activeTypes.has(p.type)) return false;
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
  const CACHE_KEY = "ctparks_municipal_v1";

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && Date.now() - c.time < CONFIG.municipal.cacheDays * 864e5) return c.parks;
    } catch (e) { /* ignore */ }
    return null;
  }

  const EXCLUDE = /state (park|forest)|scenic reserve|national (park|historical|scenic)/i;

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
          where: "leisure='park' AND name IS NOT NULL",
          geometry: "-73.75,40.95,-71.77,42.06",
          geometryType: "esriGeometryEnvelope",
          inSR: "4326",
          outSR: "4326",
          outFields: "name",
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
          const name = f.attributes.name;
          const c = f.centroid;
          if (!name || !c) continue;
          if (EXCLUDE.test(name)) continue;
          parks.push({ n: name, lat: +c.y.toFixed(5), lng: +c.x.toFixed(5) });
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
      addPark({ name: m.n, type: "town", lat: m.lat, lng: m.lng, town });
    }
    refresh();
    hideStatus();
    if (fresh) {
      showStatus(`Loaded ${parks.length.toLocaleString()} town & city parks`);
      setTimeout(hideStatus, 3500);
    }
  }

  // ------------------------------------------------------------------
  // UI wiring
  // ------------------------------------------------------------------
  document.querySelectorAll(".chip").forEach(chip => {
    chip.style.setProperty("--dot", CONFIG.colors[chip.dataset.type]);
    chip.addEventListener("click", () => {
      const t = chip.dataset.type;
      if (activeTypes.has(t)) { activeTypes.delete(t); chip.classList.remove("active"); }
      else { activeTypes.add(t); chip.classList.add("active"); }
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
  loadStatic().then(fetchMunicipal).catch(err => {
    console.error(err);
    showStatus("Something went wrong loading park data. Try refreshing.");
  });
})();
