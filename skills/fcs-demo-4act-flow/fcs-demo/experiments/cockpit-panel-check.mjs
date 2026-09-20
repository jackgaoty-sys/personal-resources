// 座舱仪表板冒烟测试：
// 1) 在【新座舱画布尺寸】上渲染 PFD / ECAM，确认不抛异常、输出非空
// 2) 复用字形包围盒技术做文字两两重叠检测（ECAM 之前没测过）
// 3) 导出 PNG 到 experiments/out/ 供人工查看
import { createCanvas } from '@napi-rs/canvas';
import { drawPFD, drawECAM } from '../src/displays/cockpit.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const st = { phi: -12, theta: 2.5, psi: 180, vc: 120, h: 4500, alpha: 3.2, nz: 1.02, beta: 1.1, mach: 0.18, lat: 0, lon: 0 };
const mkFcs = (tags, faults = []) => ({
  annunciate: () => ({ law: 'NORMAL', lawText: 'NORMAL LAW', protText: '', tags, faults }),
});
const extra = { throttle: 0.62, vs: 0, elev: 0.12, ail: -0.3, rud: 0.02, trim: 0.05 };

// 带 fillText 录制的代理
function render(fn, w, h, fcs, ex) {
  const cv = createCanvas(w, h);
  const real = cv.getContext('2d');
  const calls = [];
  let curFont = real.font;
  const proxy = new Proxy(real, {
    get(t, k) {
      if (k === 'font') return curFont;
      const v = t[k];
      if (typeof v === 'function') {
        if (k === 'fillText')
          return (text, x, y) => { calls.push({ text: String(text), x, y, font: curFont, align: t.textAlign, baseline: t.textBaseline }); return t.fillText(text, x, y); };
        return (...a) => v.apply(t, a);
      }
      return v;
    },
    set(t, k, v) { if (k === 'font') curFont = v; t[k] = v; return true; },
  });
  fn(proxy, w, h, st, fcs, ex);
  return { cv, calls, real };
}

function bbox(real, c) {
  real.font = c.font;
  const m = real.measureText(c.text);
  const w = m.width, asc = m.actualBoundingBoxAscent || 0, desc = m.actualBoundingBoxDescent || 0;
  const x0 = c.align === 'center' ? c.x - w / 2 : c.align === 'right' ? c.x - w : c.x;
  const half = (asc + desc) / 2;
  return { x0, x1: x0 + w, y0: c.y - half, y1: c.y + half, text: c.text };
}
function overlap(a, b) {
  // 同文本对（如速度带上的高亮数值框与它底下的同值刻度标签）是【设计性遮挡】：
  // 框不透明且后画，会盖住刻度标签。不计入重叠。
  if (a.text === b.text) return null;
  const x = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const y = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return x > 0 && y > 0 ? { x, y } : null;
}

function dupCount(boxes) {
  let n = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (boxes[i].text === boxes[j].text) {
        const x = Math.min(boxes[i].x1, boxes[j].x1) - Math.max(boxes[i].x0, boxes[j].x0);
        const y = Math.min(boxes[i].y1, boxes[j].y1) - Math.max(boxes[i].y0, boxes[j].y0);
        if (x > 0 && y > 0) n++;
      }
  return n;
}

// 座舱：画布高 31vh，PFD 宽=高×0.85，ECAM 宽=高×1.30
// 另外把【旧座舱尺寸】当作对照，用来判断重叠是原本就有的还是本次引入的。
const VH = [1080, 900, 768, 720];
const sizes = VH.map((vh) => {
  const h = Math.round(vh * 0.31);
  return { vh, pfd: [Math.round(h * 0.85), h], ecam: [Math.round(h * 1.30), h] };
});
const BASELINE = [
  { vh: '旧座舱基准', pfd: [600, 288], ecam: [318, 150] },
  { vh: '更早基准', pfd: [318, 196], ecam: [318, 150] },
];

for (const b of BASELINE) {
  const [w, h] = b.pfd;
  const { calls, real } = render(drawPFD, w, h, mkFcs(['BANK HOLD', 'FPA HOLD']), extra);
  const boxes = calls.map((c) => bbox(real, c));
  const pairs = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const o = overlap(boxes[i], boxes[j]);
      if (o) pairs.push(`"${boxes[i].text}" × "${boxes[j].text}"`);
    }
  console.log(`  [对照] PFD ${b.vh} ${w}x${h}  两两重叠 ${pairs.length}${pairs.length ? ' → ' + pairs.join(' / ') : ''}`);
  console.log(`         （同一数值被重复绘制两次的总数：${dupCount(boxes)} 处，属设计性遮挡）`);
}
console.log();

let bad = 0;
for (const s of sizes) {
  const label = `${s.vh}p`;
  // ---- PFD ----
  {
    const [w, h] = s.pfd;
    const { cv, calls, real } = render(drawPFD, w, h, mkFcs(['BANK HOLD', 'FPA HOLD']), extra);
    const boxes = calls.map((c) => bbox(real, c));
    const pairs = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const o = overlap(boxes[i], boxes[j]);
        if (o) pairs.push(`"${boxes[i].text}" × "${boxes[j].text}" (${o.x.toFixed(1)}×${o.y.toFixed(1)}px)`);
      }
    writeFileSync(`${OUT}pfd-cockpit-${w}x${h}.png`, cv.toBuffer('image/png'));
    console.log(`  PFD  ${label.padEnd(6)} ${String(w).padStart(4)}x${h}  文本 ${String(calls.length).padStart(3)} 处  两两重叠 ${pairs.length}`);
    pairs.forEach((p) => console.log(`         ↳ ${p}`));
    if (pairs.length) bad++;
  }
  // ---- ECAM ----
  {
    const [w, h] = s.ecam;
    const { cv, calls, real } = render(drawECAM, w, h, mkFcs(['BANK HOLD'], ['elevator_actuator']), extra);
    const boxes = calls.map((c) => bbox(real, c));
    let hits = 0;
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        if (overlap(boxes[i], boxes[j])) hits++;
    writeFileSync(`${OUT}ecam-cockpit-${w}x${h}.png`, cv.toBuffer('image/png'));
    console.log(`  ECAM ${label.padEnd(6)} ${String(w).padStart(4)}x${h}  文本 ${String(calls.length).padStart(3)} 处  两两重叠 ${hits}`);
    if (hits) bad++;
  }
}

console.log(`\n结果：${bad ? bad + ' 个尺寸有文字重叠/异常' : '全部尺寸无文字重叠，PNG 已导出'}`);
console.log(`输出目录：${OUT}`);
process.exit(bad ? 1 : 0);
