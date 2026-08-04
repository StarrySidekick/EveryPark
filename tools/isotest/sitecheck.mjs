import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
const errs = [];
page.on("pageerror", e => errs.push("PAGEERROR " + e));
page.on("console", m => { if (m.type() === "error" && !/favicon|ERR_(NAME|INTERNET|TUNNEL|CONNECTION)/.test(m.text())) errs.push("CONSOLE " + m.text()); });

await page.goto("http://127.0.0.1:8125/index.html");
await page.waitForTimeout(4500);
await page.screenshot({ path: "/tmp/site-1-map.png" });

// Header order, left to right
const order = await page.$$eval("header > *", els =>
  els.map(e => (e.id || e.className || e.tagName).toString().trim()));
console.log("header order:", JSON.stringify(order));

const badgeSize = await page.$eval("#buildBadge", e => getComputedStyle(e).fontSize);
console.log("badge font-size:", badgeSize);

// Turf overlay actually present and blending
const turf = await page.$eval(".map-turf", e => {
  const s = getComputedStyle(e);
  return { display: s.display, blend: s.mixBlendMode, size: s.backgroundSize,
           img: s.backgroundImage.slice(0, 24) };
});
console.log("turf:", JSON.stringify(turf));

// Search: type and check the results list appears with clickable items
await page.click("#search");
await page.type("#search", "sherman");
await page.waitForTimeout(900);
const nres = await page.$$eval("#searchResults .sr-item", n => n.length);
const hidden = await page.$eval("#searchResults", e => e.hidden);
console.log("search results:", nres, "hidden:", hidden);
await page.screenshot({ path: "/tmp/site-2-search.png" });

// Clicking a result should fly and open a card
if (nres) {
  await page.click("#searchResults .sr-item");
  await page.waitForTimeout(2200);
  const popup = await page.$$eval(".leaflet-popup", n => n.length);
  console.log("popup after result click:", popup);
  await page.screenshot({ path: "/tmp/site-3-popup.png" });
}

console.log("errors:", errs.length ? errs.slice(0, 6) : "none");
await browser.close();
