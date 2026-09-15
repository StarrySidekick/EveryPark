// The 3D viewer's lore ribbon used to say nothing about the basis for a
// green pin except in the "cited" case, so the RULES page of a park
// resting on a PAD-US rating or a pure inference read exactly like one
// that had been checked by hand. The 2D popup already draws that
// distinction (basisHtml in app.js); this checks the viewer now states
// the same three tiers, in the same voice.
//
// Usage: serve the REPO ROOT on :8123, then `node evidence.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(URL);

// Advances the ribbon until it lands on the named page, or gives up
// after a generous bound — two clicks per page, the same rhythm
// shotui.mjs uses, because the first click of a pair only finishes
// typing the current line rather than turning it.
async function textOf(head, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const title = await page.evaluate(() => document.querySelector(".iso-lore-title").textContent);
    if (title === head) {
      // Landing on the right page is not the same as it being finished
      // typing — click through to the end of the line, the same "click
      // when impatient" gesture a reader uses, then read once settled.
      let last = "", body = "";
      for (let j = 0; j < 12; j++) {
        await page.click(".iso-lore");
        await page.waitForTimeout(200);
        body = await page.evaluate(() => document.querySelector(".iso-lore-body").textContent);
        if (body === last) return body;
        last = body;
      }
      return body;
    }
    await page.click(".iso-lore");
    await page.waitForTimeout(120);
    await page.click(".iso-lore");
    await page.waitForTimeout(350);
  }
  return null;
}

async function rulesFor(place) {
  await page.evaluate(over => {
    const old = document.getElementById("isoOverlay");
    if (old) old.remove();
    window.openTest(over);
  }, place);
  await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
  await page.waitForTimeout(500);
  await page.click("#isoLoreBtn");
  await page.waitForTimeout(300);
  return textOf("RULES");
}

const base = { name: "Test Park", status: "park", attrs: {} };

const cited = await rulesFor({ ...base, evidence: "cited",
  attrs: { researched: true, checked: "2026-08-02", sources: ["ct.gov"] } });
if (!cited || !/Access confirmed 2026-08-02/.test(cited))
  fails.push(`cited tier: expected "Access confirmed 2026-08-02 …", got ${JSON.stringify(cited)}`);

const official = await rulesFor({ ...base, evidence: "official", attrs: {} });
if (!official || !/Rated open to the public in USGS PAD-US/.test(official))
  fails.push(`official tier: expected the PAD-US sentence, got ${JSON.stringify(official)}`);
if (official && /confirmed|Presumed/.test(official))
  fails.push(`official tier bled into another tier's wording: ${JSON.stringify(official)}`);

const inferred = await rulesFor({ ...base, evidence: "inferred",
  attrs: { trails: true } });
if (!inferred || !/Presumed public — trails mapped here/.test(inferred))
  fails.push(`inferred tier: expected "Presumed public — trails mapped here …", got ${JSON.stringify(inferred)}`);

// A place that never passed the park test at all must keep the older,
// plainer sentence — this is the one case that already worked, and nothing
// above should have started firing for it too.
const unverified = await rulesFor({ ...base, status: "unverified", evidence: "inferred", attrs: {} });
if (!unverified || !/We have not confirmed public access here/.test(unverified))
  fails.push(`non-park: expected the unconfirmed sentence, got ${JSON.stringify(unverified)}`);
if (unverified && /Presumed public/.test(unverified))
  fails.push(`non-park wrongly got the "Presumed public" park-tier sentence`);

await browser.close();

if (fails.length) {
  console.log(JSON.stringify({ cited, official, inferred, unverified }, null, 1));
  console.error("FAIL:\n" + fails.map(f => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("OK — the viewer's RULES page states all three evidence tiers, and the non-park case is unchanged");
