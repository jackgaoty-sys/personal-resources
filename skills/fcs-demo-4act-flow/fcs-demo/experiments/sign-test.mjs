// 实测舵面符号约定：正指令到底产生什么方向的力矩/运动
import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";

const fdm = await createFdm();
console.log("缺失属性:", fdm.missing.length ? fdm.missing.join(", ") : "无");

const base = () => {
  fdm.set("fcs/elevator-cmd-norm", 0); fdm.set("fcs/aileron-cmd-norm", 0);
  fdm.set("fcs/rudder-cmd-norm", 0); fdm.set("fcs/pitch-trim-cmd-norm", 0);
  fdm.reset();
  for (let i = 0; i < 120; i++) fdm.step();   // 1s 稳定
};

async function test(name, prop, value) {
  base();
  const s0 = unpack(fdm.readState());
  fdm.set(prop, value);
  for (let i = 0; i < 120; i++) fdm.step();   // 1s
  const s1 = unpack(fdm.readState());
  const d = (k) => (s1[k] - s0[k]).toFixed(3);
  console.log(`${name}: Δθ=${d("theta")}° Δq=${(s1.q - s0.q).toFixed(4)} Δφ=${d("phi")}° Δp=${(s1.p - s0.p).toFixed(4)} Δψ=${d("psi")}° Δr=${(s1.r - s0.r).toFixed(4)} ΔNz=${(s1.nz - s0.nz).toFixed(3)}`);
}

console.log("\n--- 基线（全零，1s 后）---");
base();
console.log(JSON.stringify(unpack(fdm.readState()), (k, v) => typeof v === "number" ? +v.toFixed(4) : v));

console.log("\n--- 单独施加正指令，观察 1 秒内增量 ---");
await test("elevator +0.3 (期望: 抬头? 低头?)", "fcs/elevator-cmd-norm", 0.3);
await test("elevator -0.3", "fcs/elevator-cmd-norm", -0.3);
await test("aileron  +0.3 (期望: 左滚? 右滚?)", "fcs/aileron-cmd-norm", 0.3);
await test("aileron  -0.3", "fcs/aileron-cmd-norm", -0.3);
await test("rudder   +0.3 (期望: 左偏? 右偏?)", "fcs/rudder-cmd-norm", 0.3);
fdm.destroy();
