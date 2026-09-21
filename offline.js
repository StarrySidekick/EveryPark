/* ============================================================
   EVERYPARK — OFFLINE

   Registers the service worker, and gives the visitor one
   honest control: save this region, or don't.

   The principle is the same one the rest of the map runs on.
   Do not assert something you have not checked. An app that
   silently half-works without a signal is worse than one that
   says which parts are gone, because the first kind gets
   trusted on a trail where being wrong costs you.
   ============================================================ */

const EveryParkOffline = (() => {
  let reg = null;
  let saving = false;
  let els = {};

  const cfg = () => CONFIG.offline || {};
  const mb = n => (n / 1e6).toFixed(0) + " MB";

  // One round trip to the worker. A MessageChannel rather than a global
  // listener, so two overlapping questions cannot answer each other.
  function ask(msg, onProgress) {
    return new Promise((resolve, reject) => {
      const sw = navigator.serviceWorker.controller;
      if (!sw) return reject(new Error("no service worker in control yet"));
      const ch = new MessageChannel();
      ch.port1.onmessage = e => {
        const d = e.data || {};
        if (d.type === "progress") { if (onProgress) onProgress(d); return; }
        if (d.type === "error") return reject(new Error(d.message));
        resolve(d);
      };
      sw.postMessage(msg, [ch.port2]);
    });
  }

  // ---- what the visitor sees ----------------------------------------
  function paint(state) {
    if (!els.status) return;
    if (saving) return;                       // progress owns the line
    if (state && state.complete) {
      els.status.textContent = `Saved for offline (${mb(state.total)})`;
      els.save.hidden = true;
      els.forget.hidden = false;
    } else {
      els.status.textContent = "Not saved. The map needs a connection.";
      els.save.hidden = false;
      els.forget.hidden = true;
      els.save.textContent = cfg().sizeHint
        ? `Save region (${cfg().sizeHint})` : "Save region";
    }
    els.bar.hidden = true;
  }

  async function refresh() {
    try { paint(await ask({ type: "status" })); }
    catch (e) { if (els.status) els.status.textContent = "Offline saving unavailable."; }
  }

  async function save() {
    if (saving) return;
    saving = true;
    els.save.hidden = true;
    els.bar.hidden = false;
    // Without this the browser may evict the whole thing the next time
    // it wants disk, which for a map you saved deliberately before a
    // hike is exactly the wrong moment.
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); }
    catch (e) {}
    try {
      const out = await ask({ type: "save" }, p => {
        const pct = p.total ? Math.min(100, 100 * p.loaded / p.total) : 0;
        els.fill.style.width = pct.toFixed(1) + "%";
        els.status.textContent = `Saving ${mb(p.loaded)} of ${mb(p.total)}`;
      });
      saving = false;
      paint(out);
    } catch (err) {
      saving = false;
      els.status.textContent = "Could not save: " + err.message;
      els.bar.hidden = true;
      els.save.hidden = false;
    }
  }

  async function forget() {
    els.status.textContent = "Removing…";
    try { paint(await ask({ type: "forget" })); } catch (e) { refresh(); }
  }

  function build(host) {
    const g = document.createElement("div");
    g.className = "lp-group";
    g.id = "offlineGroup";
    g.innerHTML = `
      <div class="lp-title">Offline</div>
      <div class="lp-note" id="offStatus">Checking…</div>
      <div class="off-bar" id="offBar" hidden><div id="offFill"></div></div>
      <div class="chips">
        <button class="chip" id="offSave" hidden>Save region</button>
        <button class="chip" id="offForget" hidden>Remove</button>
      </div>
      <div class="lp-note">Saved, the parks, boundaries and every road work
        with no signal. Aerial imagery, relief, names and the 3D viewer's
        terrain come from other people's servers and will not.</div>`;
    host.appendChild(g);
    els = {
      status: g.querySelector("#offStatus"), bar: g.querySelector("#offBar"),
      fill: g.querySelector("#offFill"), save: g.querySelector("#offSave"),
      forget: g.querySelector("#offForget")
    };
    els.save.addEventListener("click", save);
    els.forget.addEventListener("click", forget);
  }

  // ---- saying what is gone ------------------------------------------
  // Marked rather than disabled: a stale browser cache may still have
  // these, and taking a basemap away from someone who can still see it
  // would be its own kind of lie.
  function markNetworkLayers() {
    const on = navigator.onLine;
    document.body.classList.toggle("is-offline", !on);
    document.querySelectorAll("#baseChips .chip").forEach(c => {
      const b = (CONFIG.basemaps || []).find(x => x.label === c.dataset.base);
      const needsNet = !!(b && b.url);
      c.classList.toggle("needs-net", needsNet && !on);
      if (needsNet && !on) c.title = "Aerial imagery needs a connection";
      else if (needsNet) c.title = "";
    });
    ["relief", "water", "names"].forEach(n => {
      const c = document.querySelector(`#layersPanel .chip[data-layer="${n}"]`);
      if (c) {
        c.classList.toggle("needs-net", !on);
        c.title = on ? "" : "This layer is fetched, so it needs a connection";
      }
    });
    const badge = document.getElementById("offlineBadge");
    if (badge) badge.hidden = on;
  }

  return {
    async init() {
      if (cfg().enabled === false) return false;
      if (!("serviceWorker" in navigator)) return false;

      window.addEventListener("online", markNetworkLayers);
      window.addEventListener("offline", markNetworkLayers);
      markNetworkLayers();

      const host = document.getElementById("layersPanel");
      if (host) build(host);

      try {
        reg = await navigator.serviceWorker.register("sw.js");
      } catch (e) {
        console.warn("Service worker did not register:", e);
        if (els.status) els.status.textContent = "Offline saving unavailable here.";
        return false;
      }
      // On a first visit nothing is controlling the page yet, so the
      // status question has nobody to answer it. Wait for control
      // rather than reporting "unavailable" to someone whose worker is
      // installing perfectly well.
      if (!navigator.serviceWorker.controller) {
        await new Promise(res => {
          navigator.serviceWorker.addEventListener("controllerchange", res, { once: true });
          setTimeout(res, 4000);
        });
      }
      // Tell the worker where the archives actually are before asking
      // it anything. They are configurable precisely so they can move
      // off this origin, and the worker cannot guess.
      const archives = [
        (CONFIG.vectorTiles || {}).url,
        (CONFIG.roads || {}).url
      ].filter(Boolean).map(u => new URL(u, location.href).toString());
      try { paint(await ask({ type: "config", archives })); }
      catch (e) { refresh(); }
      return true;
    },
    _probe: async () => {
      try { return await ask({ type: "status" }); }
      catch (e) { return { error: String(e.message) }; }
    }
  };
})();

// Bootstrapped here rather than from app.js: this file loads after it,
// so by the time this runs the Layers panel it attaches to exists.
EveryParkOffline.init();
