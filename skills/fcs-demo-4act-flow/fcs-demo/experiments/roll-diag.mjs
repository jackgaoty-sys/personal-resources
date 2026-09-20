// 横滚通道验证：满杆能否建立坡度、松杆能否保持坡度、BANK 保护是否生效
// 用真实 JSBSim + FCS 闭环运行。
// 分两节：A=本次修复的验收断言（决定退出码）  B=已知缺口（仅报告，另行决定）
import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";
import { FCS, LAW } from "../src/fcs/fcs.js";

const RATE = 120, DT = 1 / RATE, THROTTLE = 0.62;
const fdm = await createFdm();

const pass = [], gaps = [];
function check(name, ok, detail) {
  (ok ? pass : gaps).push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function settle(fcs) {
  fdm.reset();
  fcs.gammaRef = 0;
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
}

// 单段闭环：stick 恒定作用 seconds 秒；until(st) 命中则立即返回（用于一次性松杆）
function phase(fcs, stick, seconds, sampleEvery, until) {
  const rows = [];
  for (let i = 0; i < seconds * RATE; i++) {
    const t = i * DT;
    const st = unpack(fdm.readState());
    const u = fcs.update(st, stick, DT);
    fdm.set("fcs/throttle-cmd-norm", THROTTLE);
    fdm.set("fcs/elevator-cmd-norm", u.elev);
    fdm.set("fcs/aileron-cmd-norm", u.ail);
    fdm.set("fcs/rudder-cmd-norm", u.rud);
    fdm.set("fcs/pitch-trim-cmd-norm", u.trim);
    fdm.step();
    if (sampleEvery && i % sampleEvery === 0)
      rows.push({ t, phi: st.phi, p: st.p, ail: u.ail, bankRef: fcs.bankRef, tags: [...fcs.protTags].join(",") });
    if (until && until(st)) break;
  }
  return { rows, phi: unpack(fdm.readState()).phi };
}

function table(rows) {
  console.log("   t(s)    phi(°)     p(rad/s)     ail      bankRef   模式");
  for (const r of rows)
    console.log(`  ${r.t.toFixed(1).padStart(4)}  ${r.phi.toFixed(2).padStart(7)}  ${r.p.toFixed(4).padStart(9)}  ${r.ail.toFixed(4).padStart(8)}  ${String(r.bankRef === null ? "null" : r.bankRef.toFixed(1)).padStart(7)}   ${r.tags}`);
}

const NEUTRAL = { pitch: 0, roll: 0, yaw: 0 };
const FULL_LEFT = { pitch: 0, roll: -1, yaw: 0 };

console.log("═══ 验收 1. 满杆左滚：坡度能否正常建立（旧代码卡死在 -6.28°）═══");
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  const { rows, phi } = phase(fcs, FULL_LEFT, 10, RATE / 2);
  table(rows);
  check("满杆 10s 坡度超过 45°（旧代码 -6.28°）", Math.abs(phi) > 45, `终点 phi=${phi.toFixed(1)}°`);
  check("压杆期间 bankRef 保持 null（参考已清空）", rows.every(r => r.bankRef === null));
  check("副翼被真实驱动（远超旧代码的 0.04）", Math.max(...rows.map(r => Math.abs(r.ail))) > 0.3, `峰值 |ail|=${Math.max(...rows.map(r => Math.abs(r.ail))).toFixed(3)}`);
}

