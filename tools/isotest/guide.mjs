// Start mode: a baked park guide, routed and walked.
//
// The guide for Sleeping Giant (data/guides/bc69dafa2a.json) is opened
// in the offline harness and driven through the panel the way a person
// would: pick the main entrance, pick the summit, watch the route. Then
// the parts no screenshot can show are checked arithmetically:
//
//   * the route is plausible against the real park (length and climb
//     in the range the park's own trail map gives for the summit)
//   * the route is actually painted, by counting route-gold pixels
//   * the walker advances along it, and the camera follows
//   * a manual pan hands the camera back
//   * turn directions are right on geometry whose answer is known: a
//     north-then-east path is a RIGHT turn, north-then-west a LEFT one.
//     A sign error here sends someone the wrong way at every junction
//     and reads perfectly well while doing it.
//
// Usage: serve the REPO ROOT on :8123, then `node guide.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); else console.log("  ok  " + msg); };

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1150, height: 840 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(URL);

// ---- Turn directions, on known geometry --------------------------------
const turns = await page.evaluate(() => {
  const { makeRouter, routeLegs } = EveryParkIso._guide;
  // Three nodes: south, middle, and one to the east or west of middle.
  const mk = dx => ({
    bbox: [-73.01, 40.99, -72.99, 41.01],
    nodes: [[-73, 41.000], [-73, 41.002], [-73 + dx, 41.002]],
    trails: [{ src: "deep", blaze: "Blue", colours: ["blue"] },
             { src: "deep", blaze: "Red", colours: ["red"] }],
    edges: [{ a: 0, b: 1, t: 0, m: 222, g: [[-73, 41.000], [-73, 41.002]] },
            { a: 1, b: 2, t: 1, m: 167, g: [[-73, 41.002], [-73 + dx, 41.002]] }]
  });
  const out = {};
  for (const [name, dx] of [["east", 0.002], ["west", -0.002]]) {
    const g = mk(dx), R = makeRouter(g);
    const steps = R.pathTo(R.run(0), 2);
    out[name] = routeLegs(g, R, steps).map(L => L.turn || null);
  }
  // And walked backwards: east-then-south is a right turn too.
  {
    const g = mk(0.002), R = makeRouter(g);
    out.back = routeLegs(g, R, R.pathTo(R.run(2), 0)).map(L => L.turn || null);
  }
  return out;
});
ok(/right/.test(turns.east[1] || ""), `north then east is a right turn (${turns.east[1]})`);
ok(/left/.test(turns.west[1] || ""), `north then west is a left turn (${turns.west[1]})`);
ok(/left/.test(turns.back[1] || ""), `west then south is a left turn (${turns.back[1]})`);

// ---- A place with no guide shows no start button ----------------------
// `hidden` alone did not do it: the corner buttons are display:grid, which
// beats the user agent's [hidden], so the button showed on every place.
await page.evaluate(() => window.openTest());
await page.waitForSelector("#isoPanel canvas", { state: "visible" });
await page.waitForTimeout(500);
const noGuide = await page.evaluate(() =>
  getComputedStyle(document.getElementById("isoGuideBtn")).display);
ok(noGuide === "none", `a place with no guide shows no start button (display: ${noGuide})`);
await page.evaluate(() => document.getElementById("isoOverlay").remove());

// ---- The real guide -------------------------------------------------
await page.evaluate(() => window.openTest({
  id: "bc69dafa2a", name: "Sleeping Giant State Park", type: "state",
  lat: 41.43314, lng: -72.88433, acres: 1576 }));
await page.waitForSelector("#isoGuideBtn:not([hidden])", { timeout: 20000 });
await page.waitForFunction(() => window.__isoS && window.__isoS.trailPieces
                                  && window.__isoS.trailPieces.length > 100, null, { timeout: 20000 });

const sub = await page.textContent(".iso-sub");
ok(/CT DEEP/.test(sub), `boundary comes from the guide (${sub.split(" · ")[0]})`);
const pieces = await page.evaluate(() => {
  const ps = window.__isoS.trailPieces;
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [u, y] = [hex(CONFIG.guide.unblazed), hex(CONFIG.guide.blazes.yellow)];
  return { n: ps.length, blazed: ps.filter(pc => pc[5] === 0).length,
           blue: ps.filter(pc => pc[4] === CONFIG.guide.blazes.blue).length,
           unblazedVsYellow: Math.hypot(u[0] - y[0], u[1] - y[1], u[2] - y[2]) };
});
ok(pieces.blazed > pieces.n * 0.5, `most trail pieces carry a blaze (${pieces.blazed} of ${pieces.n})`);
// The ordinary trail yellow sat 44 RGB units from the Yellow blaze; on
// screen that is the same colour, and an unblazed trail drawn in it says
// "look for yellow paint".
ok(pieces.unblazedVsYellow > 120, `unblazed trail is unlike the Yellow blaze (${pieces.unblazedVsYellow.toFixed(0)} apart)`);
ok(pieces.blue > 0, `the Quinnipiac's blue is drawn (${pieces.blue} pieces)`);

