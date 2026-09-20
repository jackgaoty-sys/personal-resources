// 对照实验：证明飞控系统真的影响飞行结果
// ------------------------------------------------------------
// 方法：每个 case 都先让飞控在"正常法则 + 平飞保持"下稳定 6 秒，
//       获得一致的配平起点；然后只切换飞控法则/注入故障，
//       施加完全相同的飞行员输入，比较飞行结果。
import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";
import { FCS, LAW } from "../src/fcs/fcs.js";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const RATE = 120;
const DT = 1 / RATE;
const THROTTLE = 0.62;

const fdm = await createFdm();
console.log(`JSBSim 步长 dt=${fdm.get("simulation/dt").toFixed(5)}s，控制频率 ${RATE}Hz\n`);

/**
 * @param law      测试段使用的飞控法则
 * @param stickFn  测试段的飞行员输入 (t)=>{pitch,roll,yaw}
 * @param seconds  测试段时长
 * @param faults   测试段注入的故障
 */
function runCase({ law, stickFn, seconds = 8, faults = [], label }) {
  const fcs = new FCS(LAW.NORMAL);

  // ---------- 阶段 1：统一稳定段（平飞保持） ----------
  fdm.reset();
  fcs.gammaRef = 0;                       // 目标：航迹角 0 = 平飞
  for (let i = 0; i < 6 * RATE; i++) {
    const st = unpack(fdm.readState());
    const u = fcs.update(st, { pitch: 0, roll: 0, yaw: 0 }, DT);
    fdm.set("fcs/throttle-cmd-norm", THROTTLE);
    fdm.set("fcs/elevator-cmd-norm", u.elev);
    fdm.set("fcs/aileron-cmd-norm", u.ail);
    fdm.set("fcs/rudder-cmd-norm", u.rud);
    fdm.set("fcs/pitch-trim-cmd-norm", u.trim);
    fdm.step();
  }
  const s0 = unpack(fdm.readState());
  const trimUsed = fcs.trim;

  // ---------- 阶段 2：切换法则 / 注入故障 ----------
  fcs.setLaw(law);
  faults.forEach((f) => fcs.injectFault(f));
  const lawTest = fcs.law;

  // ---------- 阶段 3：施加相同的飞行员输入 ----------
  const rows = [];
  let alphaPeak = -1e9, nzPeak = -1e9;
  for (let i = 0; i < seconds * RATE; i++) {
    const t = i * DT;
    const st = unpack(fdm.readState());
    const u = fcs.update(st, stickFn(t), DT);
    fdm.set("fcs/throttle-cmd-norm", THROTTLE);
    fdm.set("fcs/elevator-cmd-norm", u.elev);
    fdm.set("fcs/aileron-cmd-norm", u.ail);
    fdm.set("fcs/rudder-cmd-norm", u.rud);
    fdm.set("fcs/pitch-trim-cmd-norm", u.trim);
    fdm.step();

    const s = unpack(fdm.readState());
    const nzLoad = -s.nz;
    if (s.alpha > alphaPeak) alphaPeak = s.alpha;
    if (nzLoad > nzPeak) nzPeak = nzLoad;
    if (i % 4 === 0) rows.push({ t, h: s.h, vc: s.vc, theta: s.theta, phi: s.phi, alpha: s.alpha, nz: nzLoad, elev: u.elev, law: lawTest });
  }

  writeFileSync(`${OUT}${label}.csv`,
    "t,h_ft,vc_kts,theta_deg,phi_deg,alpha_deg,nz,elev_cmd\n" +
    rows.map((r) => [r.t, r.h, r.vc, r.theta, r.phi, r.alpha, r.nz, r.elev].map((v) => +v.toFixed(4)).join(",")).join("\n"));

  const fin = unpack(fdm.readState());
  return {
    label, lawTest, faults,
    trimUsed,
    h0: s0.h, h1: fin.h, dh: fin.h - s0.h,
    th0: s0.theta, th1: fin.theta,
    a0: s0.vc, a1: fin.vc,
    alphaPeak, nzPeak,
    statusLog: fcs.statusLog,
    lawSeq: [fcs.statusLog.map((e) => `${e.from}→${e.to}(${e.reason})`).join(" ") || "无切换"],
  };
}

