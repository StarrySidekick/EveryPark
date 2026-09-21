// What the roads layer must actually do, checked in a real browser.
// Usage: serve the REPO ROOT on :8125, then `node tools/isotest/roadsview.mjs`.
//
// The claim this file exists to defend is the one thing that makes this
// layer different from every other road layer: the SAME roads are drawn
// at every zoom. That is invisible in a screenshot of one zoom level and
// obvious the moment you measure two.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const SITE = process.env.SITE || "http://127.0.0.1:8125/index.html";
const fails = [];

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });

// Offline, like the rest of tools/isotest. The page asks unpkg for
// Leaflet and protomaps-leaflet; those come from vendor/ instead, so
// this check needs no network and cannot be broken by a CDN. Refresh
// them with the curl lines in vendor/README when index.html's pinned
// versions move.
//
// One handler for everything: Playwright gives the LAST matching route
// priority, so a catch-all registered after a specific one silently
// wins and the specific one never runs.
const VENDOR = new URL("./vendor/", import.meta.url).pathname;
await page.route(/^https?:/, route => {
  const u = route.request().url();
  if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost"))
    return route.continue();
  if (u.includes("unpkg.com")) {
    const name = u.includes("protomaps") ? "protomaps-leaflet.js"
               : u.endsWith(".css") ? "leaflet.css" : "leaflet.js";
    return route.fulfill({ path: VENDOR + name,
      contentType: name.endsWith(".css") ? "text/css" : "application/javascript" });
  }
  // Basemap rasters and live ArcGIS queries are not what this checks,
  // and waiting on them makes the timings meaningless.
  return route.abort();
});

const errors = [];
page.on("pageerror", e => errors.push("PAGEERROR " + e));
page.on("console", m => {
  // Everything this check aborts on purpose — basemap rasters, live
  // ArcGIS — reports itself here as a failed resource. Those are not
  // findings; anything else is.
  if (m.type() === "error"
      && !/favicon|Failed to load resource|ERR_(NAME|INTERNET|TUNNEL|CONNECTION|FAILED)/.test(m.text()))
    errors.push("CONSOLE " + m.text());
});

await page.goto(SITE);
await page.waitForTimeout(3000);

// Hartford: dense enough to have every rank in one screen.
const goto = async (lat, lng, z) => {
  await page.evaluate(([la, ln, zz]) => window.__map.setView([la, ln], zz),
                      [lat, lng, z]);
  await page.waitForTimeout(3500);
};

// Ink laid down by the roads layer, as a fraction of the pane. Measured
// on the roads pane's own canvas, so parks, water and relief cannot be
// mistaken for roads.
const inkFraction = () => page.evaluate(() => {
  const cvs = [...document.querySelectorAll(".leaflet-epRoadLines-pane canvas")];
  if (!cvs.length) return -1;
  let on = 0, total = 0;
  for (const c of cvs) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    total += c.width * c.height;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 12) on++;
  }
  return total ? on / total : -1;
});

const probe = () => page.evaluate(() => EveryParkRoads._probe());

const p0 = await probe();
if (!p0.hasLayer) fails.push("roads layer did not initialise");
console.log("ranks:", p0.ranks.join(", "));

// 1. No level of detail. The ink must not thin out as you pull back:
//    zoom 8 covers 32x the ground of zoom 13, so if anything is being
//    dropped it shows here as a collapse toward zero.
const ink = {};
for (const z of [13, 11, 9, 8]) {
  await goto(41.7637, -72.6851, z);
  ink[z] = await inkFraction();
  console.log(`z${z}: roads cover ${(100 * ink[z]).toFixed(2)}% of the pane`);
}
for (const z of [13, 11, 9, 8]) {
  if (!(ink[z] > 0.004)) fails.push(`z${z} drew almost nothing (${ink[z]})`);
}
if (ink[8] < ink[13] * 0.5)
  fails.push(`ink collapsed on zooming out: z13 ${ink[13]} -> z8 ${ink[8]}`);

// 2. The rank chips do something, and it is the thing they say.
await goto(41.7637, -72.6851, 12);
const before = await inkFraction();
await page.click('#filtersBtn');
await page.click('.chip[data-road="local"]');
await page.waitForTimeout(2000);
const afterOff = await inkFraction();
console.log(`local streets off: ${(100 * before).toFixed(2)}% -> ${(100 * afterOff).toFixed(2)}%`);
if (!(afterOff < before * 0.85))
  fails.push(`turning local streets off changed little (${before} -> ${afterOff})`);
await page.click('.chip[data-road="local"]');
await page.waitForTimeout(2000);
const back = await inkFraction();
if (Math.abs(back - before) > before * 0.08)
  fails.push(`turning local streets back on did not restore (${before} -> ${back})`);

// 3. One-ink mode repaints in one colour.
const hues = () => page.evaluate(() => {
  const cvs = [...document.querySelectorAll(".leaflet-epRoadLines-pane canvas")];
  const seen = new Map();
  for (const c of cvs) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const k = (d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
});
const atlasHues = await hues();
await page.click('.chip.road-mode');           // "One ink"
await page.waitForTimeout(2500);
const inkHues = await hues();
console.log("atlas top colours:", JSON.stringify(atlasHues.slice(0, 3)));
console.log("one-ink top colours:", JSON.stringify(inkHues.slice(0, 3)));
if (atlasHues.length && inkHues.length && atlasHues[0][0] === inkHues[0][0])
  fails.push("one-ink mode did not change the palette");
await page.screenshot({ path: "/tmp/roads-ink.png" });
await page.click('.chip.road-mode');
await page.waitForTimeout(2000);
await page.screenshot({ path: "/tmp/roads-atlas.png" });

// 4. Trails are drawn once, not twice: the park tiles must be holding
//    their own trails back while the roads archive has them.
const inTiles = await page.evaluate(() => CONFIG.trailLines.inTiles);
if (inTiles !== false && p0.hasLayer)
  fails.push("park tiles still drawing trails while the roads layer has them");

if (errors.length) fails.push(...errors);
console.log(fails.length ? "\nFAILED:\n  " + fails.join("\n  ") : "\nall roads checks passed");
await browser.close();
process.exit(fails.length ? 1 : 0);
