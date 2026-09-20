// 对照：帧循环里追不上时 `acc = 0` vs `acc = min(acc, DT)`，
// 对【渲染位置连续性】的影响。
//
// acc 归零 → alpha 从 1 掉到 0 → 渲染位置从当前步退回整整一个物理步。
// 用与 main.js frame() 相同的逻辑模拟，统计渲染位置的“向后跳”。
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const DT = 1 / 120, RATE = 1, MAXSTEPS = 60 * RATE;
const V = 56;                       // m/s

// 造一段帧时间：基准 60fps，中间夹几次大风车式长卡顿（触发 guard 打满）
function frameTimes(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let dt = 1 / 60;
    if (i % 120 === 60) dt = 0.62;            // 620ms 长卡顿 → acc 远超 maxSteps*DT
    else if (i % 37 === 0) dt = 0.075;
    dt += Math.sin(i * 1.7) * 0.002;
    out.push(dt);
  }
  return out;
}

function run(mode) {
  let acc = 0, curPos = 0, prevPos = 0;
  let resets = 0;
  const pos = [];
  for (const ft of frameTimes(700)) {
    acc += ft * RATE;
    let guard = 0;
    while (acc >= DT && guard++ < MAXSTEPS) { prevPos = curPos; curPos += V * DT; acc -= DT; }
    // 这里就是被对照的分支
    if (guard >= MAXSTEPS) {
      resets++;
      acc = mode === "zero" ? 0 : Math.min(acc, DT);
    }
    const alpha = Math.max(0, Math.min(1, acc / DT));
    pos.push(prevPos + (curPos - prevPos) * alpha);
  }
  // 统计除“世界本身前进”之外的负向位移（世界只增不减，所以任何负 delta 都是渲染回退）
  let maxBack = 0, backCount = 0;
  for (let i = 1; i < pos.length; i++) {
    const d = pos[i] - pos[i - 1];
    if (d < -1e-9) { backCount++; maxBack = Math.min(maxBack, d); }
  }
  return { resets, backCount, maxBack };
}

const z = run("zero");
const c = run("clamp");

console.log(`世界：固定步长 ${DT.toFixed(5)}s，飞机 ${V} m/s，maxSteps=${MAXSTEPS}`);
console.log(`帧时间：60fps 基准 + 每 37 帧 75ms 卡顿 + 每 120 帧一次 620ms 长卡顿\n`);
console.log(`  方案                触发丢弃次数   渲染“向后跳”次数   最大向后跳(m)`);
console.log(`  acc = 0            ${String(z.resets).padStart(10)}      ${String(z.backCount).padStart(12)}      ${Math.abs(z.maxBack).toFixed(3).padStart(12)}`);
console.log(`  acc = min(acc,DT)  ${String(c.resets).padStart(10)}      ${String(c.backCount).padStart(12)}      ${Math.abs(c.maxBack).toFixed(3).padStart(12)}`);

const ok = c.backCount < z.backCount || Math.abs(c.maxBack) < Math.abs(z.maxBack) * 0.6;
console.log(`\n结论（负面结果）：${ok ? "夹紧有效" : "假设不成立 —— 两者都不产生渲染回退"}`);
console.log(`原因：guard 打满时循环已推进 ${MAXSTEPS} 步，"alpha=0" 那个点仍远远领先于`);
console.log(`上一帧的渲染位置，所以它并不构成向后跳。acc = 0 的写法无需修改。`);
process.exit(0);   // 实验本身是成功的：它正确否定了假设
