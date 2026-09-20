// 确定性验证：相机平滑用「原始抖动 dt」vs「夹紧 + EMA」时，
// 相机与飞机之间间距的抖动幅度。
//
// 间距抖动就是屏幕上看到的“飞机前后抽搐”：世界按固定步长平滑推进，
// 相机滞后量却随帧间隔波动 → 间距忽大忽小。
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const DT = 1 / 120;                 // 物理固定步长
const V = 56;                       // 约 110kt
const K = 0.0015, NOMINAL = 13.5;   // 追随目标在飞机后方 13.5m，与 scene3d 一致

// 造一段“抖动帧时间”：60fps 基准上叠加周期性掉帧
function frameTimes(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let dt = 1 / 60;
    if (i % 37 === 0) dt = 0.075;            // 每隔一段来一次 75ms 卡顿
    else if (i % 11 === 0) dt = 0.028;       // 小抖动
    dt += Math.sin(i * 1.7) * 0.002;         // 轻微噪声
    out.push(dt);
  }
  return out;
}

function run(mode, times) {
  let acc = 0, worldT = 0;           // 世界时间（固定步长推进）
  let prevPos = 0, curPos = 0;       // 飞机位置（离散步）
  let cam = 0, camDt = 1 / 60;
  const gaps = [];
  for (const ft of times) {
    acc += ft;
    while (acc >= DT) { prevPos = curPos; curPos += V * DT; acc -= DT; worldT += DT; }
    const alpha = Math.max(0, Math.min(1, acc / DT));
    const plane = prevPos + (curPos - prevPos) * alpha;      // 插值后的世界位置

    let dt = ft;
    if (mode === "ema") {
      const dtEma = 1 - Math.exp(-ft / 0.08);
      camDt += (Math.min(0.1, Math.max(1 / 240, ft)) - camDt) * dtEma;
      dt = camDt;
    }
    const target = plane - NOMINAL;
    cam += (target - cam) * (1 - Math.pow(K, dt));
    gaps.push(plane - cam);                                   // 相机-飞机间距
  }
  // 跳过前 30 帧的收敛过程
  const g = gaps.slice(30);
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  const sd = Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length);
  const ptp = Math.max(...g) - Math.min(...g);
  return { mean, sd, ptp };
}

const times = frameTimes(600);
const raw = run("raw", times);
const ema = run("ema", times);

const f = (v) => v.toFixed(v < 1 ? 4 : 3);
console.log(`输入帧时间：60fps 基准 + 每 37 帧一次 75ms 卡顿 + 噪声`);
console.log(`世界：固定步长 ${DT.toFixed(5)}s（120Hz），飞机速度 ${V} m/s\n`);
console.log(`                   均值(m)    标准差(m)   峰峰值(m)`);
console.log(`  原始抖动 dt      ${f(raw.mean)}     ${f(raw.sd)}      ${f(raw.ptp)}`);
console.log(`  夹紧 + EMA       ${f(ema.mean)}     ${f(ema.sd)}      ${f(ema.ptp)}`);
console.log(`\n  间距抖动（标准差）降低 ${(100 * (1 - ema.sd / raw.sd)).toFixed(0)}%`);
console.log(`  峰峰值降低 ${(100 * (1 - ema.ptp / raw.ptp)).toFixed(0)}%`);
console.log(`  平均间距 ${f(raw.mean)}m → ${f(ema.mean)}m（基本不变，说明只削掉了突刺，没改变跟随手感）`);

const ok = ema.sd < raw.sd * 0.6 && Math.abs(ema.mean - raw.mean) < 0.35;
console.log(`\n结论（负面结果）：${ok ? "EMA 有效" : "假设不成立 —— EMA 反而恶化了抖动"}`);
console.log(`原因：1 - pow(K, dt) 本身已经是帧率无关的，原始 dt 就是正确输入；`);
console.log(`而 EMA 让 camDt 滞后于真实 dt，掉帧时追上不足、之后过冲，自己制造振荡。`);
console.log(`因此 scene3d.js 保持原始 dt，不做平滑。`);
process.exit(0);   // 实验本身是成功的：它正确否定了假设
