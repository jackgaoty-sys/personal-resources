// 浏览器版 FDM 适配层
// 与 node 版逻辑一致，但机型数据用 fetch 从 public/data 取
//
// 注意（踩过的坑）：WASM 模块**不能**放在 public/ 里再用动态 import() 加载。
// Vite 会报 “This file is in /public ... should not be imported from source code”。
// 正确做法是用包自带的 /wasm 导出拿 URL（配合 vite.config 里的 optimizeDeps.exclude）。
import { JSBSimSdk } from "@0x62/jsbsim-wasm";
import { wasmBinaryUrl, wasmModuleUrl } from "@0x62/jsbsim-wasm/wasm";

export const STATE_PATHS = [
  "position/h-sl-ft", "position/h-agl-ft", "velocities/vc-kts", "velocities/vt-fps",
  "attitude/theta-deg", "attitude/phi-deg", "attitude/psi-deg",
  "aero/alpha-deg", "aero/beta-deg",
  "velocities/p-aero-rad_sec", "velocities/q-aero-rad_sec", "velocities/r-aero-rad_sec",
  "accelerations/n-pilot-z-norm", "velocities/mach",
  // 追加在末尾：3D 视景需要经纬度定位（原有下标不受影响）
  "position/lat-geod-deg", "position/long-gc-deg",
];
export const I = Object.fromEntries(STATE_PATHS.map((p, i) => [p, i]));

const DATA_FILES = [
  "aircraft/c172p/c172p.xml",
  "aircraft/c172p/reset00.xml",
  "engine/eng_io320.xml",
  "engine/prop_75in2f.xml",
];

export async function createFdm({ ic = {}, onLog } = {}) {
  const sdk = await JSBSimSdk.create({
    moduleUrl: wasmModuleUrl,
    wasmUrl: wasmBinaryUrl,
    log: { console: false, stripAnsi: true },
  });

  // 机型/发动机数据写入 WASM 虚拟文件系统
  for (const p of DATA_FILES) {
    // 子路径部署（如 /fcs-demo/）下写死的 "/data/…" 会 404，必须走 base
    const res = await fetch(`${import.meta.env.BASE_URL}data/${p}`);
    if (!res.ok) { onLog?.(`取数据失败: ${p}`); continue; }
    sdk.writeDataFile(p, await res.text());
  }
  sdk.configurePaths({
    rootDir: "/runtime", aircraftPath: "aircraft", enginePath: "engine", systemsPath: "systems",
  });
  sdk.loadModel("c172p");

  const defaults = {
    "ic/h-sl-ft": 4500, "ic/vc-kts": 110, "ic/theta-deg": 2,
    "ic/phi-deg": 0, "ic/psi-deg": 0, "ic/beta-deg": 0,
    "fcs/throttle-cmd-norm": 0.62,
    // 起点：纳帕谷（内陆丘陵葡萄园，陆地地形；高度留出地形余量）
    // 注意 reset00.xml 里的 <latitude> 并不生效，必须显式设 ic/lat-* / ic/long-gc-deg
    "ic/lat-geod-deg": 38.50, "ic/lat-gc-deg": 38.50, "ic/long-gc-deg": -122.35,
  };
  const icOverrides = { ...defaults, ...ic };
  const applyIc = () => {
    for (const [k, v] of Object.entries(icOverrides)) {
      try { sdk.setPropertyValue(k, v); } catch { /* 忽略 */ }
    }
    // 启动发动机：必须用 -1（启动全部）。传 +1 会被解释成"启动 1 号发动机"，
    // 而 c172 只有索引 0 一个发动机 → 发动机永远不转、飞机变无动力滑翔。
    try { sdk.setPropertyValue("propulsion/set-running", -1); } catch { }
    try { sdk.setPropertyValue("fcs/mixture-cmd-norm", 1.0); } catch { }
  };
  applyIc();
  sdk.runIc();

  const readState = (out = new Float64Array(STATE_PATHS.length)) => {
    for (let i = 0; i < STATE_PATHS.length; i++) {
      try { out[i] = sdk.getPropertyValue(STATE_PATHS[i]); } catch { out[i] = NaN; }
    }
    return out;
  };

  return {
    sdk, readState,
    get: (p) => { try { return sdk.getPropertyValue(p); } catch { return NaN; } },
    set: (p, v) => { try { sdk.setPropertyValue(p, v); } catch { /* 忽略 */ } },
    step: () => sdk.run(),
    reset: () => { try { sdk.resetToInitialConditions(2); applyIc(); sdk.runIc(); } catch { } },
  };
}

export function unpack(s) {
  return {
    h: s[I["position/h-sl-ft"]], hAgl: s[I["position/h-agl-ft"]],
    vc: s[I["velocities/vc-kts"]], vt: s[I["velocities/vt-fps"]],
    theta: s[I["attitude/theta-deg"]], phi: s[I["attitude/phi-deg"]], psi: s[I["attitude/psi-deg"]],
    alpha: s[I["aero/alpha-deg"]], beta: s[I["aero/beta-deg"]],
    p: s[I["velocities/p-aero-rad_sec"]], q: s[I["velocities/q-aero-rad_sec"]], r: s[I["velocities/r-aero-rad_sec"]],
    nz: s[I["accelerations/n-pilot-z-norm"]], mach: s[I["velocities/mach"]],
    lat: s[I["position/lat-geod-deg"]], lon: s[I["position/long-gc-deg"]],
  };
}
