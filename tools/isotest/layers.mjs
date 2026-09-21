// The Layers panel: every switch must actually switch something.
// Usage: python3 tools/isotest/serve.py 8125 &  then  node tools/isotest/layers.mjs
//
// A chip that lights up while the map does not change is the failure
// this exists to catch, and it is invisible in a screenshot of the
// panel. So every toggle is asserted against window.__layers(), which
// reports what is ON THE MAP rather than what the panel believes, and
// the locally drawn layers are asserted against the pixels as well.
import { chromium } from "playwright";
import crypto from "node:crypto";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const SITE = process.env.SITE || "http://127.0.0.1:8125/index.html";
const fails = [];

const browser = await chromium.launch({ executablePath: EXEC });
const context = await browser.newContext({ viewport: { width: 1300, height: 880 } });
const page = await context.newPage();

// Leaflet and protomaps are served from vendor/ in the repo now, so
// there is nothing to intercept and no CDN to be broken by. Basemap
// rasters and live ArcGIS are still aborted: they are not what these
// checks are about, and waiting on them makes the timings meaningless.
await page.route(/^https?:/, route =>
  route.request().url().startsWith("http://127.0.0.1")
    ? route.continue() : route.abort());

const errors = [];
page.on("pageerror", e => errors.push("PAGEERROR " + e));
page.on("console", m => {
  if (m.type() === "error"
      && !/favicon|Failed to load resource|ERR_(NAME|INTERNET|TUNNEL|CONNECTION|FAILED)/.test(m.text()))
    errors.push("CONSOLE " + m.text());
});

const settle = (ms = 2200) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__layers());
const shot = async () => crypto.createHash("sha1")
  .update(await page.locator("#map").screenshot()).digest("hex");

await page.goto(SITE);
await settle(4000);
// Hartford at zoom 12: dense enough that every layer has something to
// draw inside one screen.
await page.evaluate(() => window.__map.setView([41.7637, -72.6851], 12));
await settle(3500);
await page.click("#layersBtn");
await settle(400);

console.log("start:", JSON.stringify(await state()));

// name -> does this layer draw locally? External rasters (relief, water,
// names) cannot change the pixels in an offline check, so only their map
// state is asserted.
const TOGGLES = [
  ["roads", true], ["shapes", true], ["pins", true], ["towns", true],
  ["texture", true], ["blueblaze", true], ["districts", false],
  ["relief", false], ["water", false], ["names", false],
];

for (const [name, local] of TOGGLES) {
  const before = (await state())[name];
  const pixBefore = local ? await shot() : null;
  await page.click(`#layersPanel .chip[data-layer="${name}"]`);
  await settle(name === "districts" ? 4000 : 2500);
  const after = (await state())[name];
  const pixAfter = local ? await shot() : null;

  if (before === after) {
    fails.push(`${name}: the map did not change state (${before} -> ${after})`);
  } else if (local && pixBefore === pixAfter) {
    fails.push(`${name}: state flipped to ${after} but the map looks identical`);
  } else {
    console.log(`${name}: ${before} -> ${after}` + (local ? ", pixels changed" : ""));
  }
}

// Ground is one-of, not on/off.
const baseBefore = (await state()).base;
await page.click('#layersPanel .chip[data-base="Street map"]');
await settle(2500);
const baseAfter = (await state()).base;
if (baseAfter !== "Street map")
  fails.push(`ground: clicking Street map left it on ${baseAfter}`);
else console.log(`ground: ${baseBefore} -> ${baseAfter}`);

// What was switched must survive a reload, or the panel is a toy.
const wanted = await state();
await page.reload();
await settle(5000);
const got = await state();
for (const k of Object.keys(wanted)) {
  if (wanted[k] !== got[k])
    fails.push(`not remembered: ${k} was ${wanted[k]}, came back ${got[k]}`);
}
console.log("after reload:", JSON.stringify(got));

// And the chips must agree with the map, or the panel lies about itself.
await page.click("#layersBtn");
await settle(400);
const chips = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll('#layersPanel .chip[data-layer]').forEach(c => {
    out[c.dataset.layer] = c.classList.contains("active");
  });
  return out;
});
for (const [k, v] of Object.entries(chips)) {
  if (got[k] !== null && got[k] !== undefined && got[k] !== v)
    fails.push(`chip disagrees with the map: ${k} chip=${v} map=${got[k]}`);
}

if (errors.length) fails.push(...errors);
console.log(fails.length ? "\nFAILED:\n  " + fails.join("\n  ")
                         : "\nall layer checks passed");
await browser.close();
process.exit(fails.length ? 1 : 0);