// Route-gold pixels before any route: the baseline the route must beat.
const gold = () => page.evaluate(() => {
  const c = document.querySelector("#isoOverlay canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4)
    if (Math.abs(d[i] - 255) < 12 && Math.abs(d[i + 1] - 210) < 16 && Math.abs(d[i + 2] - 74) < 22) n++;
  return n;
});
const goldBefore = await gold();

// ---- Through the panel ------------------------------------------------
await page.click("#isoGuideBtn");
await page.waitForSelector("#isoGuide:not([hidden]) .iso-guide-item");
const starts = await page.$$eval("#isoGuide .iso-guide-item b", bs => bs.map(b => b.textContent));
ok(starts.includes("Sleeping Giant State Park"), `DEEP's main entrance is offered (${starts.length} ways in)`);
await page.click("#isoGuide .iso-guide-item:has(b:text-is('Sleeping Giant State Park'))");
await page.waitForSelector("#isoGuide .iso-guide-title:has-text('From')");
const dests = await page.$$eval("#isoGuide .iso-guide-item b", bs => bs.map(b => b.textContent));
ok(dests.includes("Mount Carmel"), `the summit is a destination (${dests.slice(0, 6).join(", ")}...)`);
ok(dests.some(d => /loop|There and back/i.test(d)), "a loop is offered");

await page.click("#isoGuide .iso-guide-item:has(b:text-is('Mount Carmel'))");
await page.waitForFunction(() => window.__isoGuide.G.route, null, { timeout: 5000 });
const r = await page.evaluate(() => {
  const R = window.__isoGuide.G.route, S = window.__isoS;
  const g = window.__isoGuide.G.g;
  const first = R.steps[0], last = R.steps[R.steps.length - 1];
  const e0 = g.edges[first.k], e1 = g.edges[last.k];
  const startN = first.fwd ? e0.a : e0.b, endN = last.fwd ? e1.b : e1.a;
  return { m: R.st.m, up: R.st.up, down: R.st.down,
           net: g.nodes[endN][2] - g.nodes[startN][2], legs: R.legs.length,
           text: R.legs.map((L, i) => L.turn || "start").join(" | "),
           pts: S.route.pts.length, oneWay: S.hikeOneWay, follow: S.follow,
           lore: !document.querySelector(".iso-lore").hidden,
           loreHead: document.querySelector(".iso-lore-title").textContent };
});
// The main entrance sits at about 35 m and Mount Carmel at 225 m, so any
// honest way up climbs well over 150 m; the Tower Path is the long gentle one at
// about 1.6 mi, and the blazed ways up are shorter and steeper. The window
// is generous on purpose: what it catches is a route that wanders the
// whole park, or one that never leaves the lot.
ok(r.m > 1600 && r.m < 5000, `route length is plausible (${(r.m / 1609.34).toFixed(2)} mi)`);
ok(r.up > 150 && r.up < 320, `route climb is plausible (${Math.round(r.up * 3.281)} ft)`);
// The invariant behind every climb figure: up minus down along the route
// is the height of the end above the start. Off by more than rounding
// means an edge walked backwards had its up and down swapped wrong, or
// an edge's climb lost some of its rise.
ok(Math.abs((r.up - r.down) - r.net) < 1.5,
   `up minus down equals the height gained (${(r.up - r.down).toFixed(1)} vs ${r.net.toFixed(1)} m)`);
ok(r.legs >= 1 && r.legs < 15, `directions have a sane number of steps (${r.legs}: ${r.text})`);
ok(r.pts > 10 && r.oneWay && r.follow, "route is on the grid, walked one way, followed");
ok(r.lore && /Mount Carmel/.test(r.loreHead), `the dialogue box narrates it ("${r.loreHead}")`);

await page.waitForTimeout(900);
const goldAfter = await gold();
ok(goldAfter > goldBefore + 200, `the route is painted (${goldBefore} -> ${goldAfter} gold pixels)`);

const t0 = await page.evaluate(() => [window.__isoS.hikeT, window.__isoS.panX, window.__isoS.panY]);
await page.waitForTimeout(2500);
const t1 = await page.evaluate(() => [window.__isoS.hikeT, window.__isoS.panX, window.__isoS.panY]);
ok(t1[0] > t0[0], `the walker advances (${t0[0].toFixed(3)} -> ${t1[0].toFixed(3)})`);
ok(Math.hypot(t1[1] - t0[1], t1[2] - t0[2]) > 1 || Math.hypot(t0[1], t0[2]) > 1,
   `the camera follows (pan ${t0[1].toFixed(0)},${t0[2].toFixed(0)} -> ${t1[1].toFixed(0)},${t1[2].toFixed(0)})`);

// A right-drag is a pan; it must hand the camera back.
const box = await page.$eval("#isoOverlay canvas", c => {
  const b = c.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down({ button: "right" });
await page.mouse.move(box.x + 60, box.y + 30, { steps: 6 });
await page.mouse.up({ button: "right" });
const after = await page.evaluate(() => ({ follow: window.__isoS.follow,
  btn: document.querySelector("#isoFollow").classList.contains("active") }));
ok(!after.follow && !after.btn, "a manual pan ends the follow, and the button says so");

await page.click("#isoGuide button:text-is('End route')");
const ended = await page.evaluate(() => ({ route: window.__isoGuide.G.route,
  oneWay: window.__isoS.hikeOneWay, sroute: window.__isoS.route }));
ok(!ended.route && !ended.oneWay && !ended.sroute, "ending the route clears it");

await page.screenshot({ path: process.env.SHOT || "/tmp/guide-check.png" });
await browser.close();
if (fails.length) {
  console.log("\nFAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("\nguide: all checks pass");
