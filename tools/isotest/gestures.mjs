// Zoom anchoring and two-finger twist in the 3D viewer.
//
// Both are sign-and-algebra bugs waiting to happen, and both are the
// kind of thing that looks fine in a still screenshot and wrong the
// moment you touch it. So they are asserted arithmetically here rather
// than eyeballed.
//
// Zoom: the scene is projected around (W/2 + panX, Hh*0.60 + panY).
// Scaling alone anchors zoom to the island's ORIGIN, so a panned island
// walks out of frame as you zoom in. Holding the projection's base point
// still works out to scaling the pan by the same factor — which is what
// this checks, including when the zoom clamp means the factor actually
// applied is smaller than the one requested.
//
// Twist: the island must follow the fingers, matching the one-finger
// touch convention, and must not spin most of a turn when the angle
// crosses the ±pi seam.
//
// Usage: serve the REPO ROOT on :8123, then `node gestures.mjs`.
import { chromium } from "playwright";

const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
const URL = "http://127.0.0.1:8123/tools/isotest/harness.html";
const fails = [];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await chromium.launch({ executablePath: EXEC });
const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
page.on("pageerror", e => fails.push("page error: " + String(e)));
await page.goto(URL);
await page.evaluate(() => window.openTest({ name: "Gesture Park", acres: 400 }));
await page.waitForSelector("#isoPanel canvas", { state: "visible", timeout: 15000 });
await page.waitForTimeout(700);
await page.evaluate(() => { window.__isoS.spin = false; });

// --- 1. Zoom keeps the viewer's middle fixed --------------------------
const zoomIn = await page.evaluate(() => {
  const S = window.__isoS;
  S.zoom = 1; S.panX = 100; S.panY = 40;
  const c = document.querySelector("#isoPanel canvas");
  c.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
  return { zoom: S.zoom, panX: S.panX, panY: S.panY };
});
if (!near(zoomIn.zoom, 1.1, 1e-6))
  fails.push(`wheel in should scale zoom to 1.1, got ${zoomIn.zoom}`);
if (!near(zoomIn.panX, 110, 0.01) || !near(zoomIn.panY, 44, 0.01))
  fails.push(`pan should scale with zoom (110, 44), got (${zoomIn.panX}, ${zoomIn.panY})`);

// Zooming out must undo it, or the anchor drifts over a scroll gesture.
const roundTrip = await page.evaluate(() => {
  const S = window.__isoS;
  S.zoom = 1; S.panX = 100; S.panY = 40;
  const c = document.querySelector("#isoPanel canvas");
  for (let i = 0; i < 6; i++)
    c.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
  for (let i = 0; i < 6; i++)
    c.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
  return { zoom: S.zoom, panX: S.panX, panY: S.panY };
});
// 1.1 * 0.9 is 0.99, not 1 — the check is that pan tracks zoom exactly,
// whatever zoom ended up being, not that it returns to where it started.
if (!near(roundTrip.panX / 100, roundTrip.zoom, 1e-6))
  fails.push(`pan drifted from zoom over a scroll round trip: `
           + `panX/100 = ${roundTrip.panX / 100}, zoom = ${roundTrip.zoom}`);

// --- 2. The clamp must not desync pan from zoom -----------------------
const clamped = await page.evaluate(() => {
  const S = window.__isoS;
  S.zoom = 8.7; S.panX = 100; S.panY = 0;
  const c = document.querySelector("#isoPanel canvas");
  for (let i = 0; i < 5; i++)
    c.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
  return { zoom: S.zoom, panX: S.panX };
});
if (!near(clamped.zoom, 9, 1e-6))
  fails.push(`zoom should clamp at 9, got ${clamped.zoom}`);
// If pan scaled by the REQUESTED factor rather than the applied one, it
// would keep growing after the zoom stopped and the island would crawl.
if (!near(clamped.panX, 100 * (9 / 8.7), 0.01))
  fails.push(`pan must scale by the factor actually applied, expected `
           + `${(100 * (9 / 8.7)).toFixed(2)}, got ${clamped.panX.toFixed(2)}`);

// --- 3. Two-finger twist rotates ------------------------------------
const twist = await page.evaluate(() => {
  const c = document.querySelector("#isoPanel canvas");
  const send = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch" }));
  const before = window.__isoGetTarget();
  // Two fingers level, then rotated 30 degrees clockwise about their
  // midpoint. Screen y points down, so this is a rising atan2 angle.
  send("pointerdown", 1, 400, 400);
  send("pointerdown", 2, 500, 400);
  const rad = 30 * Math.PI / 180;
  const cx = 450, cy = 400, r = 50;
  send("pointermove", 1, cx - r * Math.cos(rad), cy - r * Math.sin(rad));
  send("pointermove", 2, cx + r * Math.cos(rad), cy + r * Math.sin(rad));
  const after = window.__isoGetTarget();
  send("pointerup", 1, 0, 0); send("pointerup", 2, 0, 0);
  return { before, after, delta: after - before };
});
if (Math.abs(twist.delta) < 0.05)
  fails.push(`a 30-degree twist barely moved the rotation: ${twist.delta}`);
// Clockwise fingers, clockwise island: same sign convention as a
// one-finger touch drag, where the island follows the hand.
if (twist.delta > 0)
  fails.push(`twist turns the island against the fingers (delta ${twist.delta.toFixed(3)}); `
           + `it should follow them, as a one-finger drag does`);
if (!near(Math.abs(twist.delta), 30 * Math.PI / 180, 0.02))
  fails.push(`a 30-degree twist should turn the island 30 degrees, `
           + `got ${(Math.abs(twist.delta) * 180 / Math.PI).toFixed(1)}`);

// --- 4. The +-pi seam must not fling it ------------------------------
const seam = await page.evaluate(() => {
  const c = document.querySelector("#isoPanel canvas");
  const send = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, {
    pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch" }));
  // Straddle the seam: the pair starts just below +pi and crosses it.
  send("pointerdown", 1, 500, 400);
  send("pointerdown", 2, 400, 401);          // angle just under +pi
  const before = window.__isoGetTarget();
  send("pointermove", 2, 400, 399);          // now just over -pi
  const after = window.__isoGetTarget();
  send("pointerup", 1, 0, 0); send("pointerup", 2, 0, 0);
  return { delta: after - before };
});
if (Math.abs(seam.delta) > 0.2)
  fails.push(`crossing the +-pi seam flung the island by `
           + `${(seam.delta * 180 / Math.PI).toFixed(0)} degrees`);

console.log(JSON.stringify({ zoomIn, roundTrip, clamped,
  twistDegrees: +(twist.delta * 180 / Math.PI).toFixed(2),
  seamDegrees: +(seam.delta * 180 / Math.PI).toFixed(2) }, null, 1));
await browser.close();
if (fails.length) { console.error("FAIL:\n- " + fails.join("\n- ")); process.exit(1); }
console.log("OK — zoom anchors to the viewer's middle; twist follows the fingers");
