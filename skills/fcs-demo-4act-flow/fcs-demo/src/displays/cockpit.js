// 玻璃座舱显示层（Canvas 2D）
// 颜色 token 照抄航空标准：绿=正常/接通 青=现用/目标 琥珀=注意/降级 红=警告
//
// 布局原则（踩过的坑）：
//   字号必须由 【画布宽度与高度的较小者】 推导，不能只按高度算。
//   窄高画布下若按 h 定字号，横向会严重溢出/重叠。
//   所有横向尺寸用统一单位 U = boxW/100，保证任何宽高比下比例一致。
export const C = {
  bg: "#05080d", panel: "#0a0f18", line: "#2a3646",
  sky: "#1E5B96", ground: "#6B4A2F",
  white: "#e8f0f8", dim: "#7d8fa4",
  green: "#00e676", cyan: "#00d9ff", amber: "#ffab00", red: "#ff3d3d",
};

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const glow = (ctx, c, b = 8) => { ctx.shadowColor = c; ctx.shadowBlur = b; };
const noglow = (ctx) => { ctx.shadowBlur = 0; };

/**
 * 选择不重叠的标注步长：保证 step/unitPerPx >= minGapPx
 */
function chooseStep(unitPerPx, minGapPx, candidates) {
  for (const s of candidates) if (s / unitPerPx >= minGapPx) return s;
  return candidates[candidates.length - 1];
}

