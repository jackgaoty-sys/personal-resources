// 定向验证：卡顿的主因是不是 backdrop-filter（毛玻璃）？
// 布局完全不动，只把 backdrop-filter 置空再测 —— 排除“面板内容多少”的干扰。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
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

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.st, null, { timeout: 90000 });
await page.waitForTimeout(3000);

async function measure(n = 240) {
  return page.evaluate((n) => new Promise((res) => {
    const dts = [], stamps = [];
    let last = performance.now();
    function loop(now) {
      dts.push(now - last); stamps.push(now); last = now;
      if (dts.length < n) requestAnimationFrame(loop); else res({ dts, stamps });
    }
    requestAnimationFrame(loop);
  }), n);
}
const st = (d) => {
  const s = [...d].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { med: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1] };
};
const line = (l, s) => console.log(`  ${l.padEnd(26)} 中位 ${s.med.toFixed(1).padStart(6)}  p90 ${s.p90.toFixed(1).padStart(7)}  p99 ${s.p99.toFixed(1).padStart(7)}  max ${s.max.toFixed(0).padStart(5)}  ${(1000 / s.med).toFixed(0)}fps`);

// 先确认面板确实是可见的（样本有效）
const vis = await page.evaluate(() => ["trendPanel", "instPanel", "logPanel"].map((id) => {
  const el = document.getElementById(id); const r = el.getBoundingClientRect();
  return `${id}=${Math.round(r.width)}x${Math.round(r.height)}`;
}));
console.log("面板尺寸: " + vis.join("  "));
const hasBf = await page.evaluate(() => getComputedStyle(document.getElementById("trendPanel")).backdropFilter);
console.log(`当前 backdropFilter = ${hasBf}\n`);

console.log("【对照 1】布局完全不动，只切换毛玻璃");
line("① 原始（有毛玻璃）", st((await measure()).dts));
await page.addStyleTag({ content: `*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
  .panel{background:#0b0f14ee!important}` });
await page.waitForTimeout(800);
line("② 仅去掉 backdrop-filter", st((await measure()).dts));
const bf2 = await page.evaluate(() => getComputedStyle(document.getElementById("trendPanel")).backdropFilter);
console.log(`  （确认注入生效：backdropFilter = ${bf2}）\n`);

console.log("【对照 2】在②基础上继续关面板，看是否还有额外收益");
await page.evaluate(() => document.getElementById("trendPanel").classList.add("collapsed"));
await page.waitForTimeout(600);
line("③ ②+关时间历程", st((await measure()).dts));
await page.evaluate(() => document.getElementById("instPanel").classList.add("collapsed"));
await page.waitForTimeout(600);
line("④ ③+关 PFD/ECAM", st((await measure()).dts));
await page.evaluate(() => document.getElementById("logPanel").classList.add("collapsed"));
await page.waitForTimeout(600);
line("⑤ ④+关事件日志", st((await measure()).dts));

// 周期性停顿：把慢帧的时刻与间隔列出来
await page.evaluate(() => ["trendPanel", "instPanel", "logPanel"].forEach((id) => document.getElementById(id).classList.remove("collapsed")));
await page.waitForTimeout(800);
console.log("\n【停顿形态】③/⑤ 情况下慢帧的时间间隔");
for (const [label, setup] of [["全开", null], ["全关", () => ["trendPanel", "instPanel", "logPanel"].forEach((id) => document.getElementById(id).classList.add("collapsed"))]]) {
  if (setup) { await page.evaluate(setup); await page.waitForTimeout(800); }
  const { dts } = await measure(400);
  const slow = [];
  for (let i = 0; i < dts.length; i++) if (dts[i] > 60) slow.push(i);
  const gaps = [];
  for (let i = 1; i < slow.length; i++) gaps.push(slow[i] - slow[i - 1]);
  gaps.sort((a, b) => a - b);
  const g = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const total = dts.reduce((a, b) => a + b, 0);
  console.log(`  ${label.padEnd(6)} 慢帧(>60ms) ${String(slow.length).padStart(3)}/400  占比 ${(100 * dts.filter(d => d > 60).length / dts.length).toFixed(0)}%  间隔中位 ${g ?? "—"} 帧  期间总时长 ${(total / 1000).toFixed(1)}s`);
}

await browser.close();
server.close();
