// 真实浏览器帧时间探针（playwright + chromium）
// 目标：把“卡顿 / 前后抽搐”定位到具体子系统，而不是继续猜。
// 做法：加载构建产物 → 记录 rAF 帧间隔 → 分项 A/B（逐个关掉子系统）
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".xml": "application/xml",
  ".glb": "model/gltf-binary", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(req.url.split("?")[0]));
    const file = DIST + (p === "/" ? "index.html" : p.replace(/^\//, ""));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text().slice(0, 200)); });

await page.goto(`http://localhost:${port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.st, null, { timeout: 90000 });
await page.waitForTimeout(4000);

// 环境自检
const env = await page.evaluate(() => ({
  use3d: !!window.app.use3d,
  scene: !!window.app.scene,
  camMode: window.app.scene?.status?.camMode,
  ground: window.app.scene?.status?.ground,
  vc: +window.app.st.vc.toFixed(1),
  simT: +window.app.simT.toFixed(1),
}));
console.log("=== 环境自检 ===");
console.log(JSON.stringify(env));
console.log(`控制台错误 ${errors.length} 条${errors.length ? "：" + errors.slice(0, 3).join(" | ") : ""}\n`);

// 记录 n 帧：帧间隔 + 每帧的世界推进量（用于判断世界是否平滑）
async function measure(n = 500) {
  return page.evaluate((n) => new Promise((res) => {
    const dts = [], pos = [];
    let last = performance.now();
    function loop(now) {
      dts.push(now - last); last = now;
      const st = window.app.st;
      pos.push(st.lon * 111320 + st.lat * 110540);   // 粗糙的世界位移标量
      if (dts.length < n) requestAnimationFrame(loop); else res({ dts, pos });
    }
    requestAnimationFrame(loop);
  }), n);
}

function stats(dts) {
  const s = [...dts].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const med = q(0.5);
  return {
    med, p90: q(0.9), p99: q(0.99), max: s[s.length - 1],
    over25: dts.filter((d) => d > 25).length,
    over50: dts.filter((d) => d > 50).length,
    fps: 1000 / med,
  };
}

function spikes(dts, thresh = 30) {
  const idx = [];
  for (let i = 0; i < dts.length; i++) if (dts[i] > thresh) idx.push(i);
  if (idx.length < 3) return "无";
  const gaps = [];
  for (let i = 1; i < idx.length; i++) gaps.push(idx[i] - idx[i - 1]);
  gaps.sort((a, b) => a - b);
  const medGap = gaps[Math.floor(gaps.length / 2)];
  return `尖峰 ${idx.length} 次，间隔中位数 ${medGap} 帧（${medGap === 0 ? "连发" : (medGap / 60).toFixed(1) + "s"}）`;
}

const rows = [];
async function caseRun(label, setup) {
  if (setup) { await page.evaluate(setup); await page.waitForTimeout(1200); }
  const { dts } = await measure(500);
  const st = stats(dts);
  rows.push({ label, ...st, spike: spikes(dts) });
  console.log(
    `${label.padEnd(30)} 中位 ${st.med.toFixed(1).padStart(6)}ms  p90 ${st.p90.toFixed(1).padStart(6)}  ` +
    `p99 ${st.p99.toFixed(1).padStart(6)}  max ${st.max.toFixed(0).padStart(5)}  ` +
    `>25ms:${String(st.over25).padStart(4)}  >50ms:${String(st.over50).padStart(3)}  ${(st.fps).toFixed(0)}fps`
  );
  console.log(`${"".padEnd(30)} ${st.spike}`);
  return dts;
}

console.log("基准（全部面板可见，追机视角）");
const base = await caseRun("A 基准");

console.log("\n分项 A/B（逐个关掉子系统）");
await caseRun("B 关掉时间历程", () => { document.getElementById("trendPanel").classList.add("collapsed"); });
await caseRun("C 再关掉 PFD/ECAM", () => { document.getElementById("instPanel").classList.add("collapsed"); });
await caseRun("D 再关掉事件日志", () => { document.getElementById("logPanel").classList.add("collapsed"); });
await page.evaluate(() => ["trendPanel", "instPanel", "logPanel"].forEach((id) => document.getElementById(id).classList.remove("collapsed")));
await page.waitForTimeout(1200);

console.log("\n视角对比");
await caseRun("E 座舱视角（trend 已隐藏）", () => { window.app.scene.nextMode(); });
await caseRun("F 环绕视角", () => { window.app.scene.nextMode(); });
await page.evaluate(() => { while (window.app.scene.getMode() !== "chase") window.app.scene.nextMode(); });
await page.waitForTimeout(1000);

console.log("\n时间推移（看卡顿是否随飞行时间增长）");
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(20000);
  const { dts } = await measure(400);
  const st = stats(dts);
  console.log(`  飞行 ${(await page.evaluate(() => window.app.simT)).toFixed(0)}s: 中位 ${st.med.toFixed(1)}ms  p99 ${st.p99.toFixed(1)}  max ${st.max.toFixed(0)}  >50ms:${st.over50}`);
}

// 世界推进是否平滑（前后抽搐的直接证据）
const { dts, pos } = await measure(500);
const vel = [];
for (let i = 1; i < pos.length; i++) vel.push((pos[i] - pos[i - 1]) / (dts[i - 1] / 1000));
const neg = vel.filter((v) => v < -1e-9).length;
const mean = vel.reduce((a, b) => a + b, 0) / vel.length;
const sd = Math.sqrt(vel.reduce((a, b) => a + (b - mean) ** 2, 0) / vel.length);
console.log(`\n=== 世界推进（粗糙标量，仅看符号与离散度）===`);
console.log(`  平均 ${mean.toFixed(1)}  标准差 ${sd.toFixed(2)}  负向帧数 ${neg}`);
console.log(`  （负向 = 世界倒退，会表现为飞机向后跳；这里为 ${neg === 0 ? "0，世界单调前进" : neg + " 帧"}）`);

console.log("\n=== 结论表 ===");
const b = rows[0];
for (const r of rows) {
  const d = ((r.med - b.med) / b.med) * 100;
  console.log(`  ${r.label.padEnd(30)} 中位 ${r.med.toFixed(1)}ms  ${d >= 0 ? "+" : ""}${d.toFixed(0)}% vs 基准`);
}

await browser.close();
server.close();
