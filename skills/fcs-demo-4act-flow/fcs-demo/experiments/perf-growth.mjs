// 性能增长探针：模拟「一次飞行」全过程，在多个时间点测量关键路径耗时与结构规模。
// 目的：把「越来越卡」定位到具体环节，而不是靠猜。
import { createFdm, unpack } from "../src/fdm/jsbsimAdapter.js";
import { FCS, LAW } from "../src/fcs/fcs.js";
import { Recorder, IDX, N_FIELDS, LAW_CODE } from "../src/rec/recorder.js";
import { EventLog } from "../src/rec/eventlog.js";
import { drawTrend, GROUPS } from "../src/displays/trend.js";
import { createCanvas } from "@napi-rs/canvas";

const RATE = 120, DT = 1 / RATE, THROTTLE = 0.62, FT2M = 0.3048;
const fdm = await createFdm();
const fcs = new FCS(LAW.NORMAL);
const rec = new Recorder({ capacity: 36000, every: 2, physicsRate: RATE });
const log = new EventLog({ capacity: 800 });
const rowBuf = new Float64Array(N_FIELDS);
const MODE_TAGS = new Set(["BANK HOLD", "FPA HOLD"]);
let evMarkers = [];

// 用与 main.js 相同尺寸的时间历程画布
const cv = createCanvas(1400, 152);
const ctx = cv.getContext("2d");

function drawTrendTimed(n = 5) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++)
    drawTrend(ctx, 1400, 152, rec, { window: 120, keys: GROUPS["气动"], events: evMarkers });
  return (performance.now() - t0) / n;
}

function recRangeAccurate() {
  // 对照：rec.range 的原始成本（trend 现在每帧调 3 次/key）
  const t0 = performance.now();
  for (const k of GROUPS["气动"]) { rec.range(k, 0, rec.count); }
  return performance.now() - t0;
}

// ---------- 逐帧推进（复刻 main.js 的 observe 路径）----------
let simT = 0, prevHm = null, vs = 0, prevMode = "", prevProt = "", dropped = 0;
fcs.gammaRef = 0;
let logPushes = 0;

function step() {
  const st = unpack(fdm.readState());
  const stick = { pitch: 0, roll: 0, yaw: 0 };
  const u = fcs.update(st, stick, DT);
  fdm.set("fcs/throttle-cmd-norm", THROTTLE);
  fdm.set("fcs/elevator-cmd-norm", u.elev);
  fdm.set("fcs/aileron-cmd-norm", u.ail);
  fdm.set("fcs/rudder-cmd-norm", u.rud);
  fdm.set("fcs/pitch-trim-cmd-norm", u.trim);
  fdm.step();
  const st2 = unpack(fdm.readState());

  const hm = st2.h * FT2M;
  if (prevHm !== null) vs = (hm - prevHm) / DT;
  prevHm = hm;
  rowBuf[IDX.t] = simT; rowBuf[IDX.h] = hm; rowBuf[IDX.vc] = st2.vc; rowBuf[IDX.vs] = vs;
  rowBuf[IDX.alpha] = st2.alpha; rowBuf[IDX.beta] = st2.beta; rowBuf[IDX.nz] = -st2.nz;
  rowBuf[IDX.theta] = st2.theta; rowBuf[IDX.phi] = st2.phi; rowBuf[IDX.psi] = st2.psi;
  rowBuf[IDX.elev] = u.elev; rowBuf[IDX.ail] = u.ail; rowBuf[IDX.rud] = u.rud; rowBuf[IDX.trim] = u.trim;
  rowBuf[IDX.law] = LAW_CODE[fcs.law] ?? 0;
  rec.pushRow(rowBuf);

  const tags = [...fcs.protTags];
  const modeStr = tags.filter((t) => MODE_TAGS.has(t)).sort().join("+");
  const protStr = tags.filter((t) => !MODE_TAGS.has(t)).sort().join("+");
  if (modeStr !== prevMode) { if (log.push(simT, "mode", `模式：${modeStr || "—"}`, 3)) logPushes++; prevMode = modeStr; }
  if (protStr !== prevProt) {
    if (protStr) { if (log.push(simT, "alert", `保护介入：${protStr}`, 2.5)) logPushes++; }
    else if (prevProt) { if (log.push(simT, "info", `保护退出：${prevProt}`, 2.5)) logPushes++; }
    prevProt = protStr;
  }
  // 模拟 paintLog：日志变化时重建 evMarkers
  evMarkers = log.items.map((e) => ({ t: e.t, color: "#fff" }));

  simT += DT;
}

console.log("飞行时间    rec.count   log.count  evMarkers   drawTrend(ms)  range全扫(ms)  单步物理(ms)");
console.log("─".repeat(95));
const CHECK = [10, 30, 60, 120, 180, 300, 420, 600];
for (const target of CHECK) {
  // 推进到目标时间
  while (simT < target - 1e-9) step();
  // 测单步物理耗时
  const tp = performance.now();
  for (let i = 0; i < 240; i++) step();
  const perStep = (performance.now() - tp) / 240;
  const dtr = drawTrendTimed();
  const rr = recRangeAccurate();
  console.log(
    `${String(target).padStart(6)}s  ${String(rec.count).padStart(9)}  ${String(log.count).padStart(9)}  ${String(evMarkers.length).padStart(9)}  ` +
    `${dtr.toFixed(3).padStart(13)}  ${rr.toFixed(3).padStart(12)}  ${perStep.toFixed(4).padStart(12)}`
  );
}
console.log(`\n日志累计写入次数（有界的去重后）: ${logPushes}`);
