/* ============================================================
   EVERYPARK — VECTOR TILE LAYERS
   All the boundary and trail geometry, served from one PMTiles
   file instead of fetched from a dozen services as you pan.

   The visual system is unchanged and still says three things at
   once: green fill = you can go here, border colour = who owns
   it, and the pin's icon = what kind of place it is.

   Because the attributes travel inside the tiles, restyling and
   filtering happen instantly here — no refetching anything.
   ============================================================ */

const EveryParkTiles = (() => {
  let layer = null, map = null, active = null;
  let hoverKey = null, hoverLabelEl = null;

  // Border colour by who owns the land. Same palette as the pins.
  const OWNER = {
    stateland:  "#1b5e20",
    townparks:  "#1565c0",
    landuse:    "#1565c0",
    preserves:  "#00838f",
    padus:      "#00838f",
    cemeteries: "#5e35b1"
  };

  // Which filter chip governs each tile layer, so the map obeys the
  // same "Who runs it" buttons the pins do.
  const CHIP = {
    stateland: "state", townparks: "town", landuse: "town",
    preserves: "preserve", padus: "preserve", cemeteries: "cemetery"
  };

  // Places that fail the public-access test: members-only clubs,
  // private camps, and tribal land that can't be entered without
  // written permission. Same rules the pin data uses.
  const EXCLUDE = /\b(golf|country club|yacht club|hunt club|rod (and|&) gun|scout|camp [a-z]+ reservation|private|members only|association)\b/i;
  const TRIBAL = /\b(schaghticoke|golden hill|paucatuck|mashantucket|mohegan|pequot)\b.*\b(reservation|tribal)\b/i;

  const nameOf = f => {
    const p = f.props || {};
    return p.name || p.PROPERTY || p.Unit_Nm || "";
  };

  // A stable identity for a feature, used to know what's hovered.
  // Tiles have no feature ids, so name plus rounded size stands in.
  const keyOf = (dataLayer, f) => {
    const p = f.props || {};
    const size = Math.round(p.ACRE_GIS || p.GIS_Acres || p.ACRES || 0);
    return dataLayer + "|" + nameOf(f) + "|" + size;
  };

  const visible = (dataLayer, f) => {
    const chip = CHIP[dataLayer];
    if (chip && active && !active.has(chip)) return false;
    const nm = nameOf(f);
    if (nm && (EXCLUDE.test(nm) || TRIBAL.test(nm))) return false;
    return true;
  };

  // PAD-US covers everything, including land already drawn from DEEP
  // and OpenStreetMap. Restricting it to non-government owners fills
  // the land-trust gap without stacking duplicate parcels.
  const padusOk = f => {
    const p = f.props || {};
    if (p.Pub_Access === "XA") return false;
    if (!p.Unit_Nm || p.Unit_Nm === "Unknown") return false;
    if (p.Own_Name === "TRIB" || p.Mang_Name === "TRIB") return false;
    return ["NGO", "PVT", "JNT", "OTHR", "UNK"].includes(p.Own_Name);
  };

  function landRule(dataLayer, extraFilter) {
    const V = CONFIG.visual;
    const border = OWNER[dataLayer];
    return {
      dataLayer,
      filter: (z, f) => visible(dataLayer, f) && (!extraFilter || extraFilter(f)),
      symbolizer: new protomapsL.PolygonSymbolizer({
        fill: V.publicFill,
        opacity: V.fillOpen,
        stroke: border,
        // Hovering thickens the outline. This is the whole reason the
        // border is drawn from the same rule as the fill.
        width: (z, f) => keyOf(dataLayer, f) === hoverKey
                       ? V.borderWeight * 2.8 : V.borderWeight
      })
    };
  }

  function paintRules() {
    const T = CONFIG.trailLines, B = CONFIG.blueBlazed;
    return [
      // Drawn biggest-first so small parcels stay clickable on top.
      landRule("stateland"),
      landRule("padus", padusOk),
      landRule("preserves"),
      landRule("landuse"),
      landRule("townparks"),
      landRule("cemeteries"),
      {
        dataLayer: "trails",
        symbolizer: new protomapsL.LineSymbolizer({
          color: T.color, width: T.weight, dash: [5, 4], opacity: T.opacity
        })
      },
      {
        dataLayer: "blueblazed",
        symbolizer: new protomapsL.LineSymbolizer({
          color: B.color, width: B.weight, opacity: B.opacity
        })
      }
    ];
  }

  const LABEL = {
    stateland: "State land", townparks: "Town / City Park",
    landuse: "Town open space", preserves: "Preserve / open space",
    padus: "Protected land", cemeteries: "Cemetery",
    trails: "Trail", blueblazed: "Blue-Blazed Trail"
  };

  // What's under the cursor, best guess: the smallest thing wins, so
  // a pocket park inside a state forest is what you get.
  // What's under the cursor. The method really is called
  // queryTileFeaturesDebug — it takes (lng, lat) and returns a Map whose
  // keys are paint-rule ids, so the tile layer a feature came from has to
  // be read off each picked feature's own layerName, not the Map key.
  function pick(latlng) {
    if (!layer || typeof layer.queryTileFeaturesDebug !== "function") return null;
    let hits;
    try {
      hits = layer.queryTileFeaturesDebug(latlng.lng, latlng.lat);
    } catch (e) { return null; }
    if (!hits) return null;

    let best = null;
    const consider = pf => {
      const f = pf.feature || pf;
      const dataLayer = pf.layerName || f.layerName;
      if (!dataLayer || dataLayer === "trails" || dataLayer === "blueblazed") return;
      if (!visible(dataLayer, f)) return;
      if (dataLayer === "padus" && !padusOk(f)) return;
      if (!nameOf(f)) return;
      const p = f.props || {};
      // Smallest thing wins, so a pocket park inside a state forest is
      // what you get rather than the forest around it.
      const size = p.ACRE_GIS || p.GIS_Acres || p.ACRES || 1e9;
      if (!best || size < best.size) best = { dataLayer, f, size };
    };

    const groups = hits instanceof Map ? [...hits.values()] : Object.values(hits);
    for (const arr of groups) (arr || []).forEach(consider);
    return best;
  }

  let moveCount = 0;

  function onMove(e) {
    moveCount++;
    const hit = pick(e.latlng);
    const key = hit ? keyOf(hit.dataLayer, hit.f) : null;
    if (key === hoverKey) return;
    hoverKey = key;
    if (hoverLabelEl) {
      if (hit) {
        hoverLabelEl.textContent = nameOf(hit.f);
        hoverLabelEl.style.display = "block";
      } else {
        hoverLabelEl.style.display = "none";
      }
    }
    if (layer && layer.rerenderTiles) layer.rerenderTiles();
    else if (layer && layer.redraw) layer.redraw();
  }

  function onClick(e) {
    const hit = pick(e.latlng);
    if (!hit) return;
    const p = hit.f.props || {};
    const acres = Math.round(p.ACRE_GIS || p.GIS_Acres || p.ACRES || 0);
    const kind = p.AV_LEGEND || LABEL[hit.dataLayer] || "Public land";
    const who = p.operator || p.Own_Name || "";
    L.popup({ maxWidth: 260 })
      .setLatLng(e.latlng)
      .setContent(
        `<div class="pblock acc-open"><div class="pb-head">You can go here</div>
           <div class="pb-body">Public land. Check posted signs for hours.</div></div>
         <div class="popup-name">${nameOf(hit.f)}</div>
         <div class="popup-sub">${kind}${acres ? " &middot; " + acres.toLocaleString() + " acres" : ""}</div>
         ${who ? `<div class="pi-steward">${who}</div>` : ""}`)
      .openOn(map);
  }

  return {
    // Returns true if the tile layer took over, false to fall back to
    // the old per-viewport fetching.
    init(theMap, activeTypes) {
      if (typeof protomapsL === "undefined") {
        console.warn("protomaps-leaflet missing — using live boundary fetching.");
        return false;
      }
      map = theMap;
      active = activeTypes;
      try {
        layer = protomapsL.leafletLayer({
          url: CONFIG.vectorTiles.url,
          paintRules: paintRules(),
          labelRules: [],
          pane: "overlayPane"
        });
        layer.addTo(map);
      } catch (e) {
        console.warn("Vector tiles failed to load:", e);
        return false;
      }

      hoverLabelEl = document.getElementById("hoverLabel");
      if (!hoverLabelEl) {
        hoverLabelEl = document.createElement("div");
        hoverLabelEl.id = "hoverLabel";
        hoverLabelEl.style.display = "none";
        document.querySelector("main").appendChild(hoverLabelEl);
      }
      map.on("mousemove", onMove);
      map.on("click", onClick);
      return true;
    },

    // Called when the filter chips change. No refetching — the data is
    // already local, so this is just a repaint.
    refresh(activeTypes) {
      if (!layer) return;
      active = activeTypes;
      if (layer.rerenderTiles) layer.rerenderTiles();
      else if (layer.redraw) layer.redraw();
    },

    active() { return !!layer; },

    // Diagnostics, reachable from the console.
    _probe(lat, lng) {
      const hit = pick({ lat, lng });
      let raw = null;
      try {
        const q = layer.queryTileFeaturesDebug(lng, lat);
        const g = q instanceof Map ? [...q.values()] : Object.values(q || {});
        raw = g.flat().map(p => ({ ln: p.layerName, props: (p.feature || {}).props }));
      } catch (e) { raw = "ERR " + e.message; }
      return { moves: moveCount, hasLayer: !!layer, hasMap: !!map,
               active: active ? [...active] : null, hoverKey, raw,
               hit: hit ? { layer: hit.dataLayer, name: nameOf(hit.f) } : null };
    }
  };
})();