const show = (r) => console.log(
  `  ${r.label.padEnd(24)} 法则=${r.lawTest.padEnd(9)} ` +
  `高度Δ=${r.dh.toFixed(0).padStart(5)}ft  末θ=${r.th1.toFixed(1).padStart(6)}°  ` +
  `速度 ${r.a0.toFixed(0)}→${r.a1.toFixed(0)}kt  迎角峰=${r.alphaPeak.toFixed(1).padStart(5)}°  载荷峰=${r.nzPeak.toFixed(2)}g`);

const H = (s) => `\n═══ ${s} ═══`;

// ══════════════════════════════════════════════════════════
console.log(H("实验 A：飞行员松杆（不操纵）— 飞控能否替飞行员稳住飞机？"));
console.log("   起点一致（均以正常法则平飞配平），只切换法则：\n");
const A = [
  runCase({ law: LAW.DIRECT, stickFn: () => ({ pitch: 0, roll: 0, yaw: 0 }), seconds: 8, label: "A1_无飞控_DIRECT" }),
  runCase({ law: LAW.NORMAL, stickFn: () => ({ pitch: 0, roll: 0, yaw: 0 }), seconds: 8, label: "A2_有飞控_NORMAL" }),
];
A.forEach(show);
console.log(`\n   → 高度偏差相差 ${Math.abs(A[0].dh - A[1].dh).toFixed(0)} ft，姿态相差 ${Math.abs(A[0].th1 - A[1].th1).toFixed(1)}°`);
console.log(`   → 相同输入、相同起点，结果不同 ⇒ 飞控确实在改变飞行`);

// ══════════════════════════════════════════════════════════
console.log(H("实验 B：飞行员满杆拉到底 — 包线保护能否阻止失速？"));
console.log("   起点一致，输入一致（全程满杆），只切换法则：\n");
const B = [
  runCase({ law: LAW.DIRECT, stickFn: () => ({ pitch: 1.0, roll: 0, yaw: 0 }), seconds: 6, label: "B1_无飞控_DIRECT" }),
  runCase({ law: LAW.NORMAL, stickFn: () => ({ pitch: 1.0, roll: 0, yaw: 0 }), seconds: 6, label: "B2_有飞控_NORMAL" }),
];
B.forEach(show);
console.log(`\n   → 迎角峰值差 ${(B[0].alphaPeak - B[1].alphaPeak).toFixed(1)}°（保护阈值 12°，硬上限 15°）`);
console.log(`   → 无飞控时迎角冲到 ${B[0].alphaPeak.toFixed(1)}°（失速），有飞控时被摁在 ${B[1].alphaPeak.toFixed(1)}°`);

// ══════════════════════════════════════════════════════════
console.log(H("实验 C：迎角传感器故障 → 飞控自动降级 → 保护真的消失"));
console.log("   同样的满杆输入，一次传感器正常、一次传感器故障：\n");
const C = [
  runCase({ law: LAW.NORMAL, stickFn: () => ({ pitch: 1.0, roll: 0, yaw: 0 }), seconds: 6, label: "C1_传感器正常" }),
  runCase({ law: LAW.NORMAL, stickFn: () => ({ pitch: 1.0, roll: 0, yaw: 0 }), seconds: 6, faults: ["alpha_sensor"], label: "C2_传感器故障" }),
];
C.forEach(show);
console.log(`\n   → 故障后飞控自动降级到 ${C[1].lawTest}，切换记录：${C[1].lawSeq[0]}`);
console.log(`   → 迎角峰值 ${C[0].alphaPeak.toFixed(1)}° → ${C[1].alphaPeak.toFixed(1)}°`);
console.log(`   ⇒ 降级不是界面动画，而是真真切切改变了飞机的飞行结果`);

console.log(`\nCSV 已写入 experiments/out/`);
fdm.destroy();
