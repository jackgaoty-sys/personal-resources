// 时间历程条带图
// ══════════════════════════════════════════════════════════════════
// 设计取舍：
//   · 多条曲线**叠加**显示，每条各自自适应量程 → 纵向空间利用率高。
//     代价是不同量纲不能直接比高低，所以右侧图例必须把"当前值+量程"写清楚。
//   · 顶部额外画一条【法则时间带】：0=NORMAL 绿 / 1=ALTN 琥珀 / 2=DIRECT 红。
//     法则什么时候降级、降了几级，一眼可见——这是纯曲线给不了的信息。
//   · 事件打点在底部，颜色随严重度，位置对齐时间轴。
//   · 降采样：点数超过画布宽度 2 倍时按步长抽稀，避免每帧上万个 lineTo。

import { IDX, LAW_NAME } from "../rec/recorder.js";

export const TRACE_COLOR = {
  h: "#00d9ff", vc: "#ffab00", vs: "#00e676",
  alpha: "#ff3d3d", beta: "#ff5cf0", nz: "#00d9ff",
  theta: "#ffab00", phi: "#00e676", psi: "#b388ff",
  elev: "#00d9ff", ail: "#ffab00", rud: "#ff5cf0", trim: "#00e676",
  thr: "#00e676",
};

// 分组：一次只看一组，比 15 条线全糊在一起可读得多
export const GROUPS = {
  "纵剖": ["h", "vc", "vs"],
  "气动": ["alpha", "beta", "nz"],
  "姿态": ["theta", "phi", "psi"],
  // 飞控 = 操纵输入。油门同样是操纵输入，之前它根本没被录下来过
  "飞控": ["elev", "ail", "rud", "thr"],
};

const LABEL = { h: "高度", vc: "空速", vs: "升降率", alpha: "迎角α", beta: "侧滑β",
  nz: "过载nz", theta: "俯仰θ", phi: "坡度φ", psi: "航向ψ",
  elev: "升降舵", ail: "副翼", rud: "方向舵", trim: "配平", thr: "油门" };
const UNIT = { h: " m", vc: " kt", vs: " m/s", alpha: "°", beta: "°", nz: "g",
  theta: "°", phi: "°", psi: "°", elev: "", ail: "", rud: "", trim: "", thr: "" };

const LAW_COLOR = ["rgba(0,230,118,.75)", "rgba(255,171,0,.75)", "rgba(255,61,61,.75)"];
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * @param ctx   已按 dpr 设好 transform 的 2D 上下文
 * @param rec   Recorder 实例
 * @param opts  { window, keys, events, tailOnly }
 */
