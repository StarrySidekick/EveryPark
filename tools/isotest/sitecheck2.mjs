import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errs = [];

// --- desktop, with geolocation granted so "Near me" runs end to end ---
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  geolocation: { latitude: 41.5786, longitude: -73.4954 },  // Sherman CT
  permissions: ["geolocation"]
});
const page = await ctx.newPage();
page.on("pageerror", e => errs.push("PAGEERROR " + e));
page.on("console", m => { if (m.type() === "error" && !/layers.png|favicon|ERR_/.test(m.text())) errs.push("CONSOLE " + m.text()); });
await page.goto("http://127.0.0.1:8125/index.html");
await page.waitForTimeout(4000);

const btn = await page.$eval("#nearBtn", e => {
  const s = getComputedStyle(e);
  return { bg: s.backgroundColor, font: s.fontFamily.split(",")[0], tt: s.textTransform };
});
console.log("nearBtn style:", JSON.stringify(btn));

await page.click("#nearBtn");
// Offline here, so OSRM will fail: this exercises the fallback path.
await page.waitForTimeout(11000);
const near = await page.$eval("#nearPanel", e => ({
  hidden: e.hidden,
  items: e.querySelectorAll(".near-item").length,
  note: e.querySelector(".near-note").textContent.slice(0, 80),
  first: (e.querySelector(".near-item") || {}).innerText
}));
console.log("near panel:", JSON.stringify(near));
await page.screenshot({ path: "/tmp/site-4-near.png" });

// --- mobile ---
const m = await browser.newContext({ viewport: { width: 390, height: 780 } });
const mp = await m.newPage();
mp.on("pageerror", e => errs.push("MOBILE PAGEERROR " + e));
await mp.goto("http://127.0.0.1:8125/index.html");
await mp.waitForTimeout(3500);
await mp.screenshot({ path: "/tmp/site-5-mobile.png" });
const overflow = await mp.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("mobile horizontal overflow px:", overflow);
await mp.click("#search");
await mp.type("#search", "beach");
await mp.waitForTimeout(900);
await mp.screenshot({ path: "/tmp/site-6-mobile-search.png" });

console.log("errors:", errs.length ? errs.slice(0, 6) : "none");
await browser.close();