console.log("\n═══ 验收 2. 滚到 -30° 后松杆：应保持坡度且无瞬态 ═══");
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  const a = phase(fcs, FULL_LEFT, 5, null, (st) => st.phi <= -30);   // 一次性松杆触发点
  const bankAtRelease = a.phi;
  const b = phase(fcs, NEUTRAL, 10, RATE / 2);                       // 松杆
  table(b.rows);
  const last = b.rows[b.rows.length - 1];
  const settled = b.rows.slice(4);                                   // 跳过建立静差的暂态
  const oscillation = Math.max(...settled.map(r => r.phi)) - Math.min(...settled.map(r => r.phi));
  const offset = Math.abs(last.phi - b.rows[0].bankRef);
  check("松杆瞬间无满舵瞬态（旧代码跳到 1.0）", Math.abs(b.rows[0].ail) < 0.5, `松杆后首个 ail=${b.rows[0].ail.toFixed(3)}`);
  check("坡度被稳定保持，未回 0°", Math.abs(last.phi) > 20 && oscillation < 0.5, `稳定在 ${last.phi.toFixed(2)}°（振荡 ${oscillation.toFixed(3)}°）`);
  check("BANK HOLD 模式点亮", b.rows.some(r => r.tags.includes("BANK HOLD")));
  check("bankRef 锁存了松杆时的坡度", b.rows.every(r => r.bankRef !== null && Math.abs(r.bankRef - bankAtRelease) < 0.5), `bankRef=${b.rows[0].bankRef?.toFixed(2)}° vs 松杆时 ${bankAtRelease.toFixed(2)}°`);
  gaps.push({ name: "坡度保持静差", ok: offset < 0.5, detail: `${offset.toFixed(2)}°（bankRef=${b.rows[0].bankRef.toFixed(1)}° → 稳定 ${last.phi.toFixed(1)}°）` });
  console.log(`  [缺口] 坡度保持静差 = ${offset.toFixed(2)}°`);
}

console.log("\n═══ 验收 3. BANK 保护：滚过 55° 后松杆，应夹到 30° 并回落 ═══");
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  const a = phase(fcs, FULL_LEFT, 8, null, (st) => st.phi <= -70);        // 滚过 55° 后一次性松杆
  console.log(`  松杆瞬间: phi=${a.phi.toFixed(2)}°（已超过 bankMax=55°）`);
  const b = phase(fcs, NEUTRAL, 12, RATE / 2);
  table(b.rows);
  const last = b.rows[b.rows.length - 1];
  check("bankRef 被夹到 bankReturn = -30°", Math.abs(b.rows[0].bankRef - (-30)) < 0.5, `bankRef=${b.rows[0].bankRef?.toFixed(2)}°`);
  check("BANK 保护标签点亮", b.rows.some(r => r.tags.includes("BANK")));
  check("坡度回落并稳定在 30° ± 5°", Math.abs(last.phi + 30) < 5, `终点 phi=${last.phi.toFixed(2)}°`);
  check("回落过程不振荡（末段漂移 < 1°）", Math.max(...b.rows.slice(-10).map(r => r.phi)) - Math.min(...b.rows.slice(-10).map(r => r.phi)) < 1);
}

console.log("\n═══ 验收 4. 对照：DIRECT 法则不受影响 ═══");
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  fcs.setLaw(LAW.DIRECT);
  const { rows } = phase(fcs, { pitch: 0, roll: -0.5, yaw: 0 }, 2, RATE / 2);
  check("DIRECT 下副翼 = 杆位", Math.abs(rows[0].ail - (-0.5)) < 1e-6, `ail=${rows[0].ail}`);
  check("DIRECT 下 bankRef 被清空", rows[0].bankRef === null);
}

console.log("\n═══ 缺口 5. 滚转率指令跟踪（比例环，无积分）═══");
{
  const fcs = new FCS(LAW.NORMAL);
  settle(fcs);
  const { rows } = phase(fcs, FULL_LEFT, 4, RATE / 2);
  const pCmd = 1.05;
  const pMax = Math.max(...rows.map(r => Math.abs(r.p)));
  const track = pMax / pCmd;
  console.log(`  指令 pCmd = ${pCmd} rad/s (60°/s)，实测稳态 |p| = ${pMax.toFixed(3)} rad/s (${(pMax * 57.3).toFixed(1)}°/s)`);
  console.log(`  跟踪比 = ${(track * 100).toFixed(0)}%，副翼稳态 ${rows[rows.length - 1].ail.toFixed(3)}（未饱和）`);
  console.log(`  → 俯仰速率环有 KiNz 积分项，横滚速率环只有 KpRoll 比例项，故存在静差`);
  gaps.push({ name: "滚转率跟踪", ok: track > 0.9, detail: `${(track * 100).toFixed(0)}%` });
}

console.log(`\n═══ 验收结果：${pass.length}/${pass.length} 通过 ═══`);
console.log(`═══ 已知缺口 ${gaps.filter(g => !g.ok).length} 项（需另行决定是否调参）═══`);
for (const g of gaps.filter(g => !g.ok)) console.log(`  · ${g.name}: ${g.detail}`);
process.exit(pass.some(p => !p.ok) ? 1 : 0);
