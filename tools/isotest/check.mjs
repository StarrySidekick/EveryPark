// Offline visual regression check for the 3D terrain viewer.
// See VISUALS.md for what "correct" looks like and why each check exists.
// Usage: serve the REPO ROOT on :8123, then `node check.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));

await page.goto(URL);
await page.evaluate(() => window.openTest());
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(1000);

const treePix = () => page.evaluate(() => {
  const c = document.querySelector("#isoPanel canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (d[i + 1] > d[i] + 18 && d[i + 1] > d[i + 2] + 18 && d[i + 1] < 150) n++;
  return n;
});
const brownPix = () => page.evaluate(() => {
  const c = document.querySelector("#isoPanel canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (d[i] > d[i + 2] + 25 && d[i] > 90 && d[i] < 190 &&
        d[i + 1] > d[i + 2] + 10 && d[i + 1] < d[i]) n++;
  return n;
});

// 1. Tree field must not change between spinning (motion LOD) and rest.
const spinTrees = await treePix();
await page.screenshot({ path: "/tmp/iso-check-blocky-spin.png" });
await page.click(".iso-spin-btn");
await page.waitForTimeout(900);
const restTrees = await treePix();
await page.screenshot({ path: "/tmp/iso-check-blocky-rest.png" });
const ratio = Math.min(spinTrees, restTrees) / Math.max(spinTrees, restTrees);
if (ratio < 0.90)
  fails.push(`tree field differs spin vs rest: ${spinTrees} vs ${restTrees}`);

// 2. Smooth mode mid-spin: continuous mesh (no sky holes in the island
//    interior) and a brown rim.
await page.evaluate(() => {
  [...document.querySelectorAll(".iso-tool")]
    .find(b => b.textContent === "Smooth").click();
});
await page.click(".iso-spin-btn");
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/iso-check-smooth-spin.png" });
const holes = await page.evaluate(() => {
  const c = document.querySelector("#isoPanel canvas");
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;
  const sky = ctx.getImageData(w >> 1, 4, 1, 1).data;
  const rg = ctx.getImageData(w * .35 | 0, h * .40 | 0, w * .3 | 0, h * .25 | 0);
  let n = 0;
  for (let i = 0; i < rg.data.length; i += 4)
    if (Math.abs(rg.data[i] - sky[0]) < 6 &&
        Math.abs(rg.data[i + 1] - sky[1]) < 6 &&
        Math.abs(rg.data[i + 2] - sky[2]) < 6) n++;
  return n;
});
if (holes > 40) fails.push(`smooth mid-spin has ${holes} sky-holes in the island`);
const rim = await brownPix();
if (rim < 5000) fails.push(`brown rim nearly absent mid-spin: ${rim} px`);

// 3. No JS errors anywhere above.
const jsErrors = errors.filter(e => !/Failed to load resource/.test(e));
if (jsErrors.length) fails.push("page errors: " + jsErrors.join(" | "));

await browser.close();
console.log(JSON.stringify({ spinTrees, restTrees, treeRatio: +ratio.toFixed(3),
                             smoothHoles: holes, brownRim: rim }, null, 1));
if (fails.length) { console.error("FAIL:\n- " + fails.join("\n- ")); process.exit(1); }
console.log("OK — compare /tmp/iso-check-*.png against VISUALS.md");
