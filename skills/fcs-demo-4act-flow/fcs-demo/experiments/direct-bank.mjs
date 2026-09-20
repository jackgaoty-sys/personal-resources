// 诊断（v3）：DIRECT 法则下杆回中，飞机为何自动左倾？
// 关键：所有覆盖必须在 fcs.update() 之后、fdm.step() 之前写入，否则会被 FCS 输出覆盖。
import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";
import { FCS, LAW } from "../src/fcs/fcs.js";

const RATE = 120, DT = 1 / RATE, THROTTLE = 0.62;
const fdm = await createFdm();
const NEUTRAL = { pitch: 0, roll: 0, yaw: 0 };
const DEG = Math.PI / 180;

// over 可以是对象，也可以是 (st,u)=>对象 —— 在 step 之前最后写入，保证生效
function step(fcs, stick, over = {}) {
  const st = unpack(fdm.readState());
  const u = fcs.update(st, stick, DT);
  const vals = {
    "fcs/throttle-cmd-norm": THROTTLE,
    "fcs/elevator-cmd-norm": u.elev,
    "fcs/aileron-cmd-norm": u.ail,
    "fcs/rudder-cmd-norm": u.rud,
    "fcs/pitch-trim-cmd-norm": u.trim,
    ...(typeof over === "function" ? over(st, u) : over),
  };
  for (const [k, v] of Object.entries(vals)) fdm.set(k, v);
  fdm.step();
  return { st, u };
}

function settle(fcs) {
  fdm.reset();
  fcs.gammaRef = 0;
  for (let i = 0; i < 6 * RATE; i++) step(fcs, NEUTRAL);
}

function trace(label, fcs, seconds, over = {}) {
  console.log(`\n── ${label}`);
  console.log("   t(s)    phi(°)    p(rad/s)   theta(°)   beta(°)    r(rad/s)   elev");
  for (let i = 0; i < seconds * RATE; i++) {
    const { st } = step(fcs, NEUTRAL, over);
    if (i % (RATE * 2) === 0)
      console.log(`  ${(i * DT).toFixed(1).padStart(4)}  ${st.phi.toFixed(2).padStart(7)}  ${st.p.toFixed(5).padStart(9)}  ${st.theta.toFixed(2).padStart(8)}  ${st.beta.toFixed(3).padStart(7)}  ${st.r.toFixed(5).padStart(9)}  ${fdm.get("fcs/elevator-pos-norm").toFixed(4).padStart(7)}`);
  }
  const s = unpack(fdm.readState());
  console.log(`  → 终点 phi=${s.phi.toFixed(2)}°  theta=${s.theta.toFixed(2)}°`);
  return s.phi;
}

console.log("═══ 配平起点（NORMAL 平飞）═══");
let ailTrim;
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  ailTrim = fcs.lastOut.ail;
  console.log(`  phi=${unpack(fdm.readState()).phi.toFixed(2)}°  ail_cmd=${ailTrim.toFixed(5)} (${(ailTrim * 15).toFixed(2)}° 左副翼)`);
  console.log(`  roll-trim-cmd-norm=${fdm.get("fcs/roll-trim-cmd-norm")}  yaw-trim=${fdm.get("fcs/yaw-trim-cmd-norm")}`);
}

console.log("\n═══ 力矩分量探查（配平点上，看哪一项在把飞机往左推）═══");
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  const cands = [
    "moments/l-total-lbsft", "moments/l-aero-lbsft", "moments/l-prop-lbsft",
    "moments/l-gear-lbsft", "moments/l-mass-lbsft", "moments/l-buoyancy-lbsft",
    "moments/n-total-lbsft", "moments/m-total-lbsft",
    "propulsion/engine/thrust-lbs", "velocities/vt-fps",
  ];
  for (const c of cands) {
    const v = fdm.get(c);
    console.log(`  ${c.padEnd(34)} = ${Number.isFinite(v) ? v.toExponential(4) : String(v)}`);
  }
}

console.log("\n═══ 隔离实验（全部 DIRECT、杆回中，20 秒）═══");
const base = new FCS(LAW.NORMAL); settle(base);
const theta0 = unpack(fdm.readState()).theta;

{
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  trace("A 基线（发动机工作）", fcs, 20);
}
{
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  fdm.set("propulsion/engine/set-running", 0);
  trace("B 关车 + 推力 0", fcs, 20, { "fcs/throttle-cmd-norm": 0 });
}
{
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  trace("C 方向舵阻尼（-0.8*r - 1.5*beta，模拟 NORMAL 的偏航增稳）", fcs, 20, (st) => ({ "fcs/rudder-cmd-norm": Math.max(-1, Math.min(1, -0.8 * st.r - 1.5 * st.beta * (Math.PI / 180))) }));
}

console.log("\n═══ E. 定量：DIRECT 自由滚转的初始滚转加速度 ═══");
{
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  const p = [];
  for (let i = 0; i < 2 * RATE; i++) { const { st } = step(fcs, NEUTRAL); p.push(st.p); }
  const at = (t) => p[Math.min(p.length - 1, Math.round(t * RATE))];
  console.log(`  p: t=0.25s ${at(0.25).toFixed(5)}  t=0.5s ${at(0.5).toFixed(5)}  t=1.0s ${at(1.0).toFixed(5)}  t=2.0s ${at(1.99).toFixed(5)} rad/s`);
  console.log(`  初期 dp/dt ≈ ${((at(0.5) - at(0.25)) / 0.25).toFixed(5)} rad/s²  （负 = 净左滚力矩）`);
  console.log(`  折算 ≈ ${(((at(0.5) - at(0.25)) / 0.25) / DEG).toFixed(3)} °/s²`);
}

console.log("\n═══ F. 反向验证：DIRECT 但把副翼钉在 NORMAL 的配平值 ═══");
{
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  const end = trace("F 副翼 = 配平值", fcs, 20, { "fcs/aileron-cmd-norm": ailTrim });
  console.log(`  ${Math.abs(end) < 3 ? "→ 基本保持平飞：说明左倾就是“缺了这 0.44° 左副翼”" : "→ 仍在滚转：配平值不足以抵消"}`);
}
