// GPU 有头模式测量：SwiftShader 软件渲染的绝对数字不代表真实浏览器，
// 这里用完整 Chromium + 有头模式（走 Metal/ANGLE）重测关键对照。
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

const browser = await chromium.launch({
  executablePath: EXE,
  headless: false,                       // 有头才有真 GPU
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--window-size=1440,900"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.st, null, { timeout: 90000 });
await page.waitForTimeout(3000);

const gpu = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return "no webgl";
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown";
});
console.log(`WebGL 渲染器: ${gpu}`);
console.log(`地面瓦片: ${await page.evaluate(() => window.app.scene?.status?.ground)}\n`);

async function measure(n = 600) {
  return page.evaluate((n) => new Promise((res) => {
    const dts = []; let last = performance.now();
    function loop(now) { dts.push(now - last); last = now;
      if (dts.length < n) requestAnimationFrame(loop); else res(dts); }
    requestAnimationFrame(loop);
  }), n);
}
const st = (d) => {
  const s = [...d].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { med: q(0.5), p90: q(0.9), p99: q(0.99), max: s[s.length - 1], over: d.filter(x => x > 33).length };
};
const line = (l, s) => console.log(`  ${l.padEnd(28)} 中位 ${s.med.toFixed(2).padStart(6)}  p90 ${s.p90.toFixed(2).padStart(7)}  p99 ${s.p99.toFixed(2).padStart(7)}  max ${s.max.toFixed(1).padStart(7)}  >33ms:${String(s.over).padStart(3)}  ${(1000 / s.med).toFixed(0)}fps`);

console.log("【关键对照】");
line("A 全部可见（现状）", st(await measure()));
await page.addStyleTag({ content: `*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.panel{background:#0b0f14ee!important}` });
await page.waitForTimeout(700);
line("B 仅关毛玻璃", st(await measure()));
await page.evaluate(() => document.getElementById("trendPanel").classList.add("collapsed"));
await page.waitForTimeout(700);
line("C B+关时间历程", st(await measure()));
await page.evaluate(() => document.getElementById("trendPanel").classList.remove("collapsed"));
await page.waitForTimeout(700);
line("D 恢复时间历程（验证可复现）", st(await measure()));

console.log("\n【时间推移：卡顿是否随飞行时间增长】");
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(15000);
  const d = await measure(300);
  const s = st(d);
  const t = await page.evaluate(() => window.app.simT);
  console.log(`  飞行 ${t.toFixed(0).padStart(4)}s  中位 ${s.med.toFixed(2)}ms  p99 ${s.p99.toFixed(2)}  max ${s.max.toFixed(1)}  >33ms:${s.over}`);
}

await browser.close();
server.close();
