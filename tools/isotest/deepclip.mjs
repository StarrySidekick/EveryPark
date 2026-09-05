// Does the DEEP trail clip keep the paths that are in this park and drop
// the ones that merely share its bounding box?
//
// This is the Sleeping Giant bug: an ArcGIS envelope query can only filter
// on a rectangle, and the Farmington Canal Trail passes through Sleeping
// Giant's rectangle without entering the park. It then appeared under
// WHAT'S HERE, and its dog, bike and horse rules were aggregated into the
// park's as if they belonged to it.
//
// A screenshot cannot show any of this — the failure is a name in a list
// that looks entirely plausible — so it is checked arithmetically.
//
// Usage: serve the REPO ROOT on :8123, then `node deepclip.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];
const ok = (name, cond, detail = "") =>
  cond ? console.log(`  ok   ${name}`) : fails.push(`${name} ${detail}`);

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage();
page.on("pageerror", e => fails.push("pageerror " + e));
await page.goto(URL);

// A C-shaped park: the notch on the right is inside the bounding box and
// outside the park. Every case below turns on that difference.
const PARK = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
const NOTCHED = [[[0, 0], [10, 0], [10, 4], [4, 4], [4, 6], [10, 6],
                  [10, 10], [0, 10], [0, 0]]];

const r = await page.evaluate(([park, notched]) => {
  const { pathTouchesRings } = window.EveryParkIso._clip;
  const step = 10 / 400;
  return {
    inside:      pathTouchesRings([[2, 2], [3, 3]], park, step),
    outside:     pathTouchesRings([[20, 20], [21, 21]], park, step),
    // Both endpoints outside the park, the line crossing it. A vertex-only
    // test says no; this is why the edges are sampled.
    crossing:    pathTouchesRings([[-5, 5], [15, 5]], park, step),
    // The notch: inside the envelope, outside the polygon. This is the
    // Farmington Canal case in miniature.
    inTheNotch:  pathTouchesRings([[5, 5], [9, 5]], notched, step),
    // A path that clips the corner of the park still counts.
    grazing:     pathTouchesRings([[-1, -1], [1, 1]], park, step),
    touchesHole: pathTouchesRings([[5, 2], [9, 2]], notched, step)
  };
}, [PARK, NOTCHED]);

ok("a path inside the park is kept", r.inside === true);
ok("a path outside the box is dropped", r.outside === false);
ok("a path crossing the park with no vertex inside is kept", r.crossing === true,
   "-> a vertex-only test would have dropped this");
ok("a path in the notch — inside the box, outside the park — is dropped",
   r.inTheNotch === false, "-> this is the Sleeping Giant bug");
ok("a path grazing the corner is kept", r.grazing === true);
ok("the notched park still keeps a path in its solid part", r.touchesHole === true);

// And the whole query path: no boundary means no clip, because a place we
// could find no outline for is exactly the one where the envelope is all
// there is. `clipped: false` says so out loud rather than silently keeping.
await page.evaluate(() => window.openTest());
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(1200);
const seam = await page.evaluate(() => window.__isoDeepClip || null);
ok("the clip reports what it did", seam === null || typeof seam.clipped === "boolean",
   JSON.stringify(seam));

await browser.close();
if (fails.length) { console.error("\nFAIL\n" + fails.join("\n")); process.exit(1); }
console.log("\nall deep-clip checks passed");
