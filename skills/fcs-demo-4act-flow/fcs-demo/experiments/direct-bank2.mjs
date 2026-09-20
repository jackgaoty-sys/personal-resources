// 收口实验：固定飞行状态（钉住 theta），单独看副翼 0 vs 配平值
// 先自动挑一个能稳住俯仰的比例-阻尼增益，再跑两种副翼设定。
import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";
import { FCS, LAW } from "../src/fcs/fcs.js";

const RATE = 120, DT = 1 / RATE, THROTTLE = 0.62;
const fdm = await createFdm();
const NEUTRAL = { pitch: 0, roll: 0, yaw: 0 };

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
  fdm.reset(); fcs.gammaRef = 0;
  for (let i = 0; i < 6 * RATE; i++) step(fcs, NEUTRAL);
}

// 配平起点
const seed = new FCS(LAW.NORMAL);
settle(seed);
const ailTrim = seed.lastOut.ail;
const theta0 = unpack(fdm.readState()).theta;
console.log(`配平起点: theta=${theta0.toFixed(2)}°  副翼配平=${ailTrim.toFixed(5)}  prop力矩=${fdm.get("moments/l-prop-lbsft").toFixed(1)} lb·ft\n`);

// 俯仰保持器：elev = Kp*(theta - theta0) + Kd*q  （负 elev = 抬头）
function holdTheta(Kp, Kd) {
  return (st) => ({ "fcs/elevator-cmd-norm": Math.max(-1, Math.min(1, Kp * (st.theta - theta0) + Kd * st.q)) });
}

// 自动挑增益：跑 8 秒看 theta 最大偏离
function thetaDev(Kp, Kd, ail) {
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  let maxDev = 0;
  const over = (st) => ({ ...holdTheta(Kp, Kd)(st), "fcs/aileron-cmd-norm": ail });
  for (let i = 0; i < 8 * RATE; i++) {
    const { st } = step(fcs, NEUTRAL, over);
    maxDev = Math.max(maxDev, Math.abs(st.theta - theta0));
  }
  return maxDev;
}

console.log("── 挑选俯仰保持器增益（目标：8s 内 theta 偏离最小）");
let best = null;
for (const Kp of [0.02, 0.04, 0.08, 0.12])
  for (const Kd of [0.0, 0.5, 1.0, 2.0]) {
    const dev = thetaDev(Kp, Kd, 0);
    if (!best || dev < best.dev) best = { Kp, Kd, dev };
    console.log(`  Kp=${Kp.toFixed(2)} Kd=${Kd.toFixed(1)}  → 最大偏离 ${dev.toFixed(2)}°`);
  }
console.log(`  选用 Kp=${best.Kp} Kd=${best.Kd}（偏离 ${best.dev.toFixed(2)}°）\n`);

// 正式对比
function run(label, ail, seconds = 20) {
  const fcs = new FCS(LAW.NORMAL); settle(fcs); fcs.setLaw(LAW.DIRECT);
  console.log(`── ${label}（副翼 cmd = ${ail.toFixed(5)}）`);
  console.log("   t(s)    phi(°)     p(rad/s)   theta(°)   beta(°)");
  let maxDev = 0;
  const over = (st) => ({ ...holdTheta(best.Kp, best.Kd)(st), "fcs/aileron-cmd-norm": ail });
  for (let i = 0; i < seconds * RATE; i++) {
    const { st } = step(fcs, NEUTRAL, over);
    maxDev = Math.max(maxDev, Math.abs(st.theta - theta0));
    if (i % (RATE * 4) === 0)
      console.log(`  ${(i * DT).toFixed(1).padStart(4)}  ${st.phi.toFixed(2).padStart(7)}  ${st.p.toFixed(5).padStart(9)}  ${st.theta.toFixed(2).padStart(8)}  ${st.beta.toFixed(3).padStart(7)}`);
  }
  const s = unpack(fdm.readState());
  console.log(`  → 终点 phi=${s.phi.toFixed(2)}°  theta=${s.theta.toFixed(2)}°（俯仰最大偏离 ${maxDev.toFixed(2)}°）\n`);
  return s.phi;
}

const phiZero = run("① 俯仰钉住 + 副翼 = 0（DIRECT 的真实状态）", 0);
const phiTrim = run("② 俯仰钉住 + 副翼 = 配平值", ailTrim);
const phiMore = run("③ 俯仰钉住 + 副翼 = 2× 配平值", ailTrim * 2);

console.log("═══ 结论 ═══");
console.log(`  固定飞行状态下，副翼 0      → 20s 滚到 ${phiZero.toFixed(1)}°`);
console.log(`  副翼 = 配平值(${ailTrim.toFixed(4)}) → ${phiTrim.toFixed(1)}°`);
console.log(`  副翼 = 2×配平值           → ${phiMore.toFixed(1)}°`);
console.log(`  → ${Math.abs(phiTrim) < 3 ? "配平副翼即可基本持平：左滚来源就是被 DIRECT 清零的这点左副翼" : "配平副翼不足以完全抵消，另有来源"}`);
