/* ============================================================
   EVERYPARK — ISOMETRIC TERRAIN PROTOTYPE ("like a video game")

   Opens from the ⛰ button on a place card. Fetches real elevation
   for the place's surroundings from the public AWS Terrain Tiles
   dataset (Mapzen terrarium encoding, no key needed), then draws a
   rotatable isometric heightmap column-by-column on a canvas.

   Deliberately a PROTOTYPE:
   - square area around the pin, sized from acreage (no boundary
     clipping yet — that needs the polygon handed over from the
     vector tiles, which is the obvious next step)
   - colours are derived from elevation + the place's stored NLCD
     cover ("mostly wooded" → greens), water level tinted blue
   - if the elevation tiles can't load (offline, CORS), it degrades
     to a procedural hill built from the place's stored elev/relief,
     so the button never opens a broken panel

   This is the only part of the site that fetches from a live
   service, and only when the button is pressed — the map itself
   still loads nothing at runtime.
   ============================================================ */

const EveryParkIso = (() => {
  const TILE = z => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/`;
  const GRID = 96;                    // heightmap resolution (cells per side)

  let raf = null;

  function metersPerSide(p) {
    // Square that comfortably contains the place: from acreage if we
    // have it (side of the equivalent square, padded), else 900 m.
    const acres = Number(p.acres) || 0;
    const side = acres > 0 ? Math.sqrt(acres * 4046.86) * 1.7 : 900;
    return Math.min(Math.max(side, 500), 6000);
  }

  function tileXY(lat, lng, z) {
    const n = 2 ** z;
    const x = (lng + 180) / 360 * n;
    const latR = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    return { x, y };
  }

  function loadImage(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
  }

  // Sample a GRID×GRID heightmap around the pin from terrarium tiles.
  async function fetchHeights(p, sideM) {
    // Pick a zoom where the area spans a sensible number of pixels.
    const z = sideM > 3000 ? 12 : sideM > 1200 ? 13 : 14;
    const mPerDeg = 111320 * Math.cos(p.lat * Math.PI / 180);
    const dLng = sideM / mPerDeg / 2, dLat = sideM / 111320 / 2;
    const tl = tileXY(p.lat + dLat, p.lng - dLng, z);
    const br = tileXY(p.lat - dLat, p.lng + dLng, z);

    const x0 = Math.floor(tl.x), y0 = Math.floor(tl.y);
    const x1 = Math.floor(br.x), y1 = Math.floor(br.y);
    const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
    if (cols * rows > 9) throw new Error("area spans too many tiles");

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
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const fx = (tl.x - x0 + (br.x - tl.x) * gx / (GRID - 1)) * 256;
        const fy = (tl.y - y0 + (br.y - tl.y) * gy / (GRID - 1)) * 256;
        const ix = Math.min(cv.width - 1, Math.max(0, Math.round(fx)));
        const iy = Math.min(cv.height - 1, Math.max(0, Math.round(fy)));
        const k = (iy * cv.width + ix) * 4;
        // terrarium: elevation = (R*256 + G + B/256) - 32768
        H[gy * GRID + gx] = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
      }
    }
    return H;
  }

  // Fallback: a plausible hill from the stored elev/relief, so the
  // prototype still shows something with no network.
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

  function coverPalette(p) {
    const c = ((p.attrs || {}).cover || "").toLowerCase();
    if (c.includes("wood")) return { lo: [46, 92, 60], hi: [140, 185, 120] };
    if (c.includes("open")) return { lo: [126, 138, 74], hi: [214, 205, 130] };
    if (c.includes("wet") || c.includes("water")) return { lo: [58, 96, 92], hi: [150, 190, 170] };
    return { lo: [70, 105, 72], hi: [175, 195, 140] };
  }

  function draw(canvas, H, p, yaw) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, Hh = canvas.height;
    ctx.clearRect(0, 0, W, Hh);

    let min = Infinity, max = -Infinity;
    for (const h of H) { if (h < min) min = h; if (h > max) max = h; }
    const span = Math.max(max - min, 8);
    const pal = coverPalette(p);
    const A = p.attrs || {};
    const water = (A.water && A.waterType !== "river") ? min + span * .06 : -Infinity;

    const s = W / (GRID * 1.9);               // iso cell size
    const zScale = Math.min(60, 9000 / span) * (span / 90);
    const cx = W / 2, cy = Hh * 0.62;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);

    // Painter's algorithm: sort cells by projected depth each frame.
    const order = [];
    for (let gy = 0; gy < GRID; gy++)
      for (let gx = 0; gx < GRID; gx++) {
        const rx = (gx - GRID / 2) * cos - (gy - GRID / 2) * sin;
        const ry = (gx - GRID / 2) * sin + (gy - GRID / 2) * cos;
        order.push([ry, rx, gx, gy]);
      }
    order.sort((a, b) => a[0] - b[0]);

    for (const [ry, rx, gx, gy] of order) {
      const h = H[gy * GRID + gx];
      const t = (h - min) / span;
      const X = cx + rx * s * 1.55;
      const Y = cy + ry * s * .8 - (h - min) / span * zScale;

      let r, g, b;
      if (h <= water) { r = 62; g = 118; b = 168; }
      else {
        r = pal.lo[0] + (pal.hi[0] - pal.lo[0]) * t;
        g = pal.lo[1] + (pal.hi[1] - pal.lo[1]) * t;
        b = pal.lo[2] + (pal.hi[2] - pal.lo[2]) * t;
        // cheap hillshade: compare with the neighbour to the "light" side
        const n = H[gy * GRID + Math.max(0, gx - 1)];
        const sh = Math.max(-14, Math.min(18, (h - n) * 1.6));
        r += sh; g += sh; b += sh;
      }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      const w = s * 1.62, hgt = s * .92;
      ctx.fillRect(X - w / 2, Y - hgt / 2, w + .7, hgt + .7);
    }

    // Pin marker at centre.
    ctx.fillStyle = "#ff5b4d";
    ctx.beginPath();
    ctx.arc(cx, cy - (H[(GRID / 2 | 0) * GRID + (GRID / 2 | 0)] - min) / span * zScale - 8, 4.5, 0, 7);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = "11px system-ui";
    ctx.fillText(`${Math.round(min)}–${Math.round(max)} m`, 10, Hh - 10);
  }

  async function open(p) {
    if (document.getElementById("isoOverlay")) return;
    const ov = document.createElement("div");
    ov.id = "isoOverlay";
    ov.innerHTML = `
      <div id="isoPanel">
        <h3>${p.name}</h3>
        <div class="iso-sub">Isometric terrain prototype · drag to rotate ·
          real USGS/AWS elevation${p.acres ? ` · ~${Number(p.acres).toLocaleString()} acres` : ""}</div>
        <canvas width="820" height="520"></canvas>
        <div class="iso-foot">
          <span>Elevation: AWS Terrain Tiles (Mapzen terrarium) · fetched on demand</span>
          <button id="isoClose">Close</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const canvas = ov.querySelector("canvas");
    const close = () => { cancelAnimationFrame(raf); ov.remove(); };
    ov.querySelector("#isoClose").addEventListener("click", close);
    ov.addEventListener("click", e => { if (e.target === ov) close(); });

    const side = metersPerSide(p);
    let H;
    try { H = await fetchHeights(p, side); }
    catch (e) { console.warn("terrain tiles unavailable, procedural fallback:", e); H = proceduralHeights(p); }

    let yaw = 0.0, target = 0.0, dragging = false, lastX = 0;
    canvas.addEventListener("pointerdown", e => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", e => { if (dragging) { target += (e.clientX - lastX) * .008; lastX = e.clientX; } });
    canvas.addEventListener("pointerup", () => dragging = false);

    const loop = () => {
      if (!document.getElementById("isoOverlay")) return;
      if (!dragging) target += 0.0012;         // slow idle spin
      yaw += (target - yaw) * .15;
      draw(canvas, H, p, yaw);
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  return { open };
})();
window.EveryParkIso = EveryParkIso;
