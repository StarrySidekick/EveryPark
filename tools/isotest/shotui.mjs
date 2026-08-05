// Screenshots of the viewer chrome: the lore ribbon mid-type, the ribbon
// finished, and the bottom-left terrain menu open. Offline, so the lore
// shown here is the composed-from-record fallback — which is the case
// worth looking at, because it is what most of the 7,727 places get.
// Usage: serve the REPO ROOT on :8123, then `node shotui.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));

await page.goto(URL);
await page.evaluate(() => window.openTest({
  name: "Sherwood Island State Park", town: "Westport", type: "state",
  subtype: "State Park", agency: "CT DEEP", acres: 238, feeState: "free",
  status: "park",
  attrs: { relief: 24, elev: 6, cover: "mostly open", water: true,
           waterType: "beach", trails: true, researched: true,
           checked: "2026-08-02", sources: ["ct.gov"] }
}));
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });

// The ribbon is hidden until asked for now, so the run starts by asking.
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/ui-0-closed.png" });
await page.click("#isoLoreBtn");
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/ui-1-typing.png" });

// Finish the line, then walk the pages.
for (let i = 0; i < 4; i++) {
  await page.click(".iso-lore");
  await page.waitForTimeout(120);
  await page.click(".iso-lore");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/ui-page-${i + 2}.png` });
}

// Terrain menu open, over the ribbon-free lower half.
await page.click("#isoTerrainBtn");
await page.waitForTimeout(350);
await page.screenshot({ path: "/tmp/ui-menu.png" });

const state = await page.evaluate(() => ({
  loreVisible: !document.querySelector(".iso-lore").hidden,
  head: document.querySelector(".iso-lore-title").textContent,
  body: document.querySelector(".iso-lore-body").textContent,
  menuOpen: !document.querySelector("#isoMenu").hidden,
  menuTools: [...document.querySelectorAll("#isoMenu .iso-tool")].map(b => b.textContent),
  footTools: [...document.querySelectorAll(".iso-tools .iso-tool")].map(b => b.textContent),
  corners: [...document.querySelectorAll(".iso-corner button")].map(b => b.id || b.className)
}));
console.log(JSON.stringify(state, null, 1));
if (errors.length) { console.error("PAGE ERRORS:\n" + errors.join("\n")); }
await browser.close();
if (errors.length) process.exit(1);
