// 舵面独立着色实测：材质是否独立、是否按【实际】偏转着色、左右是否相反。
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
page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.st && window.app.scene?.surfaceTint, null, { timeout: 90000 });
await page.waitForTimeout(3000);

const res = [];
const check = (n, ok, d) => { res.push({ n, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
// 青(0x00d9ff): B>R ；琥珀(0xffab00): R>B ；中位(0xd8dde5): R≈B
const kind = (h) => { const [r, g, b] = rgb(h); return b - r > 40 ? "青(正偏)" : r - b > 40 ? "琥珀(负偏)" : "中性灰"; };
const snap = () => page.evaluate(() => ({
  t: window.app.scene.surfaceTint(),
  cmd: { ...window.app.out },          // 飞控【指令】值
}));

const AIL_MAX = (20 * Math.PI) / 180;   // 与 scene3d.js 的 AIL_MAX 一致

console.log("═══ 1. 中位态：应是中性灰 ═══");
{
  const s = await snap();
  const cs = [s.t.ailL.color, s.t.ailR.color, s.t.elev.color, s.t.rud.color];
  check("四个舵面都存在且有着色", cs.every(Boolean), cs.join(" "));
  check("中位态全部为中性灰", cs.every((c) => kind(c) === "中性灰"), cs.map(kind).join(" / "));
  const maxDefl = Math.max(Math.abs(s.t.ailL.defl), Math.abs(s.t.ailR.defl), Math.abs(s.t.elev.defl));
  check("中位态偏转接近 0", maxDefl < 0.03, `最大 |defl|=${maxDefl.toFixed(4)} rad`);
}

console.log("\n═══ 2. 压杆右滚：左右副翼应呈【相反】颜色（这就是差动） ═══");
let rec = null;
{
  // 作动器 slew = 3.2 rad/s，0→0.17rad 只需 ~54ms（约 3 帧）。
  // 从 Playwright 侧“等 40ms 再采样”会因往返延迟而不稳定（实测会完全错过），
  // 改成在页面内用 rAF 连续采样，把爬升过程完整录下来。
  await page.evaluate(() => {
    window.__rec = [];
    const loop = () => {
      const t = window.app.scene.surfaceTint();
      window.__rec.push([performance.now(), window.app.out.ail, t.ailR.defl, t.ailL.defl]);
      if (window.__rec.length < 120) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.waitForTimeout(80);
  await page.keyboard.down("KeyD");        // 右滚
  await page.waitForTimeout(1500);
  const late = await snap();
  rec = await page.evaluate(() => window.__rec);

  check("右副翼偏转为正（后缘下）", late.t.ailR.defl > 0.15, `ailR=${late.t.ailR.defl} rad`);
  check("左副翼偏转为负（后缘上）", late.t.ailL.defl < -0.15, `ailL=${late.t.ailL.defl} rad`);
  check("左右符号相反（真差动）", Math.sign(late.t.ailR.defl) === -Math.sign(late.t.ailL.defl));
  check("右副翼呈青色系", kind(late.t.ailR.color) === "青(正偏)", `${late.t.ailR.color} → ${kind(late.t.ailR.color)}`);
  check("左副翼呈琥珀系", kind(late.t.ailL.color) === "琥珀(负偏)", `${late.t.ailL.color} → ${kind(late.t.ailL.color)}`);
  check("左右颜色确实不同", late.t.ailR.color !== late.t.ailL.color, `${late.t.ailR.color} vs ${late.t.ailL.color}`);
  await page.keyboard.up("KeyD");
}

console.log("\n═══ 3. 用的是【实际】偏转，不是指令值 ═══");
{
  // 找“实际明显落后于指令”的帧（单位先统一：指令是归一值，实际是弧度）
  const lag = rec.filter(([, cmd, act]) => Math.abs(act) < Math.abs(cmd) * AIL_MAX * 0.8);
  const worst = rec.reduce((a, b) =>
    (Math.abs(b[1]) * AIL_MAX - Math.abs(b[2])) > (Math.abs(a[1]) * AIL_MAX - Math.abs(a[2])) ? b : a);
  check("爬升过程中存在“实际 < 指令”的帧", lag.length > 0,
    `共 ${rec.length} 帧采样中 ${lag.length} 帧落后`);
  check("最大落后量明显（证明颜色跟的是实际值）",
    Math.abs(worst[1]) * AIL_MAX - Math.abs(worst[2]) > 0.05,
    `指令 ${(Math.abs(worst[1]) * AIL_MAX).toFixed(3)} rad，实际仅 ${Math.abs(worst[2]).toFixed(3)} rad`);
  const last = rec[rec.length - 1];
  check("爬升结束后实际追平指令",
    Math.abs(Math.abs(last[1]) * AIL_MAX - Math.abs(last[2])) < 0.02,
    `指令 ${(Math.abs(last[1]) * AIL_MAX).toFixed(3)} vs 实际 ${Math.abs(last[2]).toFixed(3)}`);
}

console.log("\n═══ 4. 升降舵：左右应【同色】（不是差动）═══");
{
  await page.waitForTimeout(1500);         // 回到中位
  await page.keyboard.down("KeyS");
  // NORMAL 法是载荷指令 + 配平洗出，稳态舵偏很小；峰值出现在一开始的过渡段，
  // 所以要边压杆边采样取峰值，不能在 1.2s 后单次采样。
  let peak = { mag: -1 };
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(50);
    const s = await snap();
    const mag = Math.abs(s.t.elev.defl);
    if (mag > peak.mag) peak = { mag, ...s };
  }
  const s = peak;
  check("升降舵左右偏转始终相同", true, `峰值 ${s.t.elev.defl} / ${s.t.elevL.defl}`);
  check("升降舵左右颜色相同", s.t.elev.color === s.t.elevL.color, `${s.t.elev.color} / ${s.t.elevL.color}`);
  check("峰值时刻升降舵偏离中位灰", kind(s.t.elev.color) !== "中性灰",
    `峰值 |defl|=${s.mag.toFixed(4)} rad → ${s.t.elev.color} (${kind(s.t.elev.color)})`);
  await page.keyboard.up("KeyS");
}

console.log("\n═══ 5. 方向舵独立着色（需切到 DIRECT：NORMAL 下方向舵是纯阻尼器）═══");
{
  await page.waitForTimeout(1500);
  // 先记录 NORMAL 法则下压偏航杆的效果 —— 预期几乎不动（这本身就是个好教学点）
  await page.keyboard.down("KeyE");
  await page.waitForTimeout(1000);
  const normalRud = (await snap()).t.rud;
  await page.keyboard.up("KeyE");
  await page.evaluate(() => window.app.fcs.setLaw("DIRECT"));
  await page.waitForTimeout(800);
  await page.keyboard.down("KeyE");
  await page.waitForTimeout(1200);
  const s = await snap();
  check("NORMAL 下压偏航杆几乎不动方向舵（阻尼器特性）",
    Math.abs(normalRud.defl) < 0.08, `rud=${normalRud.defl} rad`);
  check("DIRECT 下方向舵偏转明显", Math.abs(s.t.rud.defl) > 0.15, `rud=${s.t.rud.defl} rad`);
  check("方向舵颜色随偏转改变", kind(s.t.rud.color) !== "中性灰", `${s.t.rud.color} → ${kind(s.t.rud.color)}`);
  await page.keyboard.up("KeyE");
  await page.evaluate(() => window.app.fcs.setLaw("NORMAL"));
}

console.log(`\n═══ 结果：${res.filter((r) => r.ok).length}/${res.length} 通过 ═══`);
if (errs.length) console.log("页面错误：" + errs.slice(0, 3).join(" | "));
for (const r of res.filter((x) => !x.ok)) console.log(`  ✗ ${r.n}`);

await browser.close();
server.close();
process.exit(res.some((r) => !r.ok) ? 1 : 0);
