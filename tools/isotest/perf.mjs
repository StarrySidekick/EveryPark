import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

// Measure real frame cadence during a pan+zoom, with the turf overlay on
// and off, so we can tell whether the blend-mode compositing is the cost.
async function run(label, prep) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  await page.goto("http://127.0.0.1:8125/index.html");
  await page.waitForTimeout(4500);
  if (prep) await page.evaluate(prep);
  await page.waitForTimeout(400);

  const res = await page.evaluate(async () => {
    const frames = [];
    let last = performance.now(), stop = false;
    const tick = t => { frames.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const m = window.__map;
    // A pan sequence that forces continuous repaint.
    for (let i = 0; i < 26; i++) {
      m.panBy([26, 14], { animate: false });
      await new Promise(r => setTimeout(r, 55));
    }
    stop = true;
    await new Promise(r => setTimeout(r, 120));
    const f = frames.slice(3).sort((a, b) => a - b);
    const pct = q => f[Math.floor(f.length * q)] || 0;
    return { n: f.length, median: +pct(.5).toFixed(1), p90: +pct(.9).toFixed(1),
             worst: +(f[f.length - 1] || 0).toFixed(1) };
  });
  console.log(label.padEnd(30), JSON.stringify(res));
  await page.close();
  return res;
}

await run("baseline (turf on)");
await run("turf overlay hidden", () => {
  document.querySelector(".map-turf").style.display = "none";
});
await run("turf on, no blend mode", () => {
  document.querySelector(".map-turf").style.mixBlendMode = "normal";
});
await run("marks layer removed", () => {
  window.__map.eachLayer(l => { if (l._icon || l.options?.icon) window.__map.removeLayer(l); });
});
await browser.close();
