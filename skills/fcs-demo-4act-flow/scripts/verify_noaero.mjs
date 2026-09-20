#!/usr/bin/env node
// 无气动模型的症状回归测试
// ══════════════════════════════════════════════════════════════════
// 为什么需要它：noaero.browser.js 的参数是【调出来的】，不是推导出来的。
// 尤其那两条反直觉的约束（滚转噪声必须低频、俯仰噪声必须高频），
// 一旦有人"顺手调大一点"，第 3 幕的症状会静默消失 —— 页面上看着还好好的，
// 但"乱飞"没了，演示当场就废了。所以要有东西能把它钉住。
//
// 做法：把 fcs-demo 的真实 FCS + 本包的假 FDM 接成闭环跑四场景，
//       检查症状是否落在【文档承诺的区间】内。
//
// 用法：
//   node verify_noaero.mjs --dir <fcs-demo>
//   node verify_noaero.mjs --dir <fcs-demo> --verbose
//
// 退出码：0 = 全部通过；1 = 有断言失败（说明参数被改动或上位代码变了）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const NOAERO_SRC = path.join(PKG, "assets/aero-toggle/src/fdm/noaero.browser.js");

const argv = process.argv.slice(2);
const i = argv.indexOf("--dir");
const DIR = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null;
const VERBOSE = argv.includes("--verbose");
if (!DIR) { console.error("用法: node verify_noaero.mjs --dir <fcs-demo 目录> [--verbose]"); process.exit(2); }

const DT = 1 / 120, RATE = 120, THROTTLE = 0.62;

// ── 症状区间（与 references/aero-toggle-spec.md §2 的实测值对应）──
// [最小, 最大]。留了余量，但窄到能抓住"症状消失"这类回归。
const EXPECT = {
  "A 松手 60s": {
    phiPP:      [20, 60],      // 坡度峰峰：太小=飞控按住了（乱飞消失），太大=要翻
    sinkFpm:    [-2100, -1300], // 下沉率
    protTags:   0,             // 松手时保护标签应为空
    crashed:    false,
  },
  "B 满杆拉到底 40s": {
    thetaAbsMax: [120, 181],   // 姿态应翻过去（180°）
    protTagsMin: 1,            // 保护标签应出现（LOAD/PITCH）
    sinkFpm:    [-2100, -1300],
    crashed:    false,
  },
  "C 压杆右滚 40s": {
    phiAbsMax:  [60, 181],     // 应能滚到 60° 以上
    mustTag:    "BANK",
    crashed:    false,
  },
  "D 松手 120s": {
    crashed:    false,         // 演示窗口必须 ≥ 2 分钟（"这一幕要讲得完"）
  },
};

