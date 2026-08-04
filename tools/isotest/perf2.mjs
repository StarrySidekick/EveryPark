import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await ctx.newPage();

const t0 = Date.now();
await page.goto("http://127.0.0.1:8125/index.html");
await page.waitForFunction(() => window.__map, null, { timeout: 20000 });
console.log("map object ready:", Date.now() - t0, "ms");
await page.waitForFunction(() => window.__perfReady === true || document.querySelectorAll(".ep-mark").length >= 0, null, {timeout: 20000});
await page.waitForTimeout(6000);

const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType("navigation")[0] || {};
  const res = performance.getEntriesByType("resource")
    .map(r => ({ name: r.name.split("/").pop().split("?")[0],
                 ms: +r.duration.toFixed(0), kb: +(r.transferSize / 1024).toFixed(0) }))
    .filter(r => r.ms > 60).sort((a, b) => b.ms - a.ms).slice(0, 8);
  return { domInteractive: +(n.domInteractive || 0).toFixed(0),
           loadEnd: +(n.loadEventEnd || 0).toFixed(0), slowest: res };
});
console.log("navigation:", JSON.stringify(nav, null, 1));

// Long tasks are what "slow" actually feels like.
const longTasks = await page.evaluate(() => new Promise(res => {
  const seen = [];
  try {
    new PerformanceObserver(l => { for (const e of l.getEntries()) seen.push(+e.duration.toFixed(0)); })
      .observe({ entryTypes: ["longtask"] });
  } catch (e) { return res("longtask unsupported"); }
  window.__map.setZoom(13);
  setTimeout(() => res(seen.sort((a, b) => b - a).slice(0, 8)), 4000);
}));
console.log("long tasks during zoom to 13 (ms):", JSON.stringify(longTasks));

async function frames(label, body) {
  const r = await page.evaluate(async (bodySrc) => {
    const fn = new Function("return (" + bodySrc + ")")();
    const f = []; let last = performance.now(), stop = false;
    const tick = t => { f.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    await fn();
    stop = true;
    const s = f.slice(3).sort((a, b) => a - b);
    const pct = q => +(s[Math.floor(s.length * q)] || 0).toFixed(1);
    return { median: pct(.5), p90: pct(.9), worst: +(s[s.length - 1] || 0).toFixed(1) };
  }, body.toString());
  console.log(label.padEnd(34), JSON.stringify(r));
}

// Dense area: New Haven
await page.evaluate(() => window.__map.setView([41.31, -72.92], 13));
await page.waitForTimeout(3000);
await frames("pan at z13 (New Haven)", async () => {
  for (let i = 0; i < 24; i++) {
    window.__map.panBy([30, 16], { animate: false });
    await new Promise(r => setTimeout(r, 55));
  }
});
await frames("zoom 13->15->13", async () => {
  for (const z of [14, 15, 14, 13]) {
    window.__map.setZoom(z);
    await new Promise(r => setTimeout(r, 700));
  }
});
const typeCost = await page.evaluate(async () => {
  const el = document.getElementById("search");
  const t = performance.now();
  el.value = "park"; el.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return +(performance.now() - t).toFixed(0);
});
console.log("search keystroke -> results (ms):", typeCost);
await browser.close();