export function drawTrend(ctx, w, h, rec, opts = {}) {
  const win = opts.window ?? 120;
  const keys = opts.keys ?? GROUPS["气动"];
  const events = opts.events ?? [];

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(3,6,11,.55)";
  ctx.fillRect(0, 0, w, h);

  const legendW = Math.min(150, Math.max(96, w * 0.17));
  const padL = 6, padR = legendW + 6;
  const bandH = 7;                        // 法则带高度
  const evH = 9;                          // 事件打点带高度
  const axisH = 12;                       // 时间轴高度
  const top = 4 + bandH + 3;
  const plotH = Math.max(10, h - top - evH - axisH - 4);
  const plotW = Math.max(10, w - padL - padR);

  ctx.font = `10px ${MONO}`;
  ctx.textBaseline = "middle";

  if (rec.count < 2) {
    ctx.fillStyle = "#7d8fa4";
    ctx.textAlign = "center";
    ctx.fillText("等待时间历程数据…", w / 2, h / 2);
    return;
  }

  const tEnd = rec.get(rec.count - 1, "t");
  const tStart = Math.max(rec.get(0, "t"), tEnd - win);
  const span = Math.max(1e-6, tEnd - tStart);
  const [i0, i1] = rec.window(tStart, tEnd + 1e-9);
  const n = Math.max(0, i1 - i0);
  const X = (t) => padL + ((t - tStart) / span) * plotW;

  // ── 法则时间带 ──
  const by = 4;
  ctx.fillStyle = "rgba(255,255,255,.06)";
  ctx.fillRect(padL, by, plotW, bandH);
  if (n > 0) {
    let runStart = i0, runLaw = rec.get(i0, "law");
    for (let i = i0 + 1; i <= i1; i++) {
      const law = i < i1 ? rec.get(i, "law") : -999;
      if (law !== runLaw) {
        const x0 = X(rec.get(runStart, "t"));
        const x1 = i < i1 ? X(rec.get(i, "t")) : X(tEnd);
        ctx.fillStyle = LAW_COLOR[runLaw] ?? "rgba(120,140,160,.5)";
        ctx.fillRect(x0, by, Math.max(0.7, x1 - x0), bandH);
        runStart = i; runLaw = law;
      }
    }
  }
  ctx.fillStyle = "#7d8fa4";
  ctx.textAlign = "left";
  ctx.fillText(`法则带 ${LAW_NAME[Math.round(rec.get(rec.count - 1, "law"))] ?? "?"}`, padL + plotW - 92, by + bandH / 2);

  // ── 网格 ──
  ctx.strokeStyle = "rgba(120,150,190,.12)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 2; g++) {
    const y = Math.round(top + (plotH * g) / 2) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
  }

  // ── 曲线 ──
  const step = Math.max(1, Math.floor(n / Math.max(1, plotW * 2)));
  const legend = [];
  for (const k of keys) {
    const col = TRACE_COLOR[k] ?? "#ffffff";
    let [mn, mx] = rec.range(k, i0, i1);
    const rawMn = mn, rawMx = mx;          // 未加 padding 的真量程，留给图例显示
    if (!Number.isFinite(mn)) continue;
    if (mx - mn < 1e-6) { mn -= 0.5; mx += 0.5; }
    else { const pd = (mx - mn) * 0.08; mn -= pd; mx += pd; }
    const Y = (v) => top + plotH - ((v - mn) / (mx - mn)) * plotH;

    // 零线（量程跨零时才画，否则纯噪声）
    if (mn < 0 && mx > 0) {
      ctx.strokeStyle = "rgba(160,190,220,.20)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, Y(0)); ctx.lineTo(padL + plotW, Y(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = i0; i < i1; i += step) {
      const v = rec.get(i, k);
      if (!Number.isFinite(v)) continue;
      const x = X(rec.get(i, "t")), y = Y(v);
      if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; }
    }
    // 末端补一个精确点，避免抽稀把当前值截掉
    const lastV = rec.get(rec.count - 1, k);
    if (Number.isFinite(lastV)) ctx.lineTo(X(tEnd), Y(lastV));
    ctx.stroke();

    // 坑：这里原来又调了两次 rec.range(k,i0,i1)，等于同一条曲线把整个时间窗扫了 3 遍。
    // 窗口内最多 ~7200 点，3 条曲线 → 每帧 2 万多次 get()。复用上面的结果即可。
    legend.push({ k, col, cur: lastV, mn: rawMn, mx: rawMx });
  }

  // ── 事件打点 ──
  const ey = top + plotH + 2;
  ctx.fillStyle = "rgba(255,255,255,.05)";
  ctx.fillRect(padL, ey, plotW, evH);
  for (const e of events) {
    if (e.t < tStart || e.t > tEnd) continue;
    const col = e.color || "#7d8fa4";
    ctx.fillStyle = col;
    ctx.fillRect(X(e.t) - 0.5, ey, 1.2, evH);
  }

  // ── 时间轴 ──
  const ay = ey + evH + axisH / 2;
  ctx.fillStyle = "#7d8fa4";
  ctx.textAlign = "center";
  for (let g = 0; g <= 4; g++) {
    const t = tStart + (span * g) / 4;
    ctx.fillText(`T+${t.toFixed(0)}s`, X(t), ay);
  }

  // ── 图例（右侧，含当前值与量程）──
  ctx.textAlign = "left";
  const lx = padL + plotW + 8;
  const rowH = Math.min(15, Math.max(10, h / Math.max(4, legend.length + 1)));
  let ly = top + 2;
  for (const L of legend) {
    ctx.fillStyle = L.col;
    ctx.fillRect(lx, ly + rowH / 2 - 1.5, 6, 3);
    ctx.fillStyle = "#cfdcea";
    ctx.fillText(LABEL[L.k] ?? L.k, lx + 10, ly + rowH / 2);
    ctx.fillStyle = L.col;
    const txt = (Number.isFinite(L.cur) ? L.cur.toFixed(Math.abs(L.cur) < 10 ? 2 : 1) : "—") + (UNIT[L.k] ?? "");
    ctx.textAlign = "right";
    ctx.fillText(txt, w - 6, ly + rowH / 2);
    ctx.textAlign = "left";
    ly += rowH;
  }
}
