import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";
const fdm = await createFdm();
const val = (p) => { try { return fdm.get(p); } catch { return NaN; } };
const stat = (t) => { const s = unpack(fdm.readState());
  console.log(`${t.padEnd(26)} RPM=${String(val("propulsion/engine[0]/engine-rpm")).padStart(7)}  thrust=${String(val("propulsion/engine[0]/thrust-lbs")).padStart(9)}  vc=${s.vc.toFixed(1).padStart(6)}kt  h=${s.h.toFixed(0).padStart(5)}ft`); };
const run = (n) => { for (let i = 0; i < n; i++) fdm.step(); };

stat("初始（未启动）");
fdm.set("fcs/mixture-cmd-norm", 1.0);
fdm.set("fcs/throttle-cmd-norm", 0.75);
console.log("\n--- 用 propulsion/set-running = -1 ---");
try { fdm.set("propulsion/set-running", -1); console.log("  写入 -1 成功"); } catch (e) { console.log("  失败:", e.message); }
run(120); stat("启动后 1s");
run(240); stat("启动后 3s");
run(600); stat("启动后 8s");
console.log("\n--- 读回 ---");
for (const p of ["propulsion/engine[0]/engine-rpm","propulsion/engine[0]/thrust-lbs","propulsion/engine[0]/power-hp","propulsion/engine[0]/set-running"])
  console.log(`  ${p} = ${val(p)}`);
fdm.destroy();
