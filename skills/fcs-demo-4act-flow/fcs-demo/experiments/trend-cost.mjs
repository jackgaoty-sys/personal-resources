// 确定性验证：数一次 drawTrend 里 rec.get() 的调用次数。
// 计时受系统噪声影响太大（同一份代码能测出 7ms 和 70ms），
// 而调用次数是确定值，可以直接对比去重前后的开销。
import { createCanvas } from "@napi-rs/canvas";
import { Recorder, IDX, N_FIELDS, LAW_CODE } from "../src/rec/recorder.js";
import { drawTrend, GROUPS } from "../src/displays/trend.js";

const N = 60;
const rec = new Recorder({ capacity: 36000, every: 2, physicsRate: 120 });
const row = new Float64Array(N_FIELDS);
for (let i = 0; i < N * 60 * 2; i++) {          // 灌满 60s 数据
  row[IDX.t] = i / 120;
  row[IDX.h] = 1000 + Math.sin(i / 300) * 50;
  row[IDX.vc] = 110 + Math.cos(i / 400) * 5;
  row[IDX.vs] = Math.sin(i / 200);
  row[IDX.alpha] = 3 + Math.sin(i / 250);
  row[IDX.beta] = Math.sin(i / 350);
  row[IDX.nz] = 1 + Math.sin(i / 180) * 0.1;
  row[IDX.theta] = 2; row[IDX.phi] = 0; row[IDX.psi] = 180;
  row[IDX.elev] = 0.1; row[IDX.ail] = 0.02; row[IDX.rud] = 0; row[IDX.trim] = 0;
  row[IDX.law] = 0;
  rec.pushRow(row);
}
console.log(`rec.count = ${rec.count}（约 ${(rec.count / 60).toFixed(0)}s 数据）`);

// 灌到接近满缓冲，看“窗口”与“全缓冲”两种口径的差别
const cv = createCanvas(1400, 152);
const ctx = cv.getContext("2d");
const KEYS = GROUPS["气动"];                     // 3 条曲线

// ---- 统计 get() 调用次数 ----
function countGets(fn) {
  let n = 0;
  const orig = rec.get.bind(rec);
  rec.get = (...a) => { n++; return orig(...a); };
  fn();
  rec.get = orig;
  return n;
}

const win = 120;
const tEnd = rec.get(rec.count - 1, "t");
const tStart = Math.max(rec.get(0, "t"), tEnd - win);
const [i0, i1] = rec.window(tStart, tEnd + 1e-9);
const winPts = i1 - i0;

const newGets = countGets(() =>
  drawTrend(ctx, 1400, 152, rec, { window: win, keys: KEYS, events: [] }));

// 旧代码：图例那行额外调了两次 rec.range(k, i0, i1)，每次都是整窗扫描
const oldExtra = KEYS.length * 2 * winPts;

console.log(`\n时间窗内点数 n = ${winPts}`);
console.log(`曲线数 = ${KEYS.length}`);
console.log(`\n修复后：drawTrend 一次 = ${newGets.toLocaleString()} 次 get()`);
console.log(`旧代码额外多出：${oldExtra.toLocaleString()} 次 get()（图例重复调 range ${KEYS.length}×2 次整窗扫描）`);
console.log(`修复前 = 约 ${(newGets + oldExtra).toLocaleString()} 次 get()`);
console.log(`单次重绘减少 ${(100 * oldExtra / (newGets + oldExtra)).toFixed(0)}%`);
console.log(`\n再叠加 15Hz 节流（原 60Hz）：每秒 get() 从约 ${((newGets + oldExtra) * 60).toLocaleString()} 降到 ${(newGets * 15).toLocaleString()}`);
console.log(`→ 每秒约减少 ${((1 - (newGets * 15) / ((newGets + oldExtra) * 60)) * 100).toFixed(0)}%`);
