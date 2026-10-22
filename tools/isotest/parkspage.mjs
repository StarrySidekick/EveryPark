// The parks page is the front page, and the map shows vetted parks only.
//
// Timothy, 2026-10-22: "add a page that is what's on by default that just
// lists all our current state parks we've begun to vet. the map view is no
// longer default and should also not by default have anything unvetted
// present on it." Each part of that is asserted against what the app
// reports it is doing, not against what the buttons look like:
//
//   * the list is what loads, with one card per guide in the index
//   * the cards carry the record's own hours and fee once it arrives
//   * on the map, visible() admits only vetted places, and the tile
//     outlines ask the same question, by name, apostrophes and all
//   * "Show everything" really does bring the rest back, and back again
//   * #map opens the map directly
//   * "Explore in 3D" opens the viewer with the start panel showing
//
// Usage: python3 tools/isotest/serve.py 8125 &  then  node tools/isotest/parkspage.mjs
import { chromium } from "playwright";
import { readFileSync } from "fs";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const SITE = process.env.SITE || "http://127.0.0.1:8125/index.html";
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else console.log("  ok  " + msg); };
const index = JSON.parse(readFileSync(new URL("../../data/guides/index.json", import.meta.url)));

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(SITE);

// ---- The front page ---------------------------------------------------
await page.waitForFunction(() => window.__epVetted && window.__epVetted().cards > 0, null, { timeout: 30000 });
const front = await page.evaluate(() => ({
  parks: document.body.classList.contains("view-parks"),
  shown: !document.getElementById("parksView").hidden,
  search: getComputedStyle(document.querySelector(".search-wrap")).display,
  hash: location.hash, v: window.__epVetted() }));
ok(front.parks && front.shown && front.hash === "", "the parks list is what loads, with no #map");
ok(front.v.cards === index.length, `one card per guide (${front.v.cards} of ${index.length})`);
ok(front.search === "none", "map-only controls are hidden on the list");

// Hours and fee come from the place record, which loads after the page.
await page.waitForFunction(() => /Open daily/.test(document.getElementById("pvList").textContent),
                           null, { timeout: 60000 });
const sg = await page.evaluate(() => [...document.querySelectorAll(".pv-card")]
  .find(c => /Sleeping Giant/.test(c.textContent)).textContent);
ok(/Open daily, 8 a\.m\. to sunset/.test(sg), "a card shows the park's own hours");
ok(/\$15 on weekends/.test(sg), "a card shows the park's own fee");
const sgMi = index.find(s => /Sleeping Giant/.test(s.name)).deepMi;
ok(sg.includes(sgMi + " mi on CT DEEP"), `a card shows its DEEP trail miles (${sgMi})`);
const gil = await page.evaluate(() => [...document.querySelectorAll(".pv-card")]
  .find(c => /Gillette/.test(c.textContent)).textContent);
ok(/Free to enter and park/.test(gil), "a free park says free");

// ---- The map: vetted only ---------------------------------------------
await page.click("#viewMap");
await page.waitForTimeout(800);
const m = await page.evaluate(() => ({
  hidden: document.getElementById("parksView").hidden, hash: location.hash,
  visible: window.__epVisible(), total: window.__epVetted().ids.length,
  note: document.getElementById("vettedNote").hidden ? null
      : document.querySelector("#vettedNote .vn-text").textContent,
  chip: document.getElementById("vettedChip").classList.contains("active") }));
ok(m.hidden && m.hash === "#map", "Map shows the map and says #map");
ok(m.visible > 0 && m.visible <= m.total, `only vetted places are visible (${m.visible} of ${m.total} vetted)`);
ok(m.note && /10 vetted/.test(m.note) && m.chip, `the map says why it is sparse ("${m.note}")`);

// The outlines ask the same question by name. DEEP spells one of these
// without its apostrophe, which a naive normaliser treats as another park.
const shapes = await page.evaluate(() => ({
  sg: window.__epShapeOk("Sleeping Giant State Park"),
  dh: window.__epShapeOk("Devils Hopyard State Park"),
  dh2: window.__epShapeOk("Devil's Hopyard State Park"),
  wr: window.__epShapeOk("West Rock Ridge State Park"),
  town: window.__epShapeOk("Clatter Valley Park") }));
ok(shapes.sg && shapes.dh && shapes.dh2, "vetted outlines draw, whichever way DEEP spells them");
ok(!shapes.wr && !shapes.town, "unvetted outlines do not");

// ---- Everything, and back -----------------------------------------------
await page.click("#vettedShowAll");
await page.waitForTimeout(300);
const all = await page.evaluate(() => ({ visible: window.__epVisible(),
  note: document.getElementById("vettedNote").hidden, wr: window.__epShapeOk("West Rock Ridge State Park") }));
ok(all.visible > 1000 && all.note && all.wr, `"Show everything" brings the rest back (${all.visible} visible)`);
await page.click("#filtersBtn");
await page.click("#vettedChip");
await page.click("#filtersBtn");
const back = await page.evaluate(() => window.__epVisible());
ok(back === m.visible, `the Filters chip turns vetted-only back on (${back})`);

// ---- #map opens the map directly -----------------------------------------
await page.goto(SITE + "#map");
await page.waitForFunction(() => window.__epVetted && window.__epVetted().ids.length > 0, null, { timeout: 30000 });
const direct = await page.evaluate(() => ({ parks: document.body.classList.contains("view-parks"),
  hidden: document.getElementById("parksView").hidden }));
ok(!direct.parks && direct.hidden, "#map in the address opens the map");

// ---- Explore in 3D -----------------------------------------------------
await page.click("#viewParks");
await page.waitForFunction(() => window.__epVetted().cards > 0);
await page.evaluate(() => [...document.querySelectorAll(".pv-card")]
  .find(c => /Sleeping Giant/.test(c.textContent)).querySelector(".pv-primary").click());
await page.waitForSelector("#isoGuide:not([hidden])", { timeout: 30000 });
const start = await page.$eval("#isoGuide .iso-guide-title", e => e.textContent);
ok(/Where are you starting/.test(start), "Explore in 3D opens straight into start mode");

await page.screenshot({ path: process.env.SHOT || "/tmp/parkspage.png" });
await browser.close();
if (fails.length) { console.log("\nFAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("\nparks page: all checks pass");