// ── 搭临时闭环 ──
// 假 FDM 依赖 ./adapter.browser.js（拿 STATE_PATHS / I）与 fcs-demo 的 node_modules
// （adapter.browser.js 会 import @0x62/jsbsim-wasm）。所以在临时目录里拼出同样的相对结构。
function buildHarness() {
  const adapter = path.join(DIR, "src/fdm/adapter.browser.js");
  const fcs = path.join(DIR, "src/fcs/fcs.js");
  const nm = path.join(DIR, "node_modules");
  for (const [p, what] of [[adapter, "src/fdm/adapter.browser.js"], [fcs, "src/fcs/fcs.js"], [nm, "node_modules"]]) {
    if (!fs.existsSync(p)) { console.error(`fcs-demo 不完整，缺 ${what}：${p}`); process.exit(2); }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noaero-verify-"));
  fs.mkdirSync(path.join(tmp, "src/fdm"), { recursive: true });
  fs.copyFileSync(adapter, path.join(tmp, "src/fdm/adapter.browser.js"));
  fs.copyFileSync(NOAERO_SRC, path.join(tmp, "src/fdm/noaero.browser.js"));
  fs.symlinkSync(nm, path.join(tmp, "node_modules"), "dir");
  return { tmp, fcs };
}

async function simulate(makeStick, seconds, mod, unpackMod, FCS, LAW) {
  const fdm = await mod.createNoAeroFdm({});   // 注意：与真适配层一致，是 async 的
  const fcs = new FCS(LAW.NORMAL);
  let st = unpackMod.unpack(fdm.readState());
  const once = (sk) => {
    const u = fcs.update(st, sk, DT);
    fdm.set("fcs/throttle-cmd-norm", THROTTLE);
    fdm.set("fcs/elevator-cmd-norm", u.elev);
    fdm.set("fcs/aileron-cmd-norm", u.ail);
    fdm.set("fcs/rudder-cmd-norm", u.rud);
    fdm.set("fcs/pitch-trim-cmd-norm", u.trim);
    fdm.step(DT);
    st = unpackMod.unpack(fdm.readState());
  };
  for (let k = 0; k < 6 * RATE; k++) once({ pitch: 0, roll: 0, yaw: 0 });   // 配平 6s（同 main.js）
  const h0 = st.h, t0 = 6;
  let minT = 1e9, maxT = -1e9, minP = 1e9, maxP = -1e9, maxNz = -1e9;
  const prot = new Set();
  let crashAt = null, sample = [];
  for (let s = 0; s < seconds * RATE; s++) {
    once(makeStick(s / RATE));
    minT = Math.min(minT, st.theta); maxT = Math.max(maxT, st.theta);
    minP = Math.min(minP, st.phi);   maxP = Math.max(maxP, st.phi);
    maxNz = Math.max(maxNz, -st.nz);
    for (const t of fcs.protTags) if (t !== "FPA HOLD" && t !== "BANK HOLD") prot.add(t);
    if (st.h < 0 && crashAt === null) crashAt = t0 + s / RATE;
    if (s % (20 * RATE) === 0) sample.push(`T+${(t0 + s / RATE).toFixed(0)}s h=${st.h.toFixed(0)} θ=${st.theta.toFixed(0)}° φ=${st.phi.toFixed(0)}°`);
  }
  return {
    thetaPP: maxT - minT, thetaAbsMax: Math.max(Math.abs(minT), Math.abs(maxT)),
    phiPP: maxP - minP, phiAbsMax: Math.max(Math.abs(minP), Math.abs(maxP)),
    maxNz, protTags: [...prot].sort(), crashed: crashAt !== null, crashAt,
    sinkFpm: (st.h - h0) / seconds * 60, hEnd: st.h, sample,
  };
}

// ── 断言 ──
function check(name, spec, r) {
  const fails = [];
  const inRange = (v, [lo, hi]) => Number.isFinite(v) && v >= lo && v <= hi;
  if (spec.phiPP && !inRange(r.phiPP, spec.phiPP)) fails.push(`坡度峰峰 ${r.phiPP.toFixed(1)}° 不在 ${spec.phiPP}（松手不再乱飞，或已要翻过去）`);
  if (spec.phiAbsMax && !inRange(r.phiAbsMax, spec.phiAbsMax)) fails.push(`最大|坡度| ${r.phiAbsMax.toFixed(1)}° 不在 ${spec.phiAbsMax}`);
  if (spec.thetaAbsMax && !inRange(r.thetaAbsMax, spec.thetaAbsMax)) fails.push(`最大|俯仰| ${r.thetaAbsMax.toFixed(1)}° 不在 ${spec.thetaAbsMax}（拉杆没有把姿态翻过去）`);
  if (spec.sinkFpm && !inRange(r.sinkFpm, spec.sinkFpm)) fails.push(`下沉率 ${r.sinkFpm.toFixed(0)} fpm 不在 ${spec.sinkFpm}`);
  if (spec.protTags === 0 && r.protTags.length !== 0) fails.push(`松手时保护标签应为空，实际 [${r.protTags}]`);
  if (spec.protTagsMin && r.protTags.length < spec.protTagsMin) fails.push(`保护标签数 ${r.protTags.length} < ${spec.protTagsMin}（保护应被播报）`);
  if (spec.mustTag && !r.protTags.includes(spec.mustTag)) fails.push(`保护标签缺少 ${spec.mustTag}，实际 [${r.protTags}]`);
  if (spec.crashed === false && r.crashed) fails.push(`窗口内不应触地，实际 T+${r.crashAt.toFixed(0)}s`);
  return fails;
}

// ── 主 ──
const { tmp, fcs } = buildHarness();
let exitCode = 0;
try {
  const mod = await import(pathToFileURL(path.join(tmp, "src/fdm/noaero.browser.js")).href);
  const unpackMod = await import(pathToFileURL(path.join(tmp, "src/fdm/adapter.browser.js")).href);
  const { FCS, LAW } = await import(pathToFileURL(fcs).href);

  const SCENARIOS = [
    ["A 松手 60s", () => ({ pitch: 0, roll: 0, yaw: 0 }), 60],
    ["B 满杆拉到底 40s", () => ({ pitch: 1, roll: 0, yaw: 0 }), 40],
    ["C 压杆右滚 40s", () => ({ pitch: 0, roll: 1, yaw: 0 }), 40],
    ["D 松手 120s", () => ({ pitch: 0, roll: 0, yaw: 0 }), 120],
  ];

  console.log("无气动模型 · 症状回归测试");
  console.log(`fcs-demo: ${DIR}\n`);
  const rows = [];
  for (const [name, mk, secs] of SCENARIOS) {
    const r = await simulate(mk, secs, mod, unpackMod, FCS, LAW);
    const fails = check(name, EXPECT[name], r);
    rows.push({ name, r, fails });
    if (fails.length) exitCode = 1;
  }

  console.log("场景                     结果   坡度峰峰  最大|θ|  过载    保护标签            下沉(fpm)  触地");
  for (const { name, r, fails } of rows) {
    console.log(
      `${name.padEnd(24)} ${(fails.length ? "FAIL" : " ok ").padEnd(5)}  ` +
      `${r.phiPP.toFixed(0).padStart(6)}°  ${r.thetaAbsMax.toFixed(0).padStart(6)}°  ${r.maxNz.toFixed(2)}g  ` +
      `${(r.protTags.join(",") || "—").padEnd(18)}  ${r.sinkFpm.toFixed(0).padStart(7)}  ${r.crashed ? "T+" + r.crashAt.toFixed(0) + "s" : "未"}`
    );
  }

  if (VERBOSE) {
    console.log("\n轨迹采样：");
    for (const { name, r } of rows) console.log(`  ${name}\n    ${r.sample.join("\n    ")}`);
  }

  const allFails = rows.flatMap(({ name, fails }) => fails.map((f) => `${name}: ${f}`));
  if (allFails.length) {
    console.log("\n失败项：");
    for (const f of allFails) console.log("  ✗ " + f);
    console.log("\n常见原因：有人改了 noaero.browser.js 的 NOISE_*/DAMP/GAIN；或滚转噪声被改回高频。");
    console.log("详见 references/aero-toggle-spec.md §2「参数在哪调」的踩坑记录。");
  } else {
    console.log("\n全部通过 —— 第 3 幕的症状与文档承诺一致。");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
