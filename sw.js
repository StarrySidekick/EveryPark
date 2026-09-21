/* ============================================================
   EVERYPARK — SERVICE WORKER

   Makes the map work with no connection, and lets a visitor
   deliberately save the region so it keeps working somewhere
   with no signal. Which is the point: the places this map is
   about are largely places without a bar of reception.

   Three caches, on purpose:

     ep-shell-<version>   the code. Replaced wholesale on deploy.
     ep-data-v1           the JSON. Survives deploys; the data has
                          its own version and its own rhythm.
     ep-archives-v1       the PMTiles. ~156 MB, and ONLY ever
                          written when the visitor asks for it.

   ============================================================
   THE HARD PART: PMTiles is nothing but HTTP range requests.

   A service worker cannot cache a 206 response — `cache.put`
   rejects a partial response outright, and it would be the wrong
   thing anyway, since you would end up with a cache full of
   arbitrary byte windows nobody can reassemble.

   So the archive is stored ONCE, whole, and this worker answers
   range requests out of it by slicing the stored Blob. Blob
   slicing is lazy and file-backed, so serving a 4 KB tile out of
   a 65 MB archive does not read 65 MB. `arrayBuffer()` here
   instead of `blob()` would, on every single tile.
   ============================================================ */

const VERSION = "v0.56.0";          // keep in step with CONFIG.siteVersion
const SHELL = `ep-shell-${VERSION}`;
const DATA = "ep-data-v1";
const ARCHIVES = "ep-archives-v1";

// Everything needed to draw a map with no network at all. If a file is
// missing from this list the app still loads online and fails offline,
// which is the worst of both, so the offline check asserts the list is
// complete rather than trusting it.
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "prefs.js",
  "vectorlayers.js",
  "roadlayers.js",
  "iso.js",
  "app.js",
  "offline.js",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/protomaps-leaflet.js",
  "manifest.webmanifest",
  "icons/state.svg", "icons/national.svg", "icons/town.svg",
  "icons/preserve.svg", "icons/cemetery.svg",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];

// The big ones. Everything else under data/ is JSON small enough to
// cache as a side effect of being fetched.
//
// These are DEFAULTS. The page sends the real list on every load, taken
// from CONFIG.vectorTiles.url and CONFIG.roads.url, because the archives
// are not necessarily on this origin: they are the only files here big
// enough to want moving to object storage, and when they move, the
// offline save has to move with them. Hard-coding "data/*.pmtiles" would
// mean the day they move is the day offline silently stops working.
let ARCHIVE_FILES = ["data/everypark.pmtiles", "data/roads.pmtiles"];

// Absolute URLs of archives actually in the cache right now. Rebuilt on
// activate and after every save, and consulted on every request — a
// cross-origin archive has to be recognised without asking the cache,
// or every basemap tile would pay for a cache lookup.
let savedUrls = new Set();

async function rebuildSaved() {
  savedUrls = new Set();
  try {
    const cache = await caches.open(ARCHIVES);
    for (const req of await cache.keys()) savedUrls.add(keyFor(req.url));
  } catch (e) { /* nothing saved yet */ }
}

// One cache entry per file, not one per cache-busting query string.
// Without this a dataVersion bump leaves the old copy behind forever and
// the cache grows by a whole dataset every publish.
const keyFor = url => {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
};

const isArchive = path => ARCHIVE_FILES.some(f => path.endsWith(f.split("?")[0]));
const isData = path => /\/data\/.+\.(json|geojson)$/.test(path);

// ---------------------------------------------------------------------
// Install / activate
// ---------------------------------------------------------------------
self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, not addAll: addAll is all-or-nothing, so one 404 on
    // a file nobody needs would leave the visitor with no offline app
    // and no clue which file did it.
    const failed = [];
    await Promise.all(SHELL_FILES.map(async f => {
      try {
        const res = await fetch(f, { cache: "reload" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await cache.put(keyFor(new URL(f, self.location).toString()), res);
      } catch (err) { failed.push(f + ": " + err.message); }
    }));
    if (failed.length) console.warn("[sw] shell files missing:", failed);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    // Old shells go; data and archives stay. Re-downloading 156 MB
    // because a stylesheet changed would be indefensible.
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith("ep-shell-") && n !== SHELL)
      .map(n => caches.delete(n)));
    await rebuildSaved();
    await self.clients.claim();
  })());
});

