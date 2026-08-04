import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 1000, height: 720 } })).newPage();
const errs=[]; p.on("pageerror", e=>errs.push(String(e)));
await p.goto("http://127.0.0.1:8123/tools/isotest/harness.html");
await p.evaluate(() => window.openTest({ attrs: { relief: 90, elev: 150, cover: "wooded" } }));
await p.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 20000 });
await p.click(".iso-spin-btn");            // pause; we drive yaw by hand
await p.waitForTimeout(900);
// Force an EVEN grid. With stride 2 the two lattices only diverge when
// (GRID-1) is not a multiple of the stride, i.e. when GRID is even; at
// the default this park lands on GRID=151 and the bug cannot show.
await p.evaluate(() => {
  const sl = document.querySelector("#isoPanel input[type=range]");
  sl.value = String(+sl.min + 2);
  sl.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.waitForTimeout(1200);

// Yaw values straddling the quadrant boundary where dirX/dirY flip.
const measure = async (yaw, lod) => await p.evaluate(async ([y, l]) => {
  window.__forceLod = l;
  const S = window.__isoS, cv = document.querySelector("#isoPanel canvas");
  window.__isoSetYaw(y);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const ctx = cv.getContext("2d");
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let trees = 0, land = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], bb = d[i+2];
    if (g > r + 18 && g > bb + 18 && g < 150) trees++;
    if (d[i+3] > 40 && !(bb > r + 20 && bb > g + 10)) land++;   // not sky
  }
  return { trees, land };
}, [yaw, lod]);

const eps = 1e-3;
const rows = [];
for (const [label, yaw] of [["just before flip", Math.PI/2 - eps],
                            ["just after flip",  Math.PI/2 + eps]]) {
  for (const lod of [1, 2]) rows.push([label + " lod" + lod, await measure(yaw, lod)]);
}
for (const [l, v] of rows) console.log(l.padEnd(24), JSON.stringify(v));
const t = rows.map(r => r[1].trees), L = rows.map(r => r[1].land);
const spread = a => +(((Math.max(...a) - Math.min(...a)) / Math.max(...a)) * 100).toFixed(2);
console.log("tree spread across flip/lod:", spread(t) + "%");
console.log("land spread across flip/lod:", spread(L) + "%");
console.log("errors:", errs.length?errs.slice(0,3):"none");
await b.close();
