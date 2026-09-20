// 复刻 adapter.browser.js 的加载方式（显式 moduleUrl/wasmUrl），验证该代码路径可用
import { JSBSimSdk } from "@0x62/jsbsim-wasm";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const P = "public/data/";
const sdk = await JSBSimSdk.create({
  moduleUrl: pathToFileURL(P + "jsbsim_wasm.mjs").href,
  wasmUrl: pathToFileURL(P + "jsbsim_wasm.wasm").href,
  log: { console: false, stripAnsi: true },
});
console.log("① 显式 URL 加载 WASM: OK");

for (const p of ["aircraft/c172p/c172p.xml", "aircraft/c172p/reset00.xml", "engine/eng_io320.xml", "engine/prop_75in2f.xml"]) {
  sdk.writeDataFile(p, readFileSync(P + p, "utf8"));
}
sdk.configurePaths({ rootDir: "/runtime", aircraftPath: "aircraft", enginePath: "engine", systemsPath: "systems" });
console.log("② 写入 MEMFS: OK");

sdk.loadModel("c172p");
console.log("③ loadModel('c172p'): OK");

sdk.setPropertyValue("ic/h-sl-ft", 3000);
sdk.setPropertyValue("ic/vc-kts", 110);
sdk.setPropertyValue("fcs/throttle-cmd-norm", 0.62);
sdk.setPropertyValue("propulsion/set-running", -1);
sdk.runIc();
for (let i = 0; i < 120; i++) sdk.run();
const g = (p) => sdk.getPropertyValue(p);
console.log("④ 发动机:", "RPM=" + g("propulsion/engine[0]/engine-rpm").toFixed(0),
            "推力=" + g("propulsion/engine[0]/thrust-lbs").toFixed(0) + "lbf");
console.log("⑤ 状态:", "h=" + g("position/h-sl-ft").toFixed(0) + "ft",
            "vc=" + g("velocities/vc-kts").toFixed(1) + "kt",
            "theta=" + g("attitude/theta-deg").toFixed(1) + "°");

// 复刻 main.js 的 physicsStep：写入舵面指令后必须真的改变飞行
sdk.setPropertyValue("fcs/elevator-cmd-norm", -0.3);   // 负=抬头
const th0 = g("attitude/theta-deg");
for (let i = 0; i < 120; i++) sdk.run();
const th1 = g("attitude/theta-deg");
console.log(`⑥ 闭环响应: 升降舵 -0.3 指令 1 秒后 θ 从 ${th0.toFixed(1)}° → ${th1.toFixed(1)}°  (Δ=${(th1-th0).toFixed(1)}°)`);
console.log(th1 > th0 ? "   ✓ 飞控指令确实改变了飞机姿态" : "   ✗ 未见响应，需排查");
sdk.destroy?.();
