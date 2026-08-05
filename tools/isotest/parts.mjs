// Separate pieces of one place, and the loading chrome.
//
// A place made of polygons that do not touch used to be drawn as one
// scene spanning the gaps between them, so each real piece was a pinhead
// surrounded by nothing. The viewer now shows one piece at a time with
// arrows between them. This checks the split is correct, the arrows step
// and wrap, and that slivers are merged rather than dropped — losing
// mapped land silently is the failure mode that would never be noticed.
//
// Usage: serve the REPO ROOT on :8123, then `node parts.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];

// Three blocks far apart, plus a hole inside the first and a sliver
// beside the third. Expect three navigable pieces: the hole belongs to
// its container, the sliver is merged into its nearest neighbour.
const box = (x, y, w, h) =>
  [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
const RINGS_IN = 5;
const RINGS = [
  box(-73.50, 41.40, 0.040, 0.040),      // piece A
  box(-73.49, 41.41, 0.010, 0.010),      // hole inside A
  box(-73.30, 41.40, 0.035, 0.035),      // piece B
  box(-73.10, 41.40, 0.030, 0.030),      // piece C
  box(-73.06, 41.40, 0.002, 0.002)       // sliver beside C
];

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1150, height: 840 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(URL);

const openWith = rings => page.evaluate(rings => {
  const old = document.getElementById("isoOverlay");
  if (old) old.remove();
  window.openTest({ name: "Split Forest", rings, boundaryLabel: "test",
                    lat: 41.42, lng: -73.30, acres: 900 });
}, rings);

const state = () => page.evaluate(() => ({
  arrows: !document.querySelector(".iso-part-prev").hidden,
  label: document.querySelector(".iso-part-lab").textContent,
  ringsHere: window.__isoPartRings
}));

// --- multi-piece place ---
await openWith(RINGS);
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(700);
const first = await state();
if (!first.arrows) fails.push("multi-piece place showed no arrows");
if (first.label !== "Piece 1 of 3")
  fails.push(`expected "Piece 1 of 3", got "${first.label}"`);

// Every ring must still be reachable across the pieces: 5 in, 5 out.
const totalRings = await page.evaluate(async () => {
  const lab = () => document.querySelector(".iso-part-lab").textContent;
  const n = +(lab().match(/of (\d+)/) || [0, 0])[1];
  let seen = 0;
  for (let i = 0; i < n; i++) {
    seen += window.__isoPartRings || 0;
    document.querySelector(".iso-part-next").click();
    await new Promise(r => setTimeout(r, 1400));
  }
  return { n, seen };
});
// Five rings went in. If the split loses one, some mapped land simply
// stops being drawn and nothing else in the app would ever say so.
if (totalRings.seen !== RINGS_IN)
  fails.push(`rings lost in the split: ${totalRings.seen} of ${RINGS_IN} survive`);

// --- stepping and wrapping ---
await page.waitForTimeout(400);
const afterWrap = await state();
if (!/Piece 1 of 3/.test(afterWrap.label))
  fails.push(`stepping forward 3 times should wrap to piece 1, got "${afterWrap.label}"`);

await page.click(".iso-part-prev");
await page.waitForTimeout(1500);
const back = await state();
if (!/Piece 3 of 3/.test(back.label))
  fails.push(`stepping back from piece 1 should wrap to 3, got "${back.label}"`);

// --- a single-polygon place must be untouched ---
await openWith([box(-73.50, 41.40, 0.04, 0.04)]);
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(600);
const single = await state();
if (single.arrows) fails.push("single-polygon place grew arrows it does not need");

// --- the loading chrome is positioned, not stacked ---
const loader = await page.evaluate(() => {
  const stageEl = document.querySelector(".iso-stage");
  const s = document.createElement("div");
  s.className = "iso-spin";
  stageEl.appendChild(s);
  s.getBoundingClientRect();                       // force layout before reading
  const c = window.getComputedStyle(s);
  const r = s.getBoundingClientRect();
  const stage = stageEl.getBoundingClientRect();
  const out = { position: c.getPropertyValue("position"),
                marginTop: c.getPropertyValue("margin-top"),
                centredX: Math.abs((r.left + r.width / 2) - (stage.left + stage.width / 2)) < 3,
                centredY: Math.abs((r.top + r.height / 2) - (stage.top + stage.height / 2)) < 3 };
  s.remove();
  return out;
});
if (loader.position !== "absolute")
  fails.push(`loader should be absolutely placed, is ${loader.position}`);
if (!loader.centredX || !loader.centredY)
  fails.push("loader is not centred on the stage");

console.log(JSON.stringify({ first, totalRings, afterWrap, back, single, loader }, null, 1));
await browser.close();
if (fails.length) { console.error("FAIL:\n- " + fails.join("\n- ")); process.exit(1); }
console.log("OK — pieces split, step and wrap; single polygons untouched");
