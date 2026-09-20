// PFD 文字重叠检测：渲染真实的 drawPFD，拦截每一次 fillText，
// 用 measureText 的真实字形边界求包围盒，再两两求交。
// 比“重新实现一遍布局公式”可靠 —— 测的就是真正跑的那条代码路径。
import { createCanvas } from '@napi-rs/canvas';
import { drawPFD } from '../src/displays/cockpit.js';

const st = { phi: 0, theta: 2.5, psi: 180, vc: 120, h: 4500, alpha: 3.2, nz: 1.02, beta: 1.1, mach: 0.18, lat: 0, lon: 0 };
const mkFcs = (tags) => ({
  annunciate: () => ({ law: 'NORMAL', lawText: 'NORMAL LAW', protText: '', tags, faults: [] }),
});

function render(w, h, tags) {
  const cv = createCanvas(w, h);
  const real = cv.getContext('2d');
  const calls = [];
  let curFont = real.font;
  const proxy = new Proxy(real, {
    get(t, k) {
      if (k === 'font') return curFont;
      const v = t[k];
      if (typeof v === 'function') {
        if (k === 'fillText') {
          return (text, x, y) => { calls.push({ text: String(text), x, y, font: curFont, align: t.textAlign, baseline: t.textBaseline }); return t.fillText(text, x, y); };
        }
        return (...a) => v.apply(t, a);
      }
      return v;
    },
    set(t, k, v) { if (k === 'font') curFont = v; t[k] = v; return true; },
  });
  drawPFD(proxy, w, h, st, mkFcs(tags), { throttle: 0.62, vs: 0 });
  return { cv, calls, real };
}

function bbox(real, c) {
  real.font = c.font;
  const m = real.measureText(c.text);
  const w = m.width;
  const asc = m.actualBoundingBoxAscent || 0;
  const desc = m.actualBoundingBoxDescent || 0;
  const x0 = c.align === 'center' ? c.x - w / 2 : c.align === 'right' ? c.x - w : c.x;
  // baseline=middle ⇒ 字形竖直中心落在 y 上
  const half = (asc + desc) / 2;
  return { x0, x1: x0 + w, y0: c.y - half, y1: c.y + half, text: c.text, font: c.font };
}

const isHdg = (t) => /^\d{3}$/.test(t);
const isFma = (t) => /HOLD|LAW|PROT/.test(t) || t.includes('·');

function overlap(a, b) {
  const x = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const y = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return x > 0 && y > 0 ? { x, y } : null;
}

const SIZES = [
  // 座舱仪表板：画布高 = 31vh，宽 = 高 × 0.85（见 index.html 的 body.cam-cockpit）
  ['座舱 1080p 285x335', 285, 335],
  ['座舱 900p  237x279', 237, 279],
  ['座舱 768p  202x238', 202, 238],
  ['座舱 720p  190x223', 190, 223],
  // 其他视角的既有尺寸（回归）
  ['旧座舱尺寸 600x288', 600, 288],
  ['原小尺寸 318x196', 318, 196],
  ['宽扁 700x300', 700, 300],
  ['窄高 300x500', 300, 500],
  ['极小 240x150', 240, 150],
];

let bad = 0;
const TAGS = ['BANK HOLD', 'FPA HOLD'];
for (const [name, w, h] of SIZES) {
  const { calls, real } = render(w, h, TAGS);
  const boxes = calls.map(c => bbox(real, c));
  const hdg = boxes.filter(b => isHdg(b.text));
  const fma = boxes.filter(b => isFma(b.text));
  const hits = [];
  for (const f of fma) for (const g of hdg) { const o = overlap(f, g); if (o) hits.push({ fma: f.text, hdg: g.text, ox: +o.x.toFixed(1), oy: +o.y.toFixed(1), dy: [(f.y0 - g.y0).toFixed(1), (f.y1 - g.y1).toFixed(1)] }); }
  const hdgBand = hdg.length ? { top: Math.min(...hdg.map(b => b.y0)), bot: Math.max(...hdg.map(b => b.y1)) } : null;
  const fmaBand = fma.length ? { top: Math.min(...fma.map(b => b.y0)), bot: Math.max(...fma.map(b => b.y1)) } : null;
  const gap = hdgBand && fmaBand ? hdgBand.top - fmaBand.bot : null;
  const status = hits.length ? 'FAIL' : 'PASS';
  if (hits.length) bad++;
  console.log(`  ${status}  ${name.padEnd(28)} FMA底=${fmaBand?.bot?.toFixed(1)}  航向带顶=${hdgBand?.top?.toFixed(1)}  间隙=${gap?.toFixed(1)}px  重叠对=${hits.length}`);
  if (hits.length) hits.slice(0, 3).forEach(x => console.log(`          ↳ "${x.fma}" × "${x.hdg}" 重叠 ${x.ox}×${x.oy}px`));
}

console.log('\n=== 对照：把顶部布局改回旧的固定比例，是否复现重叠 ===');
// 旧公式：fmaH = boxH*0.11；stripY = tapeTop - fmaH*0.34；fmaY = y0 + boxH*0.035
function oldBands(w, h, real) {
  const boxW = Math.min(w, h * 0.82), boxH = Math.min(h, boxW * 1.30);
  const U = boxW / 100, fs = (n) => Math.max(6, n * U);
  const y0 = (h - boxH) / 2;
  const fFma = fs(5.0), fHdg = fs(4.4), fTag = fs(3.4);
  const fmaH = boxH * 0.11;
  const stripY = (y0 + fmaH) - fmaH * 0.34;
  const fmaY = y0 + boxH * 0.035;
  const fma2Y = fmaY + fFma * 1.35;
  const stripTop = stripY - fHdg * 0.8, stripBot = stripY + fHdg * 0.8;
  real.font = `bold ${fFma}px x`;
  const line1 = { top: fmaY - fFma / 2, bot: fmaY + fFma / 2 };
  const line2 = { top: fma2Y - fTag / 2, bot: fma2Y + fTag / 2 };
  const ov1 = Math.min(line1.bot, stripBot) - Math.max(line1.top, stripTop);
  const ov2 = Math.min(line2.bot, stripBot) - Math.max(line2.top, stripTop);
  return { strip: [stripTop.toFixed(1), stripBot.toFixed(1)], line1: ov1.toFixed(1), line2: ov2.toFixed(1) };
}
for (const [name, w, h] of SIZES) {
  const { real } = render(w, h, TAGS);
  const o = oldBands(w, h, real);
  console.log(`  ${name.padEnd(28)} 航向带 ${o.strip.join('…')} | 旧布局与 FMA 第1行重叠 ${o.line1}px，第2行重叠 ${o.line2}px`);
}

console.log(bad ? `\n结果：${bad} 个尺寸仍有重叠` : '\n结果：所有尺寸 FMA 与航向带均无重叠');
process.exit(bad ? 1 : 0);
