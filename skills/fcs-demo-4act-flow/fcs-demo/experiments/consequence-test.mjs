import { Consequences, HULL, HULL_LABEL, LIMITS } from "../src/fcs/consequences.js";

const st = (o = {}) => ({ alpha: 5, nz: -1, vc: 110, phi: 0, theta: 2, h: 4500, ...o });
const run = (name, steps) => {
  const c = new Consequences();
  let last = null;
  for (const [s, ctx] of steps) last = c.update(s, ctx);
  const ev = c.takePending().map(e => e.text);
  return { name, hull: HULL_LABEL[c.hull], stalled: c.everStalled, crashed: c.crashed, impact: c.impact?.kind ?? null, ev };
};
const cases = [
  run("正常平飞", [[st(), { aglM: 1000, terrainKnown: true }]]),
  run("失速（α=18°）", [[st({ alpha: 18 }), { aglM: 1000, terrainKnown: true }]]),
  run("结构超载 4.5g", [[st({ nz: -4.5 }), { aglM: 1000, terrainKnown: true }]]),
  run("超速 180kt", [[st({ vc: 180 }), { aglM: 1000, terrainKnown: true }]]),
  run("轻接地 -1.0m/s", [[st(), { aglM: 1.2, vsMps: -1.0, terrainKnown: true }]]),
  run("重着陆 -2.0m/s", [[st(), { aglM: 1.2, vsMps: -2.0, terrainKnown: true }]]),
  run("极重 -3.5m/s", [[st(), { aglM: 1.2, vsMps: -3.5, terrainKnown: true }]]),
  run("坠毁 -8m/s", [[st(), { aglM: 1.2, vsMps: -8, terrainKnown: true }]]),
  run("斜着接地 30°坡度", [[st({ phi: 30 }), { aglM: 1.2, vsMps: -1.0, terrainKnown: true }]]),
  run("低头接地 -12°", [[st({ theta: -12 }), { aglM: 1.2, vsMps: -0.8, terrainKnown: true }]]),
  run("撞山（地形之下）", [[st({ vc: 90 }), { aglM: -5, vsMps: -0.5, terrainKnown: true }]]),
  run("地形未就绪时不误判", [[st(), { aglM: -5, vsMps: -8, terrainKnown: false }]]),
];
console.log('失速迎角阈值:', LIMITS.alphaStallDeg, '°（取自 c172p 阻力表峰值 0.2793 rad）\n');
for (const c of cases) {
  console.log(`${c.name.padEnd(22)} 机体=${c.hull.padEnd(5)} 失速=${c.stalled?'是':'否'} 坠毁=${c.crashed?'是':'否'} 类型=${(c.impact||'-').padEnd(9)} ${c.ev.length?('事件: '+c.ev.join(' | ')):''}`);
}
