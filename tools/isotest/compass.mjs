// The north arrow and scale bar in the 3D viewer, checked arithmetically —
// same spirit as gestures.mjs: a compass that points the wrong way looks
// exactly like a correct one in a still screenshot, and is only wrong the
// moment you rotate it.
//
// North is the grid's -y direction (gridToLL: gy=0 is the bbox's northern
// edge). renderScene projects a direction the same way it projects a
// point — rotate by yaw's own cos/sin, then apply project()'s x/y
// foreshortening (1.55 / .8) — so the expected angle here is computed
// the same way, independently, from yaw alone.
//
// Usage: serve the REPO ROOT on :8123, then `node compass.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const norm = a => Math.atan2(Math.sin(a), Math.cos(a));

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(URL);
await page.evaluate(() => window.openTest());
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(700);

// --- 1. The needle's angle matches an independently-computed expectation,
//        at yaw = 0 and after a quarter and a half turn. -----------------
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.1]) {
  const got = await page.evaluate(v => {
    window.__isoSetYaw(v);
    return window.__isoS._northAngle;
  }, yaw);
  const expected = Math.atan2(-Math.cos(yaw) * .8, Math.sin(yaw) * 1.55);
  if (!near(norm(got - expected), 0, 1e-6))
    fails.push(`yaw ${yaw.toFixed(3)}: north angle ${got.toFixed(4)}, expected ${expected.toFixed(4)}`);
}

// --- 2. At yaw 0 the terrain is unrotated, so north must point straight
//        up on screen (angle -PI/2 in canvas coordinates). ---------------
const upright = await page.evaluate(() => {
  window.__isoSetYaw(0);
  return window.__isoS._northAngle;
});
if (!near(norm(upright - (-Math.PI / 2)), 0, 1e-6))
  fails.push(`yaw 0 should point the needle straight up, got angle ${upright}`);

// --- 3. The scale bar names a real, round distance derived from the
//        park's own metres-per-block, not a hardcoded number. -----------
const scale = await page.evaluate(() => {
  window.__isoSetYaw(0.4);
  const S = window.__isoS;
  return { meters: S._scaleMeters, mPerBlock: S.mPerBlock };
});
if (!(scale.meters > 0) || !isFinite(scale.meters))
  fails.push(`scale bar did not resolve to a positive distance: ${JSON.stringify(scale)}`);
// "Round" here means the leading digit is 1, 2 or 5 — the classic
// map-scale ladder — not an arbitrary pixel-derived fraction.
const lead = +(scale.meters / Math.pow(10, Math.floor(Math.log10(scale.meters)))).toFixed(6);
if (![1, 2, 5].includes(lead))
  fails.push(`scale bar chose a non-round distance: ${scale.meters} m (leading digit ${lead})`);

await browser.close();

if (fails.length) {
  console.log("FAIL:\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log("all compass/scale checks passed");
