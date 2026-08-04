import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errs = [];
for (const [v, z, tag] of [["a",13,"a-z13"],["b",13,"b-z13"],["c",13,"c-z13"],
                           ["a",11,"a-z11"],["b",11,"b-z11"]]) {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  page.on("pageerror", e => errs.push(tag + ": " + e));
  await page.goto(`http://127.0.0.1:8124/tools/mapmock/mock.html?v=${v}&z=${z}`);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `/tmp/mock-${tag}.png` });
  await page.close();
}
console.log("errors:", errs.length ? errs : "none");
await browser.close();
