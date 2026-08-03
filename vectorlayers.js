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
  // normalised name -> "open" | "permission" | "unverified" | "fee".
  // The tiles carry geometry and source attributes but not our verdict,
  // so the verdict is handed in from the place list and matched by name
  // (including each place's aka names, so renamed places still resolve).
  let statusBy = null;
  // Given a feature's name and where it was clicked, hands back the popup
  // for the actual place record. The tiles carry only geometry and a few
  // source attributes; everything a visitor wants — access, steward,
  // what's there, directions — lives on the place, so the polygon and the
  // pin must resolve to the same thing.
  let resolvePlace = null;

  // Border colour by who owns the land. Same palette as the pins —
  // kept in sync with CONFIG.visual.owner (the source of truth).
  const OWNER = {
    stateland:  "#2b8a3e",
    townparks:  "#1971c2",
    landuse:    "#1971c2",
    preserves:  "#0c8599",
    padus:      "#0c8599",
    cemeteries: "#7048b6"
  };

  // Cemetery polygons FILL purple (their category colour) rather than
  // park green; the border still answers "who runs it": town-run
  // cemeteries get the town blue, everything else a neutral slate so the
  // purple fill does the talking.
  const CEM_TOWN = /\b(town|city|borough|village)\b/i;
  function cemeteryBorder(f) {
    const op = (f.props && f.props.operator) || "";
    return CEM_TOWN.test(op) ? OWNER.townparks : "#5b6770";
  }

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

  const normName = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // Three honest tiers (Timothy's colour system, 2026-08-03):
  //   green  = verified open, just go
  //   amber  = you can probably go — by the owner's permission (or paid)
  //   grey   = unverified: we have no data either way
  const statusOf = f => {
    try {
      if (!statusBy) return "open";
      return statusBy.get(normName(nameOf(f))) || "unverified";
    } catch (e) { return "open"; }
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
  // PAD-US easement designation classes: a conservation/agricultural/
  // forest easement restricts what the owner may build — it is not a
  // right of way, and the land stays private. The place builder already
  // excludes these; the tiles were still drawing them, which is how
  // "Korsant Easement" showed up as an amber shape nobody could ever
  // verify. Hidden unless a real place record exists for the name (so a
  // fee-owned parcel PAD-US mislabels, like Upland Pastures, still draws).
  const EASEMENT = new Set(["CONE", "AGRE", "FORE", "PAGR", "UNKE"]);

  const padusOk = f => {
    const p = f.props || {};
    if (p.Pub_Access === "XA") return false;
    if (!p.Unit_Nm || p.Unit_Nm === "Unknown") return false;
    if (p.Own_Name === "TRIB" || p.Mang_Name === "TRIB") return false;
    if (EASEMENT.has(p.Des_Tp) && statusBy
        && !statusBy.has(normName(p.Unit_Nm))) return false;
    return ["NGO", "PVT", "JNT", "OTHR", "UNK"].includes(p.Own_Name);
  };

  function landRule(dataLayer, extraFilter) {
    const V = CONFIG.visual;
    const H = CONFIG.hover || {};
    const border = OWNER[dataLayer];
    return {
      dataLayer,
      filter: (z, f) => visible(dataLayer, f) && (!extraFilter || extraFilter(f)),
      // The highlight is done inside this one symbolizer rather than as
      // extra paint rules: adding rules for the same dataLayer stopped the
      // layer loading tiles at all.
      symbolizer: new protomapsL.PolygonSymbolizer({
        // Fill = the verdict tier; cemeteries keep their category purple
        // when verified. Border = who owns it, except grey unverified.
        fill: (z, f) => {
          if (keyOf(dataLayer, f) === hoverKey) return H.fill || "#c8f5cf";
          const s = statusOf(f);
          if (s === "unverified") return V.unverifiedFill || "#8e9a93";
          if (dataLayer === "cemeteries") return V.cemeteryFill || "#8464c9";
          if (s === "permission" || s === "fee") return V.permissionFill || "#e8a33d";
          return V.publicFill;
        },
        opacity: (z, f) => keyOf(dataLayer, f) === hoverKey
                         ? (H.fillOpacity != null ? H.fillOpacity : 0.62)
                         : V.fillOpen,
        stroke: (z, f) => {
          if (keyOf(dataLayer, f) === hoverKey) return H.stroke || "#ffffff";
          if (statusOf(f) === "unverified") return V.unverifiedBorder || "#66716b";
          return dataLayer === "cemeteries" ? cemeteryBorder(f) : border;
        },
        width: (z, f) => keyOf(dataLayer, f) === hoverKey
                       ? (H.width || 6) : V.borderWeight
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
      },
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

    // Same entity, same popup. Falling through to the sparse tile-only
    // version below is a last resort for shapes with no matching place.
    if (resolvePlace) {
      const html = resolvePlace(nameOf(hit.f), e.latlng);
      if (html) {
        L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(html).openOn(map);
        return;
      }
    }

    const p = hit.f.props || {};
    const acres = Math.round(p.ACRE_GIS || p.GIS_Acres || p.ACRES || 0);
    const kind = p.AV_LEGEND || LABEL[hit.dataLayer] || "Public land";
    const who = p.operator || p.Own_Name || "";
    L.popup({ maxWidth: 260 })
      .setLatLng(e.latlng)
      .setContent(
        // A shape with no place record has been through none of the
        // verification the rest of the map depends on. This used to say
        // "You can go here", which asserted public access for anything
        // that happened to be drawn — including tribal reservation land
        // that is explicitly not open. Unverified is the honest label,
        // and it matches what a place record with no evidence would show.
        `<div class="pblock acc-unknown"><div class="pb-head">⚠️ Unverified</div>
           <div class="pb-body">Mapped boundary with no place record. We can't
             confirm this is open to the public.</div></div>
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
          // The archive stops at zoom 14. Without this the renderer looks
          // for tiles that don't exist once you zoom past it and draws
          // nothing at all — the map goes blank exactly when you've zoomed
          // in to look at something. This tells it to reuse zoom-14 tiles.
          maxDataZoom: CONFIG.vectorTiles.maxDataZoom || 14,
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

    // Lets a clicked polygon show the same popup as its pin.
    setPlaceResolver(fn) { resolvePlace = fn; },

    // Hand in the verified/unverified verdict per place name.
    setStatus(lookup) {
      statusBy = lookup;
      // Redrawing before the first tiles have arrived leaves the layer in a
      // state where it never paints at all, so defer to the next frame.
      if (layer && layer.rerenderTiles) {
        setTimeout(() => { try { layer.rerenderTiles(); } catch (e) {} }, 0);
      }
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