// ---------------------------------------------------------------------
// Serving a range out of a whole stored archive
// ---------------------------------------------------------------------
async function serveArchive(request) {
  const cache = await caches.open(ARCHIVES);
  const stored = await cache.match(keyFor(request.url));
  if (!stored) return null;                 // not saved: let it go to network

  const range = request.headers.get("range");
  const blob = await stored.blob();
  if (!range) {
    return new Response(blob, { status: 200, headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(blob.size),
      "Accept-Ranges": "bytes"
    }});
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return null;
  let start, end;
  if (m[1] === "") {                        // bytes=-N, the last N bytes
    const n = Math.min(parseInt(m[2], 10) || 0, blob.size);
    start = blob.size - n;
    end = blob.size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? blob.size - 1 : Math.min(parseInt(m[2], 10), blob.size - 1);
  }
  if (!(start >= 0) || start > end || start >= blob.size)
    return new Response(null, { status: 416 });

  // Blob.slice does not read the file. This is the whole trick.
  return new Response(blob.slice(start, end + 1), { status: 206, headers: {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${blob.size}`,
    "Accept-Ranges": "bytes"
  }});
}

// ---------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // A saved archive is served from here wherever it lives, so moving the
  // archives to another host does not cost the offline map.
  if (savedUrls.has(keyFor(e.request.url))) {
    e.respondWith((async () => {
      const hit = await serveArchive(e.request);
      return hit || fetch(e.request).catch(() =>
        new Response(null, { status: 504, statusText: "offline" }));
    })());
    return;
  }

  // Basemap rasters, ArcGIS, Wikipedia: somebody else's problem, and
  // caching them is not ours to do. They fail offline and the app says so.
  if (url.origin !== self.location.origin) return;

  if (isArchive(url.pathname)) {
    e.respondWith((async () => {
      const hit = await serveArchive(e.request);
      if (hit) return hit;
      try { return await fetch(e.request); }
      catch (err) {
        // Offline and not saved. 504 rather than a thrown error, so the
        // renderer reports a missing tile instead of an exception.
        return new Response(null, { status: 504, statusText: "offline, region not saved" });
      }
    })());
    return;
  }

  if (isData(url.pathname)) {
    // Stale while revalidate: the dataset is republished monthly and is
    // never urgent, so a visitor should never wait on the network for it
    // and should never be stuck with last month's copy either.
    e.respondWith((async () => {
      const cache = await caches.open(DATA);
      const key = keyFor(e.request.url);
      const hit = await cache.match(key);
      const live = fetch(e.request).then(res => {
        if (res.ok) cache.put(key, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await live) || new Response("[]", {
        status: 504, headers: { "Content-Type": "application/json" } });
    })());
    return;
  }

  // The shell. Cache first: it is pinned to this VERSION, so it cannot
  // go stale without a deploy, and a deploy makes a new cache.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(keyFor(e.request.url));
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === "basic") cache.put(keyFor(e.request.url), res.clone());
      return res;
    } catch (err) {
      const index = await cache.match(keyFor(new URL("index.html", self.location).toString()));
      return index || new Response("Offline", { status: 504 });
    }
  })());
});

// ---------------------------------------------------------------------
// Saving the region
// ---------------------------------------------------------------------
async function saveRegion(port) {
  const cache = await caches.open(ARCHIVES);
  let done = 0, grand = 0;

  // Ask how big this is before starting, so the progress bar means
  // something from the first byte rather than growing a denominator.
  const sizes = [];
  for (const f of ARCHIVE_FILES) {
    try {
      const head = await fetch(f, { method: "HEAD" });
      sizes.push(Number(head.headers.get("content-length")) || 0);
    } catch (e) { sizes.push(0); }
  }
  grand = sizes.reduce((a, b) => a + b, 0);
  port.postMessage({ type: "progress", loaded: 0, total: grand });

  for (let i = 0; i < ARCHIVE_FILES.length; i++) {
    const f = ARCHIVE_FILES[i];
    const res = await fetch(f);
    if (!res.ok) throw new Error(f + ": HTTP " + res.status);

    // Counting pass-through, so the bytes stream to disk instead of
    // piling up in memory. Buffering both archives to build a Blob would
    // be ~156 MB of RAM on a phone, for no reason.
    let seen = 0;
    const counter = new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        done += chunk.byteLength;
        port.postMessage({ type: "progress", loaded: done, total: grand, file: f });
        controller.enqueue(chunk);
      }
    });
    const size = sizes[i] || Number(res.headers.get("content-length")) || 0;
    await cache.put(keyFor(new URL(f, self.location).toString()),
      new Response(res.body.pipeThrough(counter), { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size)
      }}));
  }
  return grand;
}

async function savedBytes() {
  const cache = await caches.open(ARCHIVES);
  let total = 0, files = 0;
  for (const f of ARCHIVE_FILES) {
    const hit = await cache.match(keyFor(new URL(f, self.location).toString()));
    if (!hit) continue;
    files++;
    total += (await hit.blob()).size;
  }
  return { files, total, complete: files === ARCHIVE_FILES.length };
}

self.addEventListener("message", e => {
  const port = e.ports && e.ports[0];
  const reply = msg => port && port.postMessage(msg);
  const job = (async () => {
    switch ((e.data || {}).type) {
      case "status":
        await rebuildSaved();
        reply({ type: "status", ...(await savedBytes()), version: VERSION });
        break;
      case "save":
        try {
          const n = await saveRegion(port);
          await rebuildSaved();
          reply({ type: "saved", ...(await savedBytes()), asked: n });
        } catch (err) {
          reply({ type: "error", message: String(err && err.message || err) });
        }
        break;
      case "forget":
        await caches.delete(ARCHIVES);
        await rebuildSaved();
        reply({ type: "status", ...(await savedBytes()), version: VERSION });
        break;

      // The page telling the worker where the archives actually live.
      case "config":
        if (Array.isArray(e.data.archives) && e.data.archives.length)
          ARCHIVE_FILES = e.data.archives;
        await rebuildSaved();
        reply({ type: "status", ...(await savedBytes()), version: VERSION });
        break;
    }
  })();
  e.waitUntil && e.waitUntil(job);
});
