// 两条 FDM 通路的对照 —— Node 侧（走 vendor/jsbsim 的数据）
// 与应用【完全相同的初始条件】+ 开环固定操纵，便于逐位比对
import { createFdm, I } from "../src/fdm/jsbsimAdapter.js";

const fdm = await createFdm({ ic: {
  "ic/h-sl-ft": 4500, "ic/vc-kts": 110, "ic/theta-deg": 2,
  "ic/phi-deg": 0, "ic/psi-deg": 0, "ic/beta-deg": 0,
  "fcs/throttle-cmd-norm": 0.62,
  "ic/lat-geod-deg": 38.50, "ic/lat-gc-deg": 38.50, "ic/long-gc-deg": -122.35,
}});

const RATE = 120;
const set = () => {
  fdm.set("fcs/elevator-cmd-norm", -0.2);
  fdm.set("fcs/aileron-cmd-norm", 0.05);
  fdm.set("fcs/rudder-cmd-norm", 0);
  fdm.set("fcs/pitch-trim-cmd-norm", 0);
  fdm.set("fcs/throttle-cmd-norm", 0.62);
};
const sample = (t) => {
  const s = fdm.readState();
  return [t, +s[I["position/h-sl-ft"]].toFixed(4), +s[I["velocities/vc-kts"]].toFixed(5),
          +s[I["attitude/theta-deg"]].toFixed(6), +s[I["attitude/phi-deg"]].toFixed(6),
          +s[I["aero/alpha-deg"]].toFixed(6), +s[I["accelerations/n-pilot-z-norm"]].toFixed(8)];
};
set();
const rows = [sample(0)];
for (let t = 5; t <= 30; t += 5) {
  for (let i = 0; i < 5 * RATE; i++) { set(); fdm.step(); }
  rows.push(sample(t));
}
console.log("列: [t, h_ft, vc_kt, theta, phi, alpha, nz]");
for (const r of rows) console.log(JSON.stringify(r));
