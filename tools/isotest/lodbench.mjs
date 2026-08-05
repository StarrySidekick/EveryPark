// The motion-detail decision: does it stay at full detail when the
// device can afford it, and does it still coarsen when it cannot?
//
// Background. The viewer used to drop to a doubled grid step and 0.7
// resolution the instant the view moved, which reads as the blocks
// growing while you drag and snapping back when you let go. It now
// starts each motion burst at full detail, times that frame, and only
// coarsens if it blew the budget.
//
// The load-bearing assertion is the PIXEL DIFF: when the viewer has
// decided it can keep up, a moving frame and a settled frame at the same
// yaw must be byte-identical. That is the bug stated as a test — timings
// alone would not catch a regression that quietly re-coarsens.
//
// Absolute ms from this harness are not trustworthy (no GPU here), so
// nothing below asserts a frame time. It asserts the DECISION and its
// visual consequence, which are what the user actually sees.
//
// Usage: serve the REPO ROOT on :8123, then `node lodbench.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(URL);
await page.evaluate(() => window.openTest({ name: "Bench Park", acres: 900 }));
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(900);
await page.evaluate(() => { window.__isoS.spin = false; });

const setCell = cell => page.evaluate(cell => new Promise(res => {
  const s = document.querySelector(".iso-slider input");
  s.value = String(cell);
  s.dispatchEvent(new Event("input", { bubbles: true }));
  setTimeout(res, 800);                     // the rebuild is debounced 160 ms
}), cell);

// Render one frame at a fixed yaw in a given motion state and hash the
// canvas. Equal hashes mean the picture is literally the same.
const frameHash = moving => page.evaluate(moving => {
  const S = window.__isoS;
  S.moving = moving;
  // THREE frames when moving, and the count is load-bearing. The viewer
  // needs two consecutive over-budget full-detail frames before it
  // coarsens, so frames 1 and 2 are both probes rendered at full detail
  // by design; only frame 3 shows the decision. An earlier version of
  // this test shot once and passed vacuously — it was hashing a probe
  // and calling it the verdict.
  const shoot = () => { S._sig = null; window.__isoSetYaw(0.7); };
  shoot();
  if (moving) { shoot(); shoot(); }
  const c = document.querySelector("#isoPanel canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 17) {  // stride: a hash, not a checksum
    h ^= d[i]; h = Math.imul(h, 16777619);
  }
  return { hash: h >>> 0, lod: S.lod, coarse: !!S._lodCoarse };
}, moving);

const cellRange = await page.evaluate(() => {
  const s = document.querySelector(".iso-slider input");
  return { min: +s.min, max: +s.max };
});

const setBudget = ms => page.evaluate(ms => { window.__lodBudgetMs = ms; }, ms);

const rows = [];
for (const [cell, label] of [[cellRange.max, "coarsest grid"],
                             [cellRange.min, "finest grid"]]) {
  await setCell(cell);
  const grid = await page.evaluate(() => Math.round(Math.sqrt(window.__isoS.H.length)));

  // Branch 1: a device that keeps up. THE bug, stated as a test — the
  // moving frame must be byte-identical to the settled one.
  await setBudget(1e9);
  const settledFast = await frameHash(false);
  const movingFast = await frameHash(true);
  const sameFast = settledFast.hash === movingFast.hash;
  if (movingFast.coarse)
    fails.push(`${label}: coarsened even with an unlimited frame budget`);
  else if (!sameFast)
    fails.push(`${label}: kept full detail but the moving frame still differs from the settled one`);

  // Branch 2: a device that cannot. The safety net must still engage,
  // or a big forest on a slow phone becomes a slideshow.
  await setBudget(0);
  const movingSlow = await frameHash(true);
  const sameSlow = settledFast.hash === movingSlow.hash;
  if (!movingSlow.coarse)
    fails.push(`${label}: never coarsened even with a zero frame budget`);
  else if (sameSlow)
    fails.push(`${label}: reported coarsening but the frame did not change`);

  rows.push({ label, cellM: cell, grid, columns: grid * grid,
              fastPath: { lod: movingFast.lod, coarsened: movingFast.coarse,
                          identicalToSettled: sameFast },
              slowPath: { lod: movingSlow.lod, coarsened: movingSlow.coarse,
                          identicalToSettled: sameSlow } });
}
await page.evaluate(() => { window.__lodBudgetMs = null; });
await page.evaluate(() => { window.__isoS.moving = false; });
console.log(JSON.stringify({ rows }, null, 1));
await browser.close();
if (fails.length) { console.error("FAIL:\n- " + fails.join("\n- ")); process.exit(1); }
console.log("OK — motion detail matches the measured decision");
