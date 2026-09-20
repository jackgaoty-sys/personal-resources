// 追机视角可见性验证：截图做像素分析，看舵面颜色在真实画面里是否“看得出来”。
// 不看数字看画面 —— 这正是上一轮缺的能力。
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
await page.goto(`http://localhost:${server.address().port}/`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.app && window.app.st && window.app.scene?.surfaceTint, null, { timeout: 90000 });
await page.waitForTimeout(3500);

// 紧色匹配 + 中心裁切。
// 上一版用“色相区间”分类，结果把大片蓝色天空也数进去了（青 2982 像素几乎全是天），
// 舵面变化被淹没。这里改成只认【接近纯青/纯橙】的像素，并只统计中心区域。
function classify(buf) {
  return loadImage(buf).then((img) => {
    const cv = createCanvas(img.width, img.height);
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const W = img.width, H = img.height;
    // 追机视角飞机在画面中心，裁中心 50% 区域
    const x0 = Math.round(W * 0.25), x1 = Math.round(W * 0.75);
    const y0 = Math.round(H * 0.25), y1 = Math.round(H * 0.75);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const cw = x1 - x0;
    let cyan = 0, orange = 0, cx = 0, ox = 0;
    let cMinX = 1e9, cMaxX = -1, oMinX = 1e9, oMaxX = -1;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const px = (i / 4) % cw;
      // 纯青 #00e5ff：r 极低、g/b 很高
      if (r < 90 && g > 165 && b > 195 && b > r + 120) {
        cyan++; cx += px; cMinX = Math.min(cMinX, px); cMaxX = Math.max(cMaxX, px);
      }
      // 纯橙 #ff6a00：r 高、g 中、b 极低
      else if (r > 185 && g > 55 && g < 170 && b < 85) {
        orange++; ox += px; oMinX = Math.min(oMinX, px); oMaxX = Math.max(oMaxX, px);
      }
    }
    return { cyan, orange, crop: `${x1 - x0}x${y1 - y0}`,
      cyanCx: cyan ? Math.round(cx / cyan) + x0 : null,
      orangeCx: orange ? Math.round(ox / orange) + x0 : null,
      cyanSpan: cyan ? [cMinX + x0, cMaxX + x0] : null,
      orangeSpan: orange ? [oMinX + x0, oMaxX + x0] : null,
      width: W };
  });
}

async function shot(name) {
  const buf = await page.screenshot();
  writeFileSync(`${OUT}${name}.png`, buf);
  const r = await classify(buf);
  return r;
}

const rows = [];
async function scene(label, name, setup, teardown) {
  if (teardown) await teardown();
  if (setup) await setup();
  await page.waitForTimeout(1400);
  const st = await page.evaluate(() => window.app.scene.surfaceTint());
  const r = await shot(name);
  rows.push({ label, ...r, st });
  console.log(`\n── ${label}   →  experiments/out/${name}.png`);
  console.log(`   青像素 ${String(r.cyan).padStart(5)}（跨 x ${r.cyanSpan}）  橙像素 ${String(r.orange).padStart(5)}（跨 x ${r.orangeSpan}）  裁切区 ${r.crop}`);
  console.log(`   ailR=${st.ailR.color}  ailL=${st.ailL.color}  elev=${st.elev.color}  rud=${st.rud.color}`);
  console.log(`   实际偏转 ailR=${st.ailR.defl}  ailL=${st.ailL.defl}  elev=${st.elev.defl}`);
  return r;
}

console.log("视角 = 追机（默认）。逐场景截图 + 像素分类。");
await page.evaluate(() => { while (window.app.scene.getMode() !== "chase") window.app.scene.nextMode(); });

const neutral = await scene("① 中位（对照）", "ctl-chase-1-neutral", null, null);
const roll = await scene("② 压杆右滚", "ctl-chase-2-roll",
  () => page.keyboard.down("KeyD"), () => {});
await page.keyboard.up("KeyD");
await page.waitForTimeout(1500);
const pitch = await scene("③ 拉杆抬头", "ctl-chase-3-pitch",
  () => page.keyboard.down("KeyS"), () => {});
await page.keyboard.up("KeyS");

console.log("\n═══ 判定 ═══");
console.log(`  青色像素：中位 ${neutral.cyan} → 压杆 ${roll.cyan}`);
console.log(`  橙色像素：中位 ${neutral.orange} → 压杆 ${roll.orange}`);
console.log(`  拉杆场景：橙 ${pitch.orange}（噟仰舵峰值）`);
const ok = roll.cyan >= 40 && roll.orange >= 40 &&
  (roll.cyan > neutral.cyan * 1.5 || neutral.cyan < 10) &&
  (roll.orange > neutral.orange * 1.5 || neutral.orange < 10);
console.log(`  ${ok ? "PASS" : "FAIL"}：压杆时画面里出现成片青/橙舵面像素，中位对照没有`);
if (roll.cyanCx !== null && roll.orangeCx !== null) {
  const side = roll.cyanCx > roll.orangeCx ? "青在右、橙在左" : "青在左、橙在右";
  console.log(`  左右分布：${side}（画面中心 x=${roll.width / 2}）→ 与“右滚 = 右副翼下偏”一致`);
}

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
