import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await (await b.newContext({ viewport: { width: 1000, height: 720 } })).newPage();
await p.goto("http://127.0.0.1:8123/tools/isotest/harness.html");
await p.evaluate(() => window.openTest({ attrs: { relief: 90, elev: 150, cover: "wooded" } }));
await p.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 20000 });
await p.click(".iso-spin-btn");
await p.waitForTimeout(800);
await p.evaluate(() => {
  const sl = document.querySelector("#isoPanel input[type=range]");
  sl.value = String(+sl.min + 2);
  sl.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.waitForTimeout(1200);

// Two yaws 0.002 rad apart, straddling the quadrant boundary. The
// picture should be all but identical; any big difference is the
// renderer changing its mind, not the camera moving.
const diff = await p.evaluate(async () => {
  const cv = document.querySelector("#isoPanel canvas");
  const ctx = cv.getContext("2d");
  const grab = async (y, lod) => {
    window.__forceLod = lod;
    window.__isoSetYaw(y);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return ctx.getImageData(0, 0, cv.width, cv.height).data;
  };
  const mad = (a, c) => {
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 4) { sum += Math.abs(a[i] - c[i]); n++; }
    return +(sum / n).toFixed(2);
  };
  const e = 1e-3, Q = Math.PI / 2;
  const beforeL2 = await grab(Q - e, 2), afterL2 = await grab(Q + e, 2);
  const ctrlA   = await grab(0.9, 2),    ctrlB   = await grab(0.902, 2);
  return { acrossQuadrant: mad(beforeL2, afterL2), control_sameQuadrant: mad(ctrlA, ctrlB) };
});
console.log(JSON.stringify(diff));
await b.close();
