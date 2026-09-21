/* ============================================================
   EVERYPARK — ROADS

   Every recorded road in Connecticut and New York, drawn at the
   same density whatever the zoom. No level of detail: the road
   network read as a map of where people are, rather than as
   wayfinding that thins out when you pull back.

   The tiles come from data/roads.pmtiles, built by
   fetchroads.py + makeroadtiles.py. Each rank in the ladder is
   its own layer inside the tile, holding ONE feature: a
   multi-linestring of every road of that rank in that tile. So
   a rank is one canvas path, stroked once — which is why nine
   ranks of every street in the state can repaint at all.

   Everything visual is CONFIG.roads. Nothing here decides a
   colour or a width.
   ============================================================ */

const EveryParkRoads = (() => {
  let layer = null, map = null;
  let mode = "atlas";                 // "atlas" | "ink"
  let visible = true;                 // the master switch in the panel
  const off = new Set();              // rank ids the visitor switched off

  const cfg = () => CONFIG.roads || {};

  // Width multiplier at this zoom, interpolated between the stops in
  // CONFIG.roads.scale. Widths have to move with zoom even though the
  // set of roads does not: the same hairline that reads as a street at
  // z14 is a solid smear at z8 when a million of them are on screen.
  // This is the only thing about the roads that zoom is allowed to
  // change, and it changes how they LOOK, never which ones are there.
  function scaleAt(z) {
    const stops = cfg().scale || [[7, 0.3], [13, 1], [19, 2.4]];
    if (z <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      const [z1, v1] = stops[i], [z0, v0] = stops[i - 1];
      if (z <= z1) return v0 + (v1 - v0) * (z - z0) / (z1 - z0);
    }
    return stops[stops.length - 1][1];
  }

  const shown = r => !off.has(r.id);

  // A stroke thinner than about a third of a pixel disappears into
  // anti-aliasing and takes the whole rank with it, so the ladder is
  // compressed at the bottom rather than allowed to vanish.
  const widthOf = (r, extra) => z =>
    Math.max(0.35, r.width * scaleAt(z) + (extra || 0));

  function paintRules() {
    const c = cfg();
    const rules = [];
    (c.ranks || []).forEach(r => {
      // Casing then fill, rank by rank, smallest rank first. All the
      // casings in one pass ahead of all the fills would put a local
      // street's ink over the interstate's outline at every junction.
      if (r.casing) {
        rules.push({
          dataLayer: r.id,
          filter: () => mode === "atlas" && shown(r),
          symbolizer: new protomapsL.LineSymbolizer({
            color: r.casing,
            width: widthOf(r, c.casingWidth == null ? 1.4 : c.casingWidth),
            opacity: r.opacity == null ? 1 : r.opacity,
            lineCap: "round", lineJoin: "round"
          })
        });
      }
      rules.push({
        dataLayer: r.id,
        filter: () => shown(r),
        symbolizer: new protomapsL.LineSymbolizer({
          color: () => mode === "ink" ? (c.ink || {}).color || "#243024"
                                      : r.color,
          width: widthOf(r),
          opacity: () => mode === "ink"
            ? (c.ink || {}).opacity == null ? 0.55 : c.ink.opacity
            : (r.opacity == null ? 1 : r.opacity),
          // Round caps so a road that quantises to a single tick at
          // zoom 7 still leaves a mark. With butt caps the shortest
          // streets — the dense residential mass this map is about —
          // draw as nothing at all.
          lineCap: "round", lineJoin: "round",
          dash: mode === "ink" ? null : (r.dash || null)
        })
      });
    });
    return rules;
  }

  function repaint() {
    if (!layer) return;
    if (layer.rerenderTiles) layer.rerenderTiles();
    else if (layer.redraw) layer.redraw();
  }

  // ---- the filter chips, built from the ladder in config -------------
  function buildChips(host) {
    const c = cfg();
    const chips = document.createElement("div");
    chips.className = "chips";
    // Biggest first: the chip row is also how you learn the ladder.
    [...(c.ranks || [])].reverse().forEach(r => {
      const b = document.createElement("button");
      b.className = "chip road-chip" + (off.has(r.id) ? "" : " active");
      b.dataset.road = r.id;
      b.style.setProperty("--dot", r.casing || r.color);
      b.innerHTML = `<span class="dot"></span>${r.label}`;
      b.title = r.what || "";
      b.addEventListener("click", () => {
        if (off.has(r.id)) { off.delete(r.id); b.classList.add("active"); }
        else { off.add(r.id); b.classList.remove("active"); }
        EveryParkPrefs.setList("roadsOff", [...off]);
        repaint();
      });
      chips.appendChild(b);
    });

    const ink = document.createElement("button");
    ink.className = "chip road-chip road-mode" + (mode === "ink" ? " active" : "");
    ink.textContent = "One ink";
    ink.title = "Drop the colours and read the whole network as density";
    ink.addEventListener("click", () => {
      mode = mode === "ink" ? "atlas" : "ink";
      ink.classList.toggle("active", mode === "ink");
      EveryParkPrefs.set("roadsInk", mode === "ink");
      repaint();
    });
    chips.appendChild(ink);

    const none = document.createElement("button");
    none.className = "chip road-chip road-mode";
    none.textContent = "Hide all";
    none.addEventListener("click", () => {
      const anyOn = (cfg().ranks || []).some(shown);
      off.clear();
      if (anyOn) (cfg().ranks || []).forEach(r => off.add(r.id));
      host.querySelectorAll(".chip[data-road]").forEach(b =>
        b.classList.toggle("active", !off.has(b.dataset.road)));
      none.textContent = anyOn ? "Show all" : "Hide all";
      EveryParkPrefs.setList("roadsOff", [...off]);
      repaint();
    });
    chips.appendChild(none);

    host.appendChild(chips);
  }

  function buildLegend() {
    const host = document.getElementById("legend");
    if (!host) return;
    const c = cfg();
    const box = document.createElement("div");
    box.className = "legend-roads";
    box.innerHTML =
      `<div class="legend-title" style="margin-top:8px">Roads — every one, at every zoom</div>` +
      [...(c.ranks || [])].reverse().map(r =>
        `<div class="legend-row"><span class="sw road-sw" style="background:${r.color};
           height:${Math.min(5, Math.max(1.5, r.width * 1.3)).toFixed(1)}px;
           ${r.casing ? `outline:1px solid ${r.casing};` : ""}"></span>${r.label}</div>`
      ).join("") +
      `<div class="legend-note">Nothing is dropped when you zoom out, so the
        thickness of the weave is the thickness of settlement. Turn ranks off
        in Layers.</div>`;
    host.appendChild(box);
  }

  // The layer being constructed says nothing about whether the archive
  // is there: PMTiles reads its header lazily, so a 404 shows up as an
  // empty map and no error anyone sees. Since the park tiles stop
  // drawing trails on the strength of this layer existing, a missing
  // archive would quietly delete every trail from the map. Ask for the
  // first bytes, and hand the trails back if they do not arrive.
  function verifyArchive(url) {
    fetch(url, { headers: { Range: "bytes=0-511" } })
      .then(r => { if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status); })
      .catch(err => {
        console.warn("Roads archive unreachable:", err);
        if (layer && map) map.removeLayer(layer);
        layer = null;
        if (CONFIG.trailLines) CONFIG.trailLines.inTiles = true;
        if (typeof EveryParkTiles !== "undefined" && EveryParkTiles.repaint)
          EveryParkTiles.repaint();
        const chips = document.getElementById("roadGroup");
        if (chips) chips.hidden = true;
        const leg = document.querySelector(".legend-roads");
        if (leg) leg.remove();
      });
  }

  return {
    init(theMap) {
      const c = cfg();
      if (!c.enabled) return false;
      if (typeof protomapsL === "undefined") {
        console.warn("protomaps-leaflet missing — no roads layer.");
        return false;
      }
      map = theMap;
      // What the visitor last chose. The ranks are a list rather than a
      // flag because "which ones are off" is the state worth keeping —
      // a rank added to the ladder later then starts ON, which is the
      // right default for something nobody has an opinion about yet.
      visible = EveryParkPrefs.get("roads", (CONFIG.mapLayers || {}).roads);
      EveryParkPrefs.getList("roadsOff", []).forEach(id => off.add(id));
      if (EveryParkPrefs.get("roadsInk", false)) mode = "ink";
      try {
        layer = protomapsL.leafletLayer({
          url: c.url,
          paintRules: paintRules(),
          labelRules: [],
          maxDataZoom: c.maxDataZoom || 14,
          // Over the parks, under nothing. A road that vanished the
          // moment it crossed a state forest would be useless for the
          // one thing this layer is for.
          pane: "epRoadLines"
        });
        if (visible) layer.addTo(map);
      } catch (e) {
        console.warn("Roads failed to load:", e);
        return false;
      }
      const host = document.getElementById("roadChips");
      if (host) buildChips(host);
      buildLegend();
      verifyArchive(c.url);
      return true;
    },

    // Every road on or off, from the Layers panel. Removing the layer
    // rather than painting nothing also stops it fetching tiles as you
    // pan, which on this archive is the expensive part.
    setVisible(on) {
      visible = !!on;
      if (!layer || !map) return;
      if (visible && !map.hasLayer(layer)) layer.addTo(map);
      else if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
    },

    // Diagnostics, reachable from the console.
    _probe() {
      return { mode, off: [...off], hasLayer: !!layer, visible,
               ranks: (cfg().ranks || []).map(r => r.id),
               scaleNow: map ? scaleAt(map.getZoom()) : null };
    },
    setMode(m) { mode = m; repaint(); }
  };
})();
