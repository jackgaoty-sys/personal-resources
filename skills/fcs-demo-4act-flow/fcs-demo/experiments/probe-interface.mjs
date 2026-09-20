// 探针：验证 JSBSim WASM 在 Node 下可用，并实测飞控接口的单位映射
import { JSBSimSdk } from "@0x62/jsbsim-wasm";
import { wasmBinaryUrl, wasmModuleUrl } from "@0x62/jsbsim-wasm/wasm";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, "vendor", "jsbsim");

const sdk = await JSBSimSdk.create({
  moduleUrl: wasmModuleUrl,
  wasmUrl: wasmBinaryUrl,
  log: { console: false, stripAnsi: true },
});

// --- 把机型/发动机数据写入 MEMFS ---
const files = [
  ["aircraft/c172p/c172p.xml", "aircraft/c172p/c172p.xml"],
  ["aircraft/c172p/reset00.xml", "aircraft/c172p/reset00.xml"],
  ["engine/eng_io320.xml", "engine/eng_io320.xml"],
  ["engine/prop_75in2f.xml", "engine/prop_75in2f.xml"],
];
for (const [memPath, diskRel] of files) {
  const abs = join(VENDOR, diskRel);
  if (!existsSync(abs)) { console.log("!! 缺失", diskRel); continue; }
  sdk.writeDataFile(memPath, readFileSync(abs, "utf8"));
}
console.log("MEMFS 数据写入完成");

sdk.configurePaths({
  rootDir: "/runtime",
  aircraftPath: "aircraft",
  enginePath: "engine",
  systemsPath: "systems",
});

sdk.loadModel("c172p");
console.log("机型加载 OK");
sdk.runIc();
console.log("runIc OK");

// --- 探针 1：列出 fcs/ 下所有可写属性 ---
const catalog = sdk.queryPropertyCatalog("fcs/");
const names = catalog.split("\n").map(s => s.trim()).filter(Boolean);
console.log("\n=== fcs/ 属性总数:", names.length, "===");
const interesting = names.filter(n =>
  /cmd-norm|pos-deg|pos-rad|pos-norm|trim/.test(n));
console.log("=== 舵面/指令相关属性 ===");
console.log(interesting.join("\n"));

// --- 探针 2：实测指令 → 舵面 的映射 ---
console.log("\n=== 实测 elevator-cmd-norm → 舵面 映射 ===");
const probe = ["fcs/elevator-cmd-norm", "fcs/elevator-pos-deg", "fcs/elevator-pos-norm",
  "fcs/aileron-cmd-norm", "fcs/left-aileron-pos-deg", "fcs/rudder-cmd-norm", "fcs/rudder-pos-deg"];
for (const cmd of [-1, -0.5, 0, 0.5, 1]) {
  sdk.setPropertyValue("fcs/elevator-cmd-norm", cmd);
  sdk.setPropertyValue("fcs/aileron-cmd-norm", cmd);
  sdk.setPropertyValue("fcs/rudder-cmd-norm", cmd);
  sdk.run();
  const row = probe.map(p => {
    let v; try { v = sdk.getPropertyValue(p); } catch { v = NaN; }
    return `${p.split("/").pop()}=${Number(v).toFixed(4)}`;
  });
  console.log(`cmd=${String(cmd).padStart(5)} | ${row.join("  ")}`);
}

console.log("\n=== 探针完成 ===");
sdk.destroy?.();
