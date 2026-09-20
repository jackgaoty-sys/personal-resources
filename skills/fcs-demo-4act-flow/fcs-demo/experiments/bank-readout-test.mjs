import { classifyImpact, bankReadout, LIMITS } from "../src/fcs/consequences.js";

const rows = [];
const add = (vs, bank, pitch, note) => {
  const k = classifyImpact(vs, bank, pitch);
  const b = bankReadout(pitch, bank);
  rows.push({ note, vs, bank, pitch,
              分级: k, 坡度可用: b.usable, 记录坡度: b.deg });
};

console.log("阈值:", { bank: [LIMITS.bankMinorDeg, LIMITS.bankSevereDeg, LIMITS.bankDestroyedDeg],
                      vs: [LIMITS.vsMinor, LIMITS.vsSevere, LIMITS.vsDestroyed],
                      bankUsablePitchMaxDeg: LIMITS.bankUsablePitchMaxDeg });
console.log("\n--- 关键对照：同一个 60° 坡度，只因俯仰角不同 ---");
add(-0.5, 60, 0,    "平飞姿态接地，坡度60°");
add(-0.5, 60, -85,  "近垂直姿态（θ=-85°），同一个坡度60°");
console.log("\n--- 近垂直时只按垂直速度分级 ---");
add(-3.5, 5, -85, "近垂直 + vs=-3.5（应为 SEVERE）");
add(-3.5, 5, 0,   "平飞   + vs=-3.5（应为 SEVERE）");
add(-0.5, 5, -85, "近垂直 + 轻接地");
add(-6.5, 5, -85, "近垂直 + 重接地（应为 DESTROYED）");
add(-0.5, 30, -69, "θ=-69°（尚可用）坡度30°");
add(-0.5, 30, -71, "θ=-71°（已不可用）坡度30°");
console.table(rows);