// ════════════════════════════════════════════════════════════
// PFD
// ════════════════════════════════════════════════════════════
export function drawPFD(ctx, w, h, st, fcs, extra = {}) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);

  // ---- 统一基准：受宽高共同约束，居中放置 ----
  const boxW = Math.min(w, h * 0.82);
  const boxH = Math.min(h, boxW * 1.30);
  const x0 = (w - boxW) / 2;
  const y0 = (h - boxH) / 2;
  const U = boxW / 100;                       // 横向单位
  const fs = (n) => Math.max(6, n * U);       // 字号：由宽度推导

  const fTape = fs(5.2);     // 高度带/速度带数字
  const fFma = fs(5.0);      // FMA
  const fHdg = fs(4.4);      // 航向带
  const fData = fs(4.4);     // 底部数据块

  // 顶部三段分区：FMA(两行) → 航向带 → 姿态区。
  // 必须按字体实际高度算，不能拍一个固定比例：旧写法 fmaH = boxH*0.11，
  // 同时又把航向带塞进 fmaH 带内（stripY = tapeTop - fmaH*0.34），
  // 结果航向带与 FMA 两行完全叠在一起。实测 boxH=288 时：
  //   航向带占 y0+12.6…29.2，FMA 第二行（BANK HOLD · FPA HOLD）占 y0+22.0…30.0。
  const fTag = fs(3.4);                          // FMA 第二行字号
  const fmaLineH = fFma * 1.35;
  const fmaY = y0 + fFma * 0.9;                  // FMA 第一行中线
  const fmaBot = fmaY + fmaLineH + fTag * 0.6;   // 第二行下沿（无 tags 也占位，航向带不跳动）
  const hdgStripH = fHdg * 1.9;
  const stripY = fmaBot + hdgStripH * 0.5;       // 航向带中线
  const tapeTop = fmaBot + hdgStripH + fHdg * 0.2;
  const dataH = boxH * 0.14;
  const tapeBot = y0 + boxH - dataH;
  const tapeH = tapeBot - tapeTop;
  const tapeW = U * 16;
  const attX0 = x0 + tapeW, attX1 = x0 + boxW - tapeW;

  // ---- 姿态球 ----
  const cx = (attX0 + attX1) / 2, cy = (tapeTop + tapeBot) / 2;
  const degPx = tapeH / 40;                   // 纵向可见 ±20°
  ctx.save();
  ctx.beginPath(); ctx.rect(attX0, tapeTop, attX1 - attX0, tapeH); ctx.clip();
  ctx.translate(cx, cy); ctx.rotate(-st.phi * Math.PI / 180);
  const off = st.theta * degPx, big = boxW * 3;
  ctx.fillStyle = C.sky; ctx.fillRect(-big, -big + off, big * 2, big);
  ctx.fillStyle = C.ground; ctx.fillRect(-big, off, big * 2, big);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, U * 0.5);
  ctx.beginPath(); ctx.moveTo(-big, off); ctx.lineTo(big, off); ctx.stroke();
  ctx.font = `${fs(4.2)}px ${MONO}`; ctx.fillStyle = C.white;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const ladderStep = chooseStep(degPx, fs(4.2) * 1.6, [5, 10, 20]);
  for (let d = -60; d <= 60; d += ladderStep) {
    if (d === 0) continue;
    const y = off - d * degPx;
    const long = (d % (ladderStep * 2) === 0);
    const len = long ? (attX1 - attX0) * 0.30 : (attX1 - attX0) * 0.16;
    ctx.beginPath(); ctx.moveTo(-len, y); ctx.lineTo(len, y); ctx.stroke();
    if (long) ctx.fillText(String(Math.abs(d)), 0, y - fs(4.2) * 0.9);
  }
  ctx.restore();

  // ---- 滚转刻度 ----
  const R = Math.min((attX1 - attX0) / 2, tapeH / 2) * 0.86;
  ctx.save(); ctx.translate(cx, cy);
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(1, U * 0.4);
  for (let a = -60; a <= 60; a += 10) {
    const t = (a - 90) * Math.PI / 180, L = (a % 30 === 0) ? U * 3.2 : U * 1.8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(t) * R, Math.sin(t) * R);
    ctx.lineTo(Math.cos(t) * (R + L), Math.sin(t) * (R + L));
    ctx.stroke();
  }
  const tr = (st.phi - 90) * Math.PI / 180;
  ctx.fillStyle = C.amber;
  ctx.beginPath();
  ctx.moveTo(Math.cos(tr) * (R - U * 0.6), Math.sin(tr) * (R - U * 0.6));
  ctx.lineTo(Math.cos(tr - 0.05) * (R - U * 3.4), Math.sin(tr - 0.05) * (R - U * 3.4));
  ctx.lineTo(Math.cos(tr + 0.05) * (R - U * 3.4), Math.sin(tr + 0.05) * (R - U * 3.4));
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // ---- 固定机翼符号 ----
  const wing = (attX1 - attX0) * 0.22;
  ctx.strokeStyle = C.white; ctx.lineWidth = Math.max(2, U * 0.9);
  ctx.beginPath();
  ctx.moveTo(cx - wing, cy); ctx.lineTo(cx - wing * 0.32, cy);
  ctx.moveTo(cx + wing * 0.32, cy); ctx.lineTo(cx + wing, cy);
  ctx.stroke();
  ctx.fillStyle = C.white;
  ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.5, U * 0.7), 0, 7); ctx.fill();

  // ---- 速度带（左）----
  const vPerPx = 90 / tapeH;                  // 纵向可见 ±45kt
  const sLabelW = Math.max(...["000", "999"].map((s) => { ctx.font = `${fTape}px ${MONO}`; return ctx.measureText(s).width; }));
  const vStep = chooseStep(vPerPx, fTape * 1.7, [5, 10, 20, 50]);
  ctx.fillStyle = "rgba(5,8,13,0.86)"; ctx.fillRect(x0, tapeTop, tapeW, tapeH);
  ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.strokeRect(x0, tapeTop, tapeW, tapeH);
  ctx.save(); ctx.beginPath(); ctx.rect(x0, tapeTop, tapeW, tapeH); ctx.clip();
  ctx.font = `${fTape}px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let v = Math.ceil((st.vc - 45) / vStep) * vStep; v <= st.vc + 45; v += vStep) {
    const y = cy - (v - st.vc) / vPerPx;
    ctx.fillStyle = C.white; ctx.fillText(String(Math.round(v)), x0 + U * 1.2, y);
    ctx.strokeStyle = C.dim;
    ctx.beginPath(); ctx.moveTo(x0 + tapeW - U * 2.2, y); ctx.lineTo(x0 + tapeW - U * 0.5, y); ctx.stroke();
  }
  ctx.restore();
  glow(ctx, C.green, 6); ctx.fillStyle = C.green;
  ctx.fillRect(x0 - 2, cy - fTape * 0.85, tapeW + 4, fTape * 1.7); noglow(ctx);
  ctx.fillStyle = "#04120a"; ctx.font = `bold ${fTape}px ${MONO}`;
  ctx.textAlign = "center"; ctx.fillText(String(Math.round(st.vc)), x0 + tapeW / 2, cy);

  // ---- 高度带（右）----
  const ax = x0 + boxW - tapeW;
  const hPerPx = 800 / tapeH;                 // 纵向可见 ±400ft
  const aStep = chooseStep(hPerPx, fTape * 1.7, [50, 100, 200, 500]);
  ctx.fillStyle = "rgba(5,8,13,0.86)"; ctx.fillRect(ax, tapeTop, tapeW, tapeH);
  ctx.strokeStyle = C.line; ctx.strokeRect(ax, tapeTop, tapeW, tapeH);
  ctx.save(); ctx.beginPath(); ctx.rect(ax, tapeTop, tapeW, tapeH); ctx.clip();
  ctx.font = `${fTape}px ${MONO}`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = Math.ceil((st.h - 400) / aStep) * aStep; v <= st.h + 400; v += aStep) {
    const y = cy - (v - st.h) / hPerPx;
    ctx.fillStyle = C.white; ctx.fillText(String(Math.round(v)), ax + tapeW - U * 1.2, y);
    ctx.strokeStyle = C.dim;
    ctx.beginPath(); ctx.moveTo(ax + U * 0.5, y); ctx.lineTo(ax + U * 2.2, y); ctx.stroke();
  }
  ctx.restore();
  glow(ctx, C.green, 6); ctx.fillStyle = C.green;
  ctx.fillRect(ax - 2, cy - fTape * 0.85, tapeW + 4, fTape * 1.7); noglow(ctx);
  ctx.fillStyle = "#04120a"; ctx.font = `bold ${fTape}px ${MONO}`;
  ctx.textAlign = "center"; ctx.fillText(String(Math.round(st.h)), ax + tapeW / 2, cy);

  // ---- 航向带（顶，位于姿态区上方）----
  const stripW = (attX1 - attX0) * 0.98, sx = cx - stripW / 2;
  // stripY 已在顶部分区算好：位于 FMA 下方、姿态区上方
  const degPerPx = 80 / stripW;               // 可见 ±40°
  ctx.font = `${fHdg}px ${MONO}`;
  const hdgLabelW = ctx.measureText("000").width;
  const hStep = chooseStep(degPerPx, hdgLabelW * 1.15, [10, 20, 30, 45]);
  ctx.fillStyle = "rgba(5,8,13,0.75)"; ctx.fillRect(sx, stripY - fHdg * 0.8, stripW, fHdg * 1.6);
  ctx.save(); ctx.beginPath(); ctx.rect(sx, stripY - fHdg * 0.8, stripW, fHdg * 1.6); ctx.clip();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let d = -40; d <= 40; d += hStep) {
    const hdg = ((st.psi + d) % 360 + 360) % 360;
    ctx.fillStyle = C.white;
    ctx.fillText(String(Math.round(hdg / 10) * 10).padStart(3, "0"), cx + d / degPerPx, stripY);
  }
  ctx.restore();

  // ---- FMA：分两行，避免窄画布下横向溢出 ----
  const ann = fcs.annunciate();
  // fmaY 已在顶部分区算好
  const lawColor = ann.law === "NORMAL" ? C.green : ann.law === "ALTERNATE" ? C.amber : C.red;
  ctx.font = `bold ${fFma}px ${MONO}`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  glow(ctx, lawColor, 8); ctx.fillStyle = lawColor;
  ctx.fillText(ann.lawText, x0, fmaY); noglow(ctx);
  if (ann.protText) {
    ctx.textAlign = "right"; ctx.fillStyle = C.amber;
    ctx.fillText(ann.protText, x0 + boxW, fmaY);
  }
  if (ann.tags.length) {
    ctx.textAlign = "left"; ctx.fillStyle = C.cyan;
    ctx.font = `${fTag}px ${MONO}`;
    const avail = boxW, txt = ann.tags.join(" · ");
    let out = txt;
    while (out.length > 4 && ctx.measureText(out).width > avail) out = out.slice(0, -2);
    ctx.fillText(out === txt ? txt : out + "…", x0, fmaY + fFma * 1.35);
  }

  // ---- 数据块：3 列 × 2 行网格，宽度自适应 ----
  const nz = -st.nz;
  const items = [
    [`α ${st.alpha.toFixed(1)}°`, st.alpha > 12 ? C.amber : C.white],
    [`Nz ${nz.toFixed(2)}g`, (nz > 2.5 || nz < -1) ? C.amber : C.white],
    [`β ${st.beta.toFixed(1)}°`, (Math.abs(st.beta) > 5) ? C.amber : C.white],
    [`M ${st.mach.toFixed(2)}`, C.white],
    [`THR ${(extra.throttle ?? 0).toFixed(2)}`, C.sky],
    [`ψ ${Math.round(st.psi)}°`, (Math.abs(st.phi) > 30) ? C.amber : C.white],
  ];
  const cols = Math.max(2, Math.min(3, Math.floor(boxW / (fs(4.4) * 7))));
  const rows = Math.ceil(items.length / cols);
  const cw = boxW / cols, rh = Math.min(fData * 1.7, dataH / rows);
  ctx.font = `${fData}px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  items.forEach(([txt, col], i) => {
    const c = i % cols, r = Math.floor(i / cols);
    const px = x0 + c * cw;
    const py = tapeBot + rh * (r + 0.5);
    ctx.fillStyle = col;
    let s = txt;
    while (s.length > 3 && ctx.measureText(s).width > cw - U * 1.5) s = s.slice(0, -1);
    ctx.fillText(s, px, py);
  });

  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
}

