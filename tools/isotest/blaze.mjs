// Do the Blue-Blazed System's real paint colours reach the line that gets
// drawn, or does a park with six named trails still render one uniform tan
// ribbon for all of them?
//
// This is the other half of "blazed trail lines from DEEP" in
// START-HERE.md: the trail-rules fetch (DEEP_Trails_Set, TRAILMARK) already
// named the blaze in the WHAT'S HERE text, but the geometry actually drawn
// on the terrain came from a different DEEP layer (BlueBlazedHikingTrails)
// fetched with no attributes at all, so every segment drew in the same
// tan whether DEEP called it Blue, Red or unmarked.
//
// blazeColorOf() reads Map_Color, the field DEEP itself uses to draw the
// system on its own maps. Values are real, fetched live from the service
// 2026-09-11 (see the comment beside blazeColorOf in iso.js) -- this test
// asserts against that actual vocabulary, not an invented one.
//
// Usage: serve the REPO ROOT on :8123, then `node blaze.mjs`.
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

const r = await page.evaluate(() => {
  const { blazeColorOf, linesFrom, pathPieces } = window.EveryParkIso._blaze;

  // Real values seen on the live service (BlueBlazedHikingTrails,
  // 2026-09-11): plain CSS colour words, one hex for the flagship trail,
  // Gray standing in for an illegible white blaze, and the two junk
  // shapes that must not become invented colours -- an empty/absent
  // field, and the literal string "None".
  const feat = mc => ({ attributes: { Map_Color: mc },
                         geometry: { paths: [[[0, 0], [1, 0], [1, 1]]] } });
  const vocab = {
    blue: blazeColorOf(feat("Blue")),
    red: blazeColorOf(feat("Red")),
    grayForWhite: blazeColorOf(feat("Gray")),
    hex: blazeColorOf(feat("#00CCFF")),
    none: blazeColorOf(feat("None")),
    empty: blazeColorOf(feat("")),
    absent: blazeColorOf({ attributes: {}, geometry: {} }),
    noAttrs: blazeColorOf({ geometry: {} }),
    padded: blazeColorOf(feat("  Green  "))
  };

  // linesFrom: does a feature's colour land on every run its geometry
  // produces? Two features, one blazed and one not (an OSM path has no
  // Map_Color at all), inside an "everything survives" mask.
  //
  // GRID is module state, not a parameter of linesFrom -- 104 is its
  // value at load, before open() has ever run and resized it, which is
  // exactly the state this fresh harness page is in.
  const bbox = [0, 0, 3, 3];
  const GRID = 104;
  const inside = new Uint8Array(GRID * GRID).fill(1);
  const blazedFeat = { attributes: { Map_Color: "Red" },
                        geometry: { paths: [[[0.5, 0.5], [1.5, 1.5]]] } };
  const osmFeat = { attributes: {},
                     geometry: { paths: [[[0.5, 2.5], [1.5, 2.9]]] } };
  const lines = linesFrom([blazedFeat, osmFeat], bbox, inside, 0);
  const colors = lines.map(l => l.color || null);

  // pathPieces: does the colour survive being chopped into dashed
  // ribbon pieces, landing on pc[4]?
  const pieces = pathPieces(lines, [1.5, 1.1]);
  const redPieces = pieces.filter(pc => pc[4] === "Red").length;
  const plainPieces = pieces.filter(pc => pc[4] == null).length;

  return { vocab, colors, totalPieces: pieces.length, redPieces, plainPieces };
});

ok("a plain colour word passes through", r.vocab.blue === "Blue", JSON.stringify(r.vocab));
ok("a second colour word passes through", r.vocab.red === "Red");
ok("Gray (DEEP's stand-in for an illegible white blaze) passes through",
   r.vocab.grayForWhite === "Gray");
ok("a hex colour passes through", r.vocab.hex === "#00CCFF");
ok('the literal "None" is not a colour', r.vocab.none === null);
ok("an empty string is not a colour", r.vocab.empty === null);
ok("a feature with no Map_Color at all is not a colour", r.vocab.absent === null);
ok("a feature with no attributes object at all does not throw", r.vocab.noAttrs === null);
ok("surrounding whitespace is trimmed, not treated as a different colour",
   r.vocab.padded === "Green", JSON.stringify(r.vocab));

ok("linesFrom tags exactly one blazed and one unblazed run",
   r.colors.filter(c => c === "Red").length === 1 && r.colors.some(c => c === null),
   JSON.stringify(r.colors));
ok("pathPieces carries the colour onto real pieces of both kinds",
   r.redPieces > 0 && r.plainPieces > 0,
   `redPieces=${r.redPieces} plainPieces=${r.plainPieces} of ${r.totalPieces}`);

await browser.close();
if (fails.length) { console.error("\nFAIL\n" + fails.join("\n")); process.exit(1); }
console.log("\nall blaze-colour checks passed");
