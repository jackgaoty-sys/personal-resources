// JSBSim 适配层：把 SDK 包成一个稳定的 step/read/write 接口
// 关键：read 用 PropertyBatch 批量取，避免逐属性查属性树（实测差 25 倍）
import { JSBSimSdk, TrimMode, ResetToInitialConditionsMode } from "@0x62/jsbsim-wasm";
import { wasmBinaryUrl, wasmModuleUrl } from "@0x62/jsbsim-wasm/wasm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "vendor", "jsbsim");

// 每步要读的状态量（顺序与 STATE 一致）
export const STATE_PATHS = [
  "position/h-sl-ft",            // 0 气压高度 ft
  "position/h-agl-ft",           // 1 离地高度 ft
  "velocities/vc-kts",           // 2 空速 kt
  "velocities/vt-fps",           // 3 真空速 ft/s
  "attitude/theta-deg",          // 4 俯仰角 deg
  "attitude/phi-deg",            // 5 滚转角 deg
  "attitude/psi-deg",            // 6 航向 deg
  "aero/alpha-deg",              // 7 迎角 deg
  "aero/beta-deg",               // 8 侧滑角 deg
  "velocities/p-aero-rad_sec",   // 9 滚转角速率 rad/s
  "velocities/q-aero-rad_sec",   // 10 俯仰角速率 rad/s
  "velocities/r-aero-rad_sec",   // 11 偏航角速率 rad/s
  "accelerations/n-pilot-z-norm",// 12 飞行员处法向过载 g
  "velocities/mach",             // 13 马赫
];
export const I = Object.fromEntries(STATE_PATHS.map((p, i) => [p, i]));

export async function createFdm({ aircraft = "c172p", ic = {} } = {}) {
  const sdk = await JSBSimSdk.create({
    moduleUrl: wasmModuleUrl, wasmUrl: wasmBinaryUrl,
    log: { console: false, stripAnsi: true },
  });
  const files = [
    `aircraft/${aircraft}/${aircraft}.xml`,
    `aircraft/${aircraft}/reset00.xml`,
    "engine/eng_io320.xml", "engine/prop_75in2f.xml",
  ];
  for (const p of files) {
    try { sdk.writeDataFile(p, readFileSync(join(VENDOR, p), "utf8")); } catch { /* 可选文件 */ }
  }
  sdk.configurePaths({ rootDir: "/runtime", aircraftPath: "aircraft", enginePath: "engine", systemsPath: "systems" });
  sdk.loadModel(aircraft);

  // 空中初始条件（默认 3000ft / 110kt 平飞）
  const defaults = { "ic/h-sl-ft": 3000, "ic/vc-kts": 110, "ic/theta-deg": 2, "ic/phi-deg": 0, "ic/psi-deg": 0, "ic/beta-deg": 0, "fcs/throttle-cmd-norm": 0.75 };
  const icOverrides = { ...defaults, ...ic };
  const applyIc = () => {
    for (const [k, v] of Object.entries(icOverrides)) {
      try { sdk.setPropertyValue(k, v); } catch { /* 忽略不存在的 */ }
    }
    // 启动发动机。注意：必须是 -1（"启动全部"）；传 +1 会被当成"启动 1 号发动机"，
    // 而 c172 只有索引 0 一个发动机，结果是发动机永远不转、飞机变成无动力滑翔。
    try { sdk.setPropertyValue("propulsion/set-running", -1); } catch { }
    try { sdk.setPropertyValue("fcs/mixture-cmd-norm", 1.0); } catch { }
  };
  applyIc();
  sdk.runIc();

  // 批量读取器（建在 loadModel 之后）
  let batch = null, missing = [];
  try {
    batch = sdk.createPropertyBatch(STATE_PATHS);
    batch.read();                       // 触发一次，暴露缺失路径
    missing = batch.missing ? Array.from(batch.missing) : [];
  } catch (e) { console.log("PropertyBatch 不可用，回退逐属性读:", e.message); }

  const readState = (out = new Float64Array(STATE_PATHS.length)) => {
    if (batch) { const v = batch.read(); out.set(v.subarray(0, out.length)); return out; }
    for (let i = 0; i < STATE_PATHS.length; i++) {
      try { out[i] = sdk.getPropertyValue(STATE_PATHS[i]); } catch { out[i] = NaN; }
    }
    return out;
  };

  return {
    sdk,
    readState,
    get: (p) => { try { return sdk.getPropertyValue(p); } catch { return NaN; } },
    set: (p, v) => { try { sdk.setPropertyValue(p, v); } catch { /* 忽略 */ } },
    step: () => sdk.run(),
    trim: (mode = TrimMode.tLongitudinal) => { try { sdk.setTrimMode(mode); sdk.doTrim(mode); sdk.runIc(); return true; } catch { return false; } },
   // reset 会用 IC 文件覆盖初始条件，所以必须重新施加我们的覆盖值
    reset: () => { try { sdk.resetToInitialConditions(ResetToInitialConditionsMode.DONT_EXECUTE_RUN_IC); applyIc(); sdk.runIc(); } catch { } },
    missing,
    destroy: () => sdk.destroy?.(),
  };
}

// 便捷：把状态数组解成命名对象
export function unpack(s) {
  return {
    h: s[I["position/h-sl-ft"]], hAgl: s[I["position/h-agl-ft"]],
    vc: s[I["velocities/vc-kts"]], vt: s[I["velocities/vt-fps"]],
    theta: s[I["attitude/theta-deg"]], phi: s[I["attitude/phi-deg"]], psi: s[I["attitude/psi-deg"]],
    alpha: s[I["aero/alpha-deg"]], beta: s[I["aero/beta-deg"]],
    p: s[I["velocities/p-aero-rad_sec"]], q: s[I["velocities/q-aero-rad_sec"]], r: s[I["velocities/r-aero-rad_sec"]],
    nz: s[I["accelerations/n-pilot-z-norm"]], mach: s[I["velocities/mach"]],
  };
}
