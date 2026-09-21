// Does it actually work with the radio off?
// Usage: python3 tools/isotest/serve.py 8125 &  then  node tools/isotest/offline.mjs
//
// Not a unit test of the service worker. The only claim worth checking
// is the one a person would make on a trail: I saved this at home, I
// have no signal, does the map draw. So this saves the region, cuts the
// network at the browser, RELOADS, and measures ink on the canvas.
//
// Deliberately no request routing: everything the app needs is now
// served from this repo, so there is nothing to stub. Requests to
// basemap rasters and ArcGIS are left to fail exactly as they would on
// a phone in a state forest.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const SITE = process.env.SITE || "http://127.0.0.1:8125/index.html";
const fails = [];

const browser = await chromium.launch({ executablePath: EXEC });
const context = await browser.newContext({ viewport: { width: 1200, height: 820 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push("PAGEERROR " + e));

const settle = ms => page.waitForTimeout(ms);
// Ink on the roads pane: the honest measure of "the map drew".
const roadInk = () => page.evaluate(() => {
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
const parkInk = () => page.evaluate(() => {
  const cvs = [...document.querySelectorAll(".leaflet-overlay-pane canvas")];
  let on = 0, total = 0;
  for (const c of cvs) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    total += c.width * c.height;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 12) on++;
  }
  return total ? on / total : -1;
});

await page.goto(SITE);
await settle(4000);

// 1. The worker must take control, or nothing below can work.
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
console.log("service worker in control:", controlled);
if (!controlled) fails.push("no service worker took control of the page");

await page.evaluate(() => window.__map.setView([41.7637, -72.6851], 12));
await settle(3000);
const onlineRoads = await roadInk();
const onlineParks = await parkInk();
console.log(`online: roads ${(100 * onlineRoads).toFixed(2)}%, parks ${(100 * onlineParks).toFixed(2)}%`);

// 2. Save the region, and watch it actually move.
await page.click("#layersBtn");
await settle(500);
const before = await page.textContent("#offStatus");
console.log("before saving:", JSON.stringify(before));
const t0 = Date.now();
await page.click("#offSave");
try {
  await page.waitForFunction(
    () => /Saved for offline/.test(document.getElementById("offStatus").textContent),
    null, { timeout: 240000 });
} catch (e) {
  fails.push("save never completed: " + (await page.textContent("#offStatus")));
}
const saved = await page.textContent("#offStatus");
console.log(`after saving: ${JSON.stringify(saved)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const status = await page.evaluate(() => EveryParkOffline._probe());
console.log("worker reports:", JSON.stringify(status));
if (!status.complete) fails.push("worker does not report a complete save");

// 3. Cut the network and reload. This is the whole test.
await context.setOffline(true);
await page.reload();
await settle(5000);
await page.evaluate(() => window.__map.setView([41.7637, -72.6851], 12));
await settle(5000);

const offRoads = await roadInk();
const offParks = await parkInk();
console.log(`offline: roads ${(100 * offRoads).toFixed(2)}%, parks ${(100 * offParks).toFixed(2)}%`);
await page.screenshot({ path: "/tmp/offline-map.png" });

if (!(offRoads > 0.004))
  fails.push(`no roads drawn offline (${offRoads})`);
if (offRoads < onlineRoads * 0.9)
  fails.push(`roads thinner offline than online: ${onlineRoads} -> ${offRoads}`);
if (!(offParks > 0.004))
  fails.push(`no park shapes drawn offline (${offParks})`);

// 4. Places came from cached JSON, not thin air.
const placeCount = await page.evaluate(() => {
  try { return window.__map && document.querySelectorAll(".ep-mark-canvas").length; }
  catch (e) { return -1; }
});
const searchable = await page.evaluate(async () => {
  const el = document.getElementById("search");
  el.value = "Sleeping Giant";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 700));
  const box = document.getElementById("searchResults");
  return box && !box.hidden ? box.textContent.slice(0, 80) : "";
});
console.log("offline search for a known park:", JSON.stringify(searchable));
if (!/sleeping giant/i.test(searchable))
  fails.push("the dataset did not survive offline: search found nothing");

// 5. The app must SAY it is offline rather than looking broken.
const badge = await page.evaluate(() =>
  !document.getElementById("offlineBadge").hidden);
const marked = await page.evaluate(() =>
  document.querySelectorAll("#layersPanel .chip.needs-net").length);
console.log(`offline badge shown: ${badge}, layers marked as needing signal: ${marked}`);
if (!badge) fails.push("offline badge not shown while offline");
if (!marked) fails.push("fetched layers not marked as needing a connection");

await context.setOffline(false);
if (errors.length) fails.push(...errors);
console.log(fails.length ? "\nFAILED:\n  " + fails.join("\n  ")
                         : "\nall offline checks passed");
await browser.close();
process.exit(fails.length ? 1 : 0);
