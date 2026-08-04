import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });

async function trial(label, prep) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage();
  await page.goto("http://127.0.0.1:8125/index.html");
  await page.waitForFunction(() => window.__map, null, { timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => window.__map.setView([41.31, -72.92], 13));
  await page.waitForTimeout(2500);
  if (prep) await page.evaluate(prep);
  await page.waitForTimeout(600);
  const r = await page.evaluate(async () => {
    const f = []; let last = performance.now(), stop = false;
    const tick = t => { f.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    for (let i = 0; i < 24; i++) {
      window.__map.panBy([30, 16], { animate: false });
      await new Promise(r2 => setTimeout(r2, 55));
    }
    stop = true;
    const s = f.slice(3).sort((a, b) => a - b);
    const pct = q => +(s[Math.floor(s.length * q)] || 0).toFixed(1);
    return { median: pct(.5), p90: pct(.9), worst: +(s[s.length - 1] || 0).toFixed(1) };
  });
  console.log(label.padEnd(32), JSON.stringify(r));
  await page.close();
}

await trial("z13 baseline");
await trial("z13, marks layer emptied", () => {
  // paintMarks repopulates on moveend, so neuter the function itself.
  const lg = Object.values(window.__map._layers).find(l => l._layers && l.clearLayers && !l._url);
  window.__map.off("moveend");
  if (lg) lg.clearLayers();
});
await trial("z13, turf hidden", () => { document.querySelector(".map-turf").style.display = "none"; });
await trial("z13, vector tiles removed", () => {
  for (const k in window.__map._layers) {
    const l = window.__map._layers[k];
    if (l.constructor && /Protomaps|Leaflet.*Layer/.test(l.constructor.name) && l._tiles) window.__map.removeLayer(l);
  }
});
await browser.close();
