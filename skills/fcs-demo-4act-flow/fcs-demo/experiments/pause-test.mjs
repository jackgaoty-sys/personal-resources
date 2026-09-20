// 暂停功能实测：空格切换、物理是否真冻结、恢复时有没有“追赶爆发”。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const EXE = "/Users/tyg/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg",
  ".xml": "application/xml", ".glb": "model/gltf-binary" };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(req.url.split("?")[0]));
    const file = DIST + (p === "/" ? "index.html" : p.replace(/^\//, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch({ executablePath: EXE, headless: false,
  args: ["--use-angle=metal", "--window-size=1440,900"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e).slice(0, 160)));
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.st, null, { timeout: 90000 });
await page.waitForTimeout(2500);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const snap = () => page.evaluate(() => ({
  simT: window.app.simT, paused: window.app.paused,
  lat: window.app.st.lat, lon: window.app.st.lon, theta: window.app.st.theta,
  clock: document.getElementById("clock").textContent,
  btn: document.getElementById("pauseBtn").textContent,
  btnOn: document.getElementById("pauseBtn").classList.contains("on"),
}));

console.log("═══ 1. 空格暂停：物理是否真的冻结 ═══");
const a = await snap();
await page.keyboard.press("Space");
await page.waitForTimeout(300);
const b = await snap();
check("app.paused 已置位", b.paused === true, `paused=${b.paused}`);
check("按钮文案变为「继续」且高亮", b.btn === "继续" && b.btnOn, `btn=${b.btn} on=${b.btnOn}`);
check("时钟显示暂停标记", b.clock.includes("已暂停"), `clock="${b.clock}"`);

await page.waitForTimeout(2500);            // 暂停中静置 2.5s
const c = await snap();
check("暂停期间 simT 完全不动", c.simT === b.simT, `${b.simT.toFixed(3)} → ${c.simT.toFixed(3)}`);
check("暂停期间物理状态冻结", c.lat === b.lat && c.lon === b.lon && c.theta === b.theta);
check("暂停期间时钟标记仍在", c.clock.includes("已暂停"), `clock="${c.clock}"`);

console.log("\n═══ 2. 再按空格恢复：有没有「追赶爆发」═══");
await page.keyboard.press("Space");
const d0 = await snap();
check("恢复后 paused 归位", d0.paused === false);
check("恢复后按钮文案回到「暂停」", d0.btn === "暂停", `btn=${d0.btn}`);

await page.waitForTimeout(1000);
const d1 = await snap();
const adv = d1.simT - d0.simT;
check("恢复后 1s 内推进约 1s（无爆发）", adv > 0.6 && adv < 1.6, `1s 实际推进 ${adv.toFixed(2)}s`);

console.log("\n═══ 3. 倍速下暂停也要正常 ═══");
await page.evaluate(() => { window.app.rate = 4; });
const e0 = await snap();
await page.keyboard.press("Space");
await page.waitForTimeout(1500);
const e1 = await snap();
check("4x 倍速下暂停仍冻结 simT", e1.simT === e0.simT, `${e0.simT.toFixed(3)} → ${e1.simT.toFixed(3)}`);
await page.keyboard.press("Space");
await page.waitForTimeout(1000);
const e2 = await snap();
const adv4 = e2.simT - e1.simT;
check("4x 恢复后按 4 倍推进（无爆发）", adv4 > 2.4 && adv4 < 6.4, `1s 实际推进 ${adv4.toFixed(2)}s`);
await page.evaluate(() => { window.app.rate = 1; });

console.log("\n═══ 4. 按钮点击、R 重置、长按不连发 ═══");
await page.click("#pauseBtn");
const f = await snap();
check("点击按钮可暂停", f.paused === true);
await page.evaluate(() => window.app.reset());
const g = await snap();
check("reset 会解除暂停（不会停在冻结态）", g.paused === false, `paused=${g.paused}`);
check("reset 后按钮文案复位", g.btn === "暂停");

// 长按空格不应连续切换（e.repeat 已拦截）
await page.keyboard.down("Space");
await page.waitForTimeout(700);
await page.keyboard.up("Space");
const h = await snap();
check("长按空格只切换一次", h.paused === true, `paused=${h.paused}`);
await page.keyboard.press("Space");

console.log(`\n═══ 结果：${results.filter((r) => r.ok).length}/${results.length} 通过 ═══`);
if (errs.length) console.log("页面错误：" + errs.slice(0, 3).join(" | "));
for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}`);

await browser.close();
server.close();
process.exit(results.some((r) => !r.ok) ? 1 : 0);
