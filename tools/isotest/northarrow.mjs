// The 3D viewer's compass needle, checked against the REAL projection.
//
// The view rotates freely (drag, twist, the turntable) with nothing else
// on screen to say which way is north — a park with its road on the east
// side looked identical to one with the road on the west side once you had
// spun it. The needle is drawn from `northDir(yaw)`, a hand-derived
// formula (north is decreasing gy, rotated by the same cos/sin the terrain
// itself is projected with). A hand-derived formula is exactly the kind of
// thing that can quietly drift out of sync with `project()` after some
// later change to the projection — so this does not just re-read the
// formula, it asks `S._proj.project()` (the function the terrain is
// ACTUALLY drawn with) where north really lands on screen, and checks the
// two agree.
//
// Usage: serve the REPO ROOT on :8123, then `node northarrow.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];
const ok = (name, cond, detail = "") =>
  cond ? console.log(`  ok   ${name}`) : fails.push(`${name} ${detail}`);

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));

await page.goto(URL);
await page.evaluate(() => window.openTest());
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(1000);
await page.evaluate(() => { window.__isoS.spin = false; });

// For a set of yaw values, project a point due north of the grid's centre
// and the centre itself (same height, so only the horizontal offset shows
// up), and compare that real screen-space direction against northDir(yaw).
const YAWS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 2.1, -1.3];
const results = await page.evaluate(yaws => {
  const g = window.__isoGrid();
  return yaws.map(yaw => {
    window.__isoSetYaw(yaw);
    const S = window.__isoS;
    const { project } = S._proj;
    const [cx, cy] = project(g / 2, g / 2, 0);
    const [nx, ny] = project(g / 2, g / 2 - 5, 0);
    const dx = nx - cx, dy = ny - cy;
    const len = Math.hypot(dx, dy);
    const real = [dx / len, dy / len];
    const drawn = window.__isoNorthDir(yaw);
    return { yaw, real, drawn };
  });
}, YAWS);

for (const { yaw, real, drawn } of results) {
  // Both are unit vectors; the projection's anisotropic x/y scale (1.55
  // vs .8 in `project()`) means they are not expected to match exactly,
  // only to point the same way. A dot product near 1 is "same direction";
  // a wrong sign anywhere in the chain would send it toward -1 or 0.
  const dot = real[0] * drawn[0] + real[1] * drawn[1];
  ok(`yaw ${yaw.toFixed(2)}: compass agrees with the real projection`,
     dot > 0.9,
     `-> real ${real.map(v => v.toFixed(3))}, drawn ${drawn.map(v => v.toFixed(3))}, dot ${dot.toFixed(3)}`);
}

// And the sanity case a screenshot would actually catch: at yaw 0 the
// board is unrotated, so north must be straight up.
const zero = results.find(r => r.yaw === 0);
ok("at yaw 0, north points up the screen",
   Math.abs(zero.drawn[0]) < 1e-9 && zero.drawn[1] < 0,
   `-> got ${zero.drawn}`);

await browser.close();
if (fails.length) { console.error("\nFAIL\n" + fails.join("\n")); process.exit(1); }
console.log("\nall north-arrow checks passed");
