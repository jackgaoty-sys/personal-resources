// 幽灵飞机验证。
// 定义：幽灵机 = 与真机同初始条件、同杆位、同油门，但舵面走 DIRECT（无增稳、无保护）。
// 于是【两机分离量 = 飞控对整机的总体影响】。
//
// ⚠ 测试设计要点（踩过的坑）：
//   不能比较【绝对分离量】。reset() 之后真机是 NORMAL、幽灵机已是 DIRECT，
//   到 setLaw() 生效之间哪怕只隔几百毫秒，两机就已经分开了；量到的绝对值里
//   混着这段残留。所以要比的是【同一机动窗口内的分离增长量】。
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
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
page.on("pageerror", (e) => errs.push(String(e).slice(0, 300)));
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.scene?.debugGhost && window.app.ghostSt, null, { timeout: 120000 });
await page.waitForTimeout(2000);

const res = [];
const check = (n, ok, d) => { res.push({ n, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const sep = () => page.evaluate(() => window.app.scene.debugGhost());
// 高精度分离量：直接从两套 FDM 状态算（debugGhost 只给两位小数，测不出“严格重合”）
const sepH = () => page.evaluate(() => {
  const a = window.app.st, b = window.app.ghostSt;
  if (!a || !b) return -1;
  const dn = (a.lat - b.lat) * 110540;
  const de = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
  const dh = (a.h - b.h) * 0.3048;
  return Math.hypot(dn, de, dh);
});
const peakSep = (ms) => page.evaluate((ms) => new Promise((r) => {
  let m = 0; const t0 = performance.now();
  const loop = () => {
    const a = window.app.st, b = window.app.ghostSt;
    if (a && b) {
      const dn = (a.lat - b.lat) * 110540;
      const de = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
      const dh = (a.h - b.h) * 0.3048;
      m = Math.max(m, Math.hypot(dn, de, dh));
    }
    if (performance.now() - t0 < ms) requestAnimationFrame(loop); else r(m);
  };
  requestAnimationFrame(loop);
}), ms);

// 一次完整回合：法则作为【开局条件】设定（走真实 UI 路径）→ 量基线 → 同一机动 → 量峰值
// 不能“先 reset 再 setLaw”：中途改法会让升降舵两条限速积分器历史不一致，
// 对照就脏了（实测 DIRECT 下因此差 0.19m 而不是严格重合）。
async function trial(lawName, ms = 2600) {
  await page.evaluate((l) => {
    const s = document.getElementById("initLaw");
    s.value = l;
    s.dispatchEvent(new Event("change"));      // 下拉自带“开一次新运行”
  }, lawName);
  await page.waitForTimeout(250);
  const s0 = await sepH();
  await page.keyboard.down("KeyD"); await page.keyboard.down("KeyS");
  const peak = await peakSep(ms);
  await page.keyboard.up("KeyD"); await page.keyboard.up("KeyS");
  return { s0, peak, growth: peak - s0 };
}

console.log("\n═══ ① 配平结束后两机应重合 ═══");
await page.evaluate(() => {
  const s = document.getElementById("initLaw");
  s.value = "NORMAL"; s.dispatchEvent(new Event("change"));
});
await page.waitForTimeout(200);                     // 只等两帧，别让它漂开
const g0 = await page.evaluate(() => ({
  ghostFdm: !!window.app.ghostFdm, ghostDirect: window.app.ghostDirect,
  initLaw: window.app.initLaw, law: window.app.fcs.law,
}));
const s0 = await sep();
check("开局法则已生效（不是写死的 NORMAL）", g0.initLaw === "NORMAL" && g0.law === "NORMAL", `initLaw=${g0.initLaw}, 当前法则=${g0.law}`);
check("第二套 FDM 已建立，配平后切到 DIRECT 对照", g0.ghostFdm && g0.ghostDirect === true, `ghostFdm=${g0.ghostFdm}, ghostDirect=${g0.ghostDirect}`);
check("配平刚结束、两机几乎重合", (await sepH()) < 1.0, `高精度 sep=${(await sepH()).toFixed(4)} m`);

// ── ② DIRECT：飞控不做事，两机应【严格】重合（不是“差不多”）──
console.log("\n═══ ② DIRECT 开局机动：两机应严格重合 ═══");
const d = await trial("DIRECT");
check("DIRECT 下两机严格重合（<0.05m）", d.growth < 0.05,
  `基线 ${d.s0.toFixed(4)} → 峰值 ${d.peak.toFixed(4)}，增长 ${d.growth.toFixed(4)} m`);

// ── ③ NORMAL：同样机动，飞控在做事，两机应分开 ──
console.log("\n═══ ③ NORMAL 开局同样机动：分离应显著增长 ═══");
const n = await trial("NORMAL");
check("NORMAL 下分离明显增长", n.growth > 15, `基线 ${n.s0.toFixed(2)} → 峰值 ${n.peak.toFixed(2)}，增长 ${n.growth.toFixed(2)} m`);
check("NORMAL 的增长远大于 DIRECT", n.growth > d.growth * 200, `DIRECT ${d.growth.toFixed(4)} m vs NORMAL ${n.growth.toFixed(2)} m`);
const shotFly = await page.screenshot();
writeFileSync(OUT + "ghost-fly.png", shotFly);

// ── ⑤ 幽灵机指示器：不管幽灵机飞多远，它都必须在画面里 ──
// 这是本功能的要害。追机视角始终跟着真机，而幽灵机会一直拉开、十几秒就出画 ——
// 只靠那架半透明幽灵机等于“它不存在”。指示器锚在【自机】上、半径固定，所以不会出画。
console.log("\n═══ ⑤ 幽灵机飞远后，3D 里是否仍有指示器 ═══");
const far = await page.evaluate(() => ({
  sep: window.app.scene.debugGhost().sep,
  mk: window.app.scene.debugGhostMarker(),
}));
check("幽灵机确实已经飞远", far.sep > 30, `分离 ${far.sep.toFixed(1)} m`);
check("指示器仍在且锚在自机（半径固定 12m）", far.mk.visible && Math.abs(far.mk.r - 12) < 0.5,
  `可见=${far.mk.visible}，距自机 ${far.mk.r} m`);

// ── ④ 幽灵机确实渲染出来（冻结 + 显示/隐藏差分）──
// 必须在幽灵机【确实在视野内】时测：它漂远后本来就不该出现在画面里，
// 那时开关它画面当然不变，测出来是假阴性。
console.log("\n═══ ④ 幽灵机是否真的渲染出来（冻结 + 显示/隐藏差分）═══");
await page.evaluate(() => window.app.reset());
await page.evaluate(() => window.app.fcs.setLaw("NORMAL"));
await page.keyboard.down("KeyD");
await page.waitForTimeout(1200);                    // 短机动：让两机分开几米，仍在追机视野内
await page.keyboard.up("KeyD");
await page.evaluate(() => { window.app.paused = true; });
await page.waitForTimeout(400);
const sVis = await sep();
console.log(`     此刻分离 ${sVis.sep} m，幽灵 visible=${sVis.visible}`);
await page.evaluate(() => window.app.scene.setGhostVisible(true));
await page.waitForTimeout(350);
const shotOn = await page.screenshot();
await page.evaluate(() => window.app.scene.setGhostVisible(false));
await page.waitForTimeout(350);
const shotOff = await page.screenshot();
writeFileSync(OUT + "ghost-on.png", shotOn);
writeFileSync(OUT + "ghost-off.png", shotOff);

const A = await loadImage(shotOff), B = await loadImage(shotOn);
const cv = createCanvas(A.width, A.height), cx = cv.getContext("2d");
cx.drawImage(A, 0, 0); const da = cx.getImageData(0, 0, A.width, A.height).data;
cx.drawImage(B, 0, 0); const db = cx.getImageData(0, 0, B.width, B.height).data;
let changed = 0, maxD = 0;
for (let i = 0; i < da.length; i += 4) {
  const dd = Math.abs(db[i] - da[i]) + Math.abs(db[i + 1] - da[i + 1]) + Math.abs(db[i + 2] - da[i + 2]);
  if (dd > 16) { changed++; maxD = Math.max(maxD, dd); }
}
const total = A.width * A.height;
check("显示/隐藏幽灵机画面确实有变化", changed > 300, `${changed} 个像素变化，最大 Δ${maxD}`);
check("变化是局部的（是一架飞机，不是整屏）", changed / total < 0.05, `占全画面 ${(100 * changed / total).toFixed(2)}%`);
console.log(`     对照图 → experiments/out/ghost-off.png / ghost-on.png`);
console.log(`     机动截图 → experiments/out/ghost-fly.png`);

// ── ⑥ 无论任何开局法则，都必须从【同一平飞状态】开局 ──
// 配平阶段固定用 NORMAL 做，再把配平量带给所选法则。
// 否则拿 DIRECT 配平：它没有自动配平，而且曾把配平量清零 —— 实测 t≈0 就已是
// θ=38.8°、φ=-18.6°、Vs=27.9 m/s，飞机在配平阶段就翻出去了。
console.log("\n═══ ⑥ 各开局法则是否都从同一状态开局 ═══");
const openState = async (lawName) => {
  await page.evaluate((l) => {
    const s = document.getElementById("initLaw");
    s.value = l; s.dispatchEvent(new Event("change"));
  }, lawName);
  await page.waitForTimeout(300);
  return page.evaluate(() => ({
    theta: window.app.st.theta, phi: window.app.st.phi, vs: window.app.vs,
    law: window.app.fcs.law, trim: window.app.fcs.trim,
  }));
};
const base = await openState("NORMAL");
for (const lawName of ["ALTERNATE", "DIRECT"]) {
  const s = await openState(lawName);
  const ok = s.law === lawName
    && Math.abs(s.theta - base.theta) < 3 && Math.abs(s.phi - base.phi) < 3 && Math.abs(s.vs - base.vs) < 3;
  check(`${lawName} 开局与 NORMAL 同一平飞状态`, ok,
    `θ ${s.theta.toFixed(1)}° vs ${base.theta.toFixed(1)}°  φ ${s.phi.toFixed(1)}° vs ${base.phi.toFixed(1)}°  Vs ${s.vs.toFixed(1)} vs ${base.vs.toFixed(1)} m/s  law=${s.law}`);
}

console.log(`\n═══ 结果：${res.filter((r) => r.ok).length}/${res.length} 通过 ═══`);
res.filter((r) => !r.ok).forEach((r) => console.log("  ✗ " + r.n));
if (errs.length) console.log("页面错误：\n  " + errs.slice(0, 4).join("\n  "));
await browser.close(); server.close();
process.exit(res.every((r) => r.ok) ? 0 : 1);