// ════════════════════════════════════════════════════════════
// ECAM — F/CTL 页面
// ════════════════════════════════════════════════════════════
export function drawECAM(ctx, w, h, st, fcs, extra = {}) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);

  // 与 PFD 相同的基准原则：字号由宽度约束
  const pad = Math.min(w * 0.035, h * 0.05);
  const innerW = w - pad * 2;
  const fs = (n) => Math.max(6, innerW * n);
  const fTitle = fs(0.062), fRow = fs(0.046), fMsg = fs(0.05);

  const ann = fcs.annunciate();
  let y = pad + fTitle * 0.7;

  // 标题行
  ctx.font = `bold ${fTitle}px ${MONO}`;
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillStyle = C.white; ctx.fillText("F/CTL", pad, y);
  const lc = ann.law === "NORMAL" ? C.green : ann.law === "ALTERNATE" ? C.amber : C.red;
  const lawTxt = ann.lawText + (ann.protText ? " " + ann.protText : "");
  ctx.font = `${fRow}px ${MONO}`; ctx.textAlign = "right";
  glow(ctx, lc, 8); ctx.fillStyle = lc;
  ctx.fillText(lawTxt, w - pad, y); noglow(ctx);

  // 舵面条 + 油门
  // ⚠ 这个面板的标题是「主飞行显示 / 发动机与告警」，但原来这里【四条全是舵面】，
  //   一个发动机参数都没有——油门在画面上完全不可见。
  //   油门是 0..1 的单极性量，和舵面的 ±1 不能共用“居中零位”的画法，
  //   所以第 4 个元素标它是单极性：画法改为从左端起填、读数改百分比。
  const bars = [
    ["ELEV", extra.elev ?? 0, 25, 1],
    ["AIL", extra.ail ?? 0, 18, 1],
    ["RUD", extra.rud ?? 0, 16, 1],
    ["STAB", extra.trim ?? 0, 10, 1],
    ["THR", extra.throttle ?? 0, 1, 0],
  ];
  const labelW = fs(0.16), valW = fs(0.14);
  const barX = pad + labelW, barW = w - pad * 2 - labelW - valW;
  const rowH = (h - y - fMsg * 3.2) / bars.length;
  bars.forEach(([name, val, degMax, bipolar], i) => {
    const ry = y + fRow * 1.5 + rowH * (i + 0.5);
    ctx.font = `${fRow}px ${MONO}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = C.dim; ctx.fillText(name, pad, ry);
    const bh = Math.min(rowH * 0.5, fRow * 1.3);
    ctx.fillStyle = "#131c28"; ctx.fillRect(barX, ry - bh / 2, barW, bh);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.strokeRect(barX, ry - bh / 2, barW, bh);
    ctx.textAlign = "right";
    if (bipolar) {
      ctx.strokeStyle = C.dim;
      ctx.beginPath(); ctx.moveTo(barX + barW / 2, ry - bh / 2); ctx.lineTo(barX + barW / 2, ry + bh / 2); ctx.stroke();
      const mx = barX + ((val + 1) / 2) * barW;
      glow(ctx, C.cyan, 8); ctx.fillStyle = C.cyan;
      ctx.fillRect(mx - 2, ry - bh * 0.62, 4, bh * 1.24); noglow(ctx);
      ctx.fillStyle = C.white;
      ctx.fillText(`${(val * degMax).toFixed(0)}°`, w - pad, ry);
    } else {
      const v = Math.max(0, Math.min(1, val));
      glow(ctx, C.cyan, 8); ctx.fillStyle = C.cyan;
      ctx.fillRect(barX, ry - bh / 2, barW * v, bh); noglow(ctx);
      ctx.strokeStyle = C.line; ctx.strokeRect(barX, ry - bh / 2, barW, bh);
      ctx.fillStyle = C.white;
      ctx.fillText(`${Math.round(v * 100)}%`, w - pad, ry);
    }
  });

  // 故障 / 提示行（底对齐，短标签 + 自动换行，避免窄画布下被截断丢信息）
  const FAULT_SHORT = {
    alpha_sensor: "α SEN", ahrs: "AHRS", elevator_actuator: "ELEV ACT",
    aileron_jam: "AIL JAM", rudder_jam: "RUD JAM",
  };
  const words = ann.faults.length
    ? ["FAULT", ...ann.faults.map((f) => FAULT_SHORT[f] || f.toUpperCase())]
    : ["NO FAULT"];

  const lines = [];
  let cur = "";
  for (const wd of words) {
    const t = cur ? cur + " " + wd : wd;
    if (ctx.measureText(t).width <= innerW || !cur) cur = t;
    else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);

  const lineH = fRow * 1.35;
  // 先画 CAS 提示（在故障行之上）
  if (extra.casMsg) {
    ctx.fillStyle = extra.casMsg.level === "warn" ? C.red : C.amber;
    const cw = [];
    let cc = "";
    for (const ch of extra.casMsg.text) { if (ctx.measureText(cc + ch).width > innerW) { cw.push(cc); cc = ch; } else cc += ch; }
    if (cc) cw.push(cc);
    cw.slice(0, 2).forEach((L, i) => ctx.fillText(L, pad, h - pad - lineH * (lines.length + cw.slice(0, 2).length - i) + lineH * 0.2));
  }
  // 再画故障行（从底部往上堆）
  ctx.font = `${fRow}px ${MONO}`;
  ctx.fillStyle = ann.faults.length ? C.amber : C.green;
  if (ann.faults.length) glow(ctx, C.amber, 8);
  lines.forEach((L, i) => {
    ctx.fillText(L, pad, h - pad - lineH * (lines.length - 1 - i));
  });
  noglow(ctx);
}

// ════════════════════════════════════════════════════════════
// 简化外部视景
// ════════════════════════════════════════════════════════════
export function drawExternal(ctx, w, h, st) {
  const hz = h * 0.5 + st.theta * (h / 60);
  const g = ctx.createLinearGradient(0, 0, 0, Math.max(1, hz));
  g.addColorStop(0, "#0b2f52"); g.addColorStop(1, "#7fb6dd");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, Math.max(0, hz));
  const g2 = ctx.createLinearGradient(0, hz, 0, h);
  g2.addColorStop(0, "#5c6b3a"); g2.addColorStop(1, "#22301a");
  ctx.fillStyle = g2; ctx.fillRect(0, hz, w, h - hz);

  ctx.save();
  ctx.translate(w / 2, hz); ctx.rotate(-st.phi * Math.PI / 180); ctx.translate(-w / 2, -hz);
  ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-w, hz); ctx.lineTo(w * 2, hz); ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1;
  for (let i = -8; i <= 8; i++) {
    if (i === 0) continue;
    const y = hz + i * i * (i > 0 ? 1 : -1) * (h / 34);
    ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w * 2, y); ctx.stroke();
  }
  ctx.restore();

  // HUD 角标（字号同样由宽度约束，避免窄视口溢出）
  const f = Math.max(9, Math.min(w, h) * 0.055);
  ctx.font = `bold ${f}px ${MONO}`;
  ctx.textBaseline = "top"; ctx.fillStyle = "rgba(0,217,255,0.92)";
  ctx.textAlign = "left";
  const l1 = `PITCH ${st.theta.toFixed(1)}°`, l2 = `ROLL ${st.phi.toFixed(1)}°`;
  const r1 = `${st.vc.toFixed(0)} KT`, r2 = `${st.h.toFixed(0)} FT`;
  const lw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width);
  const rw = Math.max(ctx.measureText(r1).width, ctx.measureText(r2).width);
  const gap = w * 0.04;
  if (lw + rw + gap * 2 <= w) {
    ctx.textAlign = "left"; ctx.fillText(l1, gap, h * 0.03); ctx.fillText(l2, gap, h * 0.03 + f * 1.3);
    ctx.textAlign = "right"; ctx.fillText(r1, w - gap, h * 0.03); ctx.fillText(r2, w - gap, h * 0.03 + f * 1.3);
  } else {
    // 太窄就只显示一行，避免互相压字
    ctx.textAlign = "left"; ctx.fillText(l1, gap, h * 0.03);
    ctx.textAlign = "right"; ctx.fillText(r1, w - gap, h * 0.03);
  }

  // 机体符号
  const sc = Math.min(w, h) * 0.22;
  ctx.save();
  ctx.translate(w / 2, h * 0.74);
  ctx.rotate(st.phi * Math.PI / 180 * 0.6);
  ctx.strokeStyle = "rgba(230,240,250,0.9)";
  ctx.lineWidth = Math.max(2, sc * 0.03);
  ctx.beginPath();
  ctx.moveTo(0, -sc * 0.10); ctx.lineTo(0, sc * 0.10);
  ctx.moveTo(-sc * 0.5, 0); ctx.lineTo(sc * 0.5, 0);
  ctx.moveTo(-sc * 0.25, sc * 0.09); ctx.lineTo(sc * 0.25, sc * 0.09);
  ctx.stroke();
  ctx.restore();
}
