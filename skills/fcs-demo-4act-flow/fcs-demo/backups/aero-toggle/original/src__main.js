// 主循环：定步长物理 + rAF 渲染 + 键盘/按钮输入
// ══════════════════════════════════════════════════════════════════
// v3 改造（四件事，都来自对同类实现的对比分析）：
//   ① 时间历程录制 + 条带图    —— 补可观测性（此前 Kbeta 那类横航向错误只能靠肉眼发现）
//   ② 持久化分级事件日志        —— fcs.statusLog 早就在记，只是从没被画出来
//   ③ 满屏 3D + 半透明可折叠浮层 —— 改掉"3D 被关在网格格子里"
//   ④ 场景预设 / 倍速 / CSV 导出 —— 演示效率与可归档
import { createFdm, unpack } from "./fdm/adapter.browser.js";
import { FCS, LAW, DAMAGE_AUTH } from "./fcs/fcs.js";
import { Consequences, HULL, HULL_LABEL, flightStateOf } from "./fcs/consequences.js";
import { drawPFD, drawECAM, drawExternal } from "./displays/cockpit.js";
import { createScene3D } from "./scene/scene3d.js";
import { drawTrend, GROUPS } from "./displays/trend.js";
import { Recorder, IDX, N_FIELDS, LAW_CODE } from "./rec/recorder.js";
import { EventLog, LEVEL } from "./rec/eventlog.js";

const RATE = 120, DT = 1 / RATE, FT2M = 0.3048;
// 油门：初始杆位与行程速率。
// 速率原来是写死的 0.004/物理步，@120Hz 即 0.48/秒 —— 这里提成常量，
// 因为【暂停时也要用同一速率】积分（见 frame() 的暂停分支），两处必须一致。
// 注：与 fdm/adapter.browser.js 里的初始条件 0.62 保持同值。
const THROTTLE_INIT = 0.62;
const THROTTLE_RATE = 0.48;      // 每秒油门行程
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- 显示适配（处理高 DPI）----------
function fit(cv) {
  if (!cv) return { ctx: null, w: 0, h: 0 };
  // 用布局尺寸而不是 getBoundingClientRect()：座舱视角给面板加了 CSS 透视变换，
  // 而 getBoundingClientRect() 返回的是【变换后的投影】尺寸，会让画布分辨率算错、
  // 传给 drawPFD 的 w/h 也会跟着错。offsetWidth/Height 不受 transform 影响。
  const w = cv.offsetWidth, h = cv.offsetHeight;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (w < 8 || h < 8) return { ctx: null, w: 0, h: 0 };   // 面板收起时直接跳过
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

// ---------- 键盘 ----------
const keys = new Set();
addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
  if (e.repeat) return;          // 长按不重复触发离散动作（否则 R/C/空格 会连发）
  if (e.code === "KeyR") app.reset();
  if (e.code === "KeyC") cycleCam();
  if (e.code === "Space") togglePause();
  if (e.code === "KeyV") toggleGhost();
});
addEventListener("keyup", (e) => keys.delete(e.code));
const held = (...cs) => cs.some((c) => keys.has(c));

function readStick() {
  // 约定：pitch>0 = 拉杆抬头；roll>0 = 右滚；yaw>0 = 右偏航
  const pitch = (held("KeyS", "ArrowDown") ? 1 : 0) + (held("KeyW", "ArrowUp") ? -1 : 0);
  const roll = (held("KeyD", "ArrowRight") ? 1 : 0) + (held("KeyA", "ArrowLeft") ? -1 : 0);
  const yaw = (held("KeyE") ? 1 : 0) + (held("KeyQ") ? -1 : 0);
  return { pitch, roll, yaw };
}

// ---------- 场景预设 ----------
// 一次点击 = 一次完整的演示运行：重置飞机 → 施加一组故障 → 从零开始记录。
// 好处是演示"故障 → 法则降级 → 保护介入"的连锁反应只需要点一下，
// 而不是现场按 5 个按钮。
const PRESETS = [
  { id: "normal", name: "正常法则（基线）",            faults: [] },
  { id: "alpha",  name: "α 传感器失效 → ALTN LAW",     faults: ["alpha_sensor"] },
  { id: "ahrs",   name: "AHRS 失效 → DIRECT LAW",      faults: ["ahrs"] },
  { id: "elev",   name: "升降舵作动器降级（35% 权限）", faults: ["elevator_actuator"] },
  { id: "ail",    name: "副翼卡阻",                    faults: ["aileron_jam"] },
  { id: "rud",    name: "方向舵卡阻",                  faults: ["rudder_jam"] },
  { id: "multi",  name: "多重故障（AHRS + 副翼卡阻）",  faults: ["ahrs", "aileron_jam"] },
];
const FAULT_BTNS = [["fAlpha", "alpha_sensor"], ["fAhrs", "ahrs"], ["fElev", "elevator_actuator"],
                    ["fAil", "aileron_jam"], ["fRud", "rudder_jam"]];
const SPEEDS = [1, 2, 4, 8];
const COLLAPSIBLE = ["logPanel", "instPanel", "trendPanel"];
// fcs.protTags 里混着两类东西，日志必须分开：
//   · FPA HOLD / BANK HOLD = 正常的飞行指引模式（松杆时本来就在工作）
//   · ALPHA PROT / LOAD / PITCH / BANK / ALPHA MAX = 真正的包线保护
// 不分开的话，一上电就会报“保护介入”，把正常工作状态说成告警。
const MODE_TAGS = new Set(["FPA HOLD", "BANK HOLD"]);

// ---------- 应用状态 ----------
const app = {
  fdm: null, fcs: new FCS(LAW.NORMAL), initLaw: LAW.NORMAL, throttle: THROTTLE_INIT,
  st: null, out: { elev: 0, ail: 0, rud: 0, trim: 0 },
  prevSt: null, alpha: 0,
  cas: null, casUntil: 0,
  paused: false, rate: 1,
  ghostFdm: null, ghostSt: null, ghostPrevSt: null, ghostDirect: false,
  // 幽灵机有【自己独立的】后果系统：它飞的是无增稳无保护的路子，
  // 完全可能它已经失速/超载受损，而真机被包线保护得好好的。
  // 两机共用一份状态的话，这个对比就不存在了。
  ghostCon: new Consequences(), ghostVs: 0, ghostPrevHm: null,
  con: new Consequences(),          // 后果系统：失速 / 超限 / 触地
  hullLabel: HULL_LABEL.INTACT,
  scene: null, use3d: false, ext2d: null,
  simT: 0, vs: 0, prevHm: null, aglM: null,
  rec: new Recorder({ capacity: 36000, every: 2, physicsRate: RATE }),
  log: new EventLog({ capacity: 800 }),
  trendGroup: "气动",
  evMarkers: [], logSeq: -1, lastLogPaint: 0, lastTrendPaint: 0, lastClockPaint: 0, lastBoundsPaint: 0,
  lastClock: "", lastBadge: "", lastBadgeCls: "", lastProt: "", lastAnnun: "",
  annunHold: {},          // 瞬时告警的最短驻留截止时刻（见 updateAnnunciator）
  prevProt: "", prevPhase: "", prevMode: "", lawSeen: 0,

  reset() {
    this.fdm.reset();
    if (this.ghostFdm) this.ghostFdm.reset();
    this.simT = 0; this.vs = 0; this.prevHm = null;
    this.ghostCon.reset(); this.ghostVs = 0; this.ghostPrevHm = null;
    // 油门也要归位：否则先按 G 收了油门再按 R，新一次运行会带着旧油门起飞，
    // 而 FDM 的初始条件明明是 0.62 —— “重置”语义上应当回到初值。
    this.throttle = THROTTLE_INIT;
    this.annunHold = {};         // 新一次运行不该带着上一次的告警驻留
    this.rec.clear();
    this.log.clear();
    this.logSeq = -1; this.lawSeen = 0; this.prevProt = ""; this.prevPhase = ""; this.prevMode = "";
    this.con.reset();
    this.hullLabel = HULL_LABEL.INTACT;
    if (this.scene?.clearCrash) this.scene.clearCrash();
    hideCrashOverlay();          // 重新开始 → 解除终止态与控件锁定
    setPaused(false);            // “开始新一次运行”不应该停在冻结状态
    // ── 故障注入按钮的高亮，属于【本次运行的状态】，必须跟 FCS 一起归零 ──
    // 注意：reset() 内部的 trimThenOpen() 会重建 FCS，故障实际上是清掉的；
    // 但这段清理原来只写在 reset / crashRestart 两个【按钮】的 handler 里，
    // 于是两条路径会留下假高亮：
    //   ① 键盘 R（第 50 行）　② 切换开局法则（initLaw.onchange）
    // 后果是屏幕上写着“已注入故障”、实际没有 —— 正好反着骗人。
    // 收进这里，让五条重置路径共用同一处，不再各写一份。
    for (const [id] of FAULT_BTNS) $(id).classList.remove("on");
    // 先记“开新一次运行”再配平：否则配平过程产生的日志（t≈0）会排在它前面，
    // 读起来像“先自己动了再重置”。
    this.log.push(0, "info", "开始新一次运行（4500ft 初始条件）", 0);
    const trim = this.trimThenOpen(4);
    this.log.push(this.simT, "info", `平飞配平完成（配平量 ${trim.toFixed(3)}）`, 0);
    if (this.initLaw !== LAW.NORMAL) this.log.push(this.simT, "mode", `开局法则 ${this.initLaw}（配平量已保留）`, 0);
  },
  say(text, level = "info") {
    this.cas = { text, level };
    this.casUntil = performance.now() + 4000;
    if (this.log) this.log.push(this.simT, level, text, 0);
  },
};

// ---------- 物理步 ----------
const rowBuf = new Float64Array(N_FIELDS);

// 把 fcs.statusLog 里尚未播报的法则变更刷进事件日志。
// 独立成函数的原因：预设施加故障后必须**立即**冲刷，
// 否则“当前法则 DIRECT”会排在“法则 NORMAL → DIRECT”前面，时序读起来是反的。
function drainLawEvents() {
  while (app.lawSeen < app.fcs.statusLog.length) {
    const s = app.fcs.statusLog[app.lawSeen++];
    app.log.push(app.simT, "mode", `法则 ${s.from} → ${s.to}（${s.reason}）`, 0);
  }
}

function observe() {
  const st = app.st, u = app.out;
  if (!st) return;
  const hm = st.h * FT2M;
  if (app.prevHm !== null) app.vs = (hm - app.prevHm) / DT;
  app.prevHm = hm;

  rowBuf[IDX.t] = app.simT;
  rowBuf[IDX.h] = hm;
  rowBuf[IDX.vc] = st.vc;
  rowBuf[IDX.vs] = app.vs;
  rowBuf[IDX.alpha] = st.alpha;
  rowBuf[IDX.beta] = st.beta;
  rowBuf[IDX.nz] = -st.nz;                    // 载荷因数约定 n_load = -n-pilot-z
  rowBuf[IDX.theta] = st.theta;
  rowBuf[IDX.phi] = st.phi;
  rowBuf[IDX.psi] = st.psi;
  rowBuf[IDX.elev] = u.elev;
  rowBuf[IDX.ail] = u.ail;
  rowBuf[IDX.rud] = u.rud;
  rowBuf[IDX.trim] = u.trim;
  rowBuf[IDX.law] = LAW_CODE[app.fcs.law] ?? 0;
  rowBuf[IDX.thr] = app.throttle;            // 油门：之前完全没被录下来过（曲线/CSV 都没有它）
  app.rec.pushRow(rowBuf);

  // ── 事件采集 ──
  // 法则变更：直接读 fcs.statusLog（它带着降级原因，比在这里重新推断信息量大）
  drainLawEvents();
  // 模式 / 保护：protTags 每步重建，只在“组合变化”时记一条
  const tags = [...app.fcs.protTags];
  const modeStr = tags.filter((t) => MODE_TAGS.has(t)).sort().join("+");
  const protStr = tags.filter((t) => !MODE_TAGS.has(t)).sort().join("+");
  if (modeStr !== app.prevMode) {
    app.log.push(app.simT, "mode", `模式：${modeStr || "—"}`, 3);
    app.prevMode = modeStr;
  }
  if (protStr !== app.prevProt) {
    if (protStr) app.log.push(app.simT, "alert", `保护介入：${protStr}`, 2.5);
    else if (app.prevProt) app.log.push(app.simT, "info", `保护退出：${app.prevProt}`, 2.5);
    app.prevProt = protStr;
  }
  // ── 对【真实地形】的离地高度 ──
  // 必须用 DEM 地形，不能用 st.hAgl —— JSBSim 的地面是【平面】，
  // 在这张真实地形图上会误判（山头比飞机高也不会被它察觉）。
  const terrM = (app.use3d && app.scene?.terrainHeightAt) ? app.scene.terrainHeightAt(st.lat, st.lon) : null;
  const terrainKnown = Number.isFinite(terrM);
  const aglM = terrainKnown ? st.h * 0.3048 - terrM : st.hAgl * 0.3048;
  app.aglM = aglM;              // 存下来给顶部状态带用（与 3D 标签同一份离地高度）

  // 阶段：地面 / 空中
  const phase = aglM < 5 ? "地面" : "空中";
  if (phase !== app.prevPhase) {
    if (app.prevPhase) app.log.push(app.simT, "phase", `阶段转换：${app.prevPhase} → ${phase}`, 0);
    app.prevPhase = phase;
  }

  // ── 后果判定（失速 / 超载 / 超速 / 触地）──
  const hullBefore = app.con.hull;
  app.con.update(st, { aglM, vsMps: app.vs, terrainKnown });
  for (const e of app.con.takePending()) app.log.push(app.simT, e.level || "fail", e.text, 0);
  app.hullLabel = HULL_LABEL[app.con.hull];
  // 把机体状态【真正接进飞行】：损伤经 FCS 衰减舵面权限与作动速率。
  // 不接的话，“结构超限”只是个标签，飞机照样飞得好好的，看起来像自己恢复了。
  if (app.fcs.damage !== app.con.hull) app.fcs.setDamage(app.con.hull);
  if (app.con.crashed && app.con.hull !== hullBefore) {
    // 代价：标出坠毁点 + 冻结运行 + 弹出终止遮罩（不允许继续）
    if (app.scene?.markCrash) app.scene.markCrash(st.lat, st.lon);
    setPaused(true);
    // 终止原因（impact.kind 现在只有 touchdown / terrain 两种）
    const im = app.con.impact;
    let cause;
    if (im) {
      // 按【损伤程度】选词，而不是按 kind：俯冲撞地和轻接地都是 touchdown，
      // 但把它们都叫“接地”会严重误导（实测存在 219kt 倒扣撞地的情况）。
      const label = im.kind === "terrain" ? "撞地（地形）"
                  : im.severity === HULL.DESTROYED ? "撞地（高速/失控姿态）"
                  : im.severity === HULL.SEVERE ? "重着陆" : "接地";
      // 近垂直姿态（|θ| > 70°）下 φ 是欧拉角奇点的产物，不能印一个任意数字出来
      const bankTxt = im.bankUsable === false ? "坡度不可用（近垂直姿态）" : `坡度 ${im.bankDeg.toFixed(0)}°`;
      cause = `${label}　垂直速度 ${(im.vsMps * 196.85).toFixed(0)} fpm　${bankTxt}　俯仰 ${im.pitchDeg.toFixed(0)}°`;
    } else {
      cause = "结构损伤累积至失效";
    }
    showCrashOverlay(cause + (app.con.everStalled ? "　（过程中发生过失速）" : ""));
    app.say("坠毁 —— 运行已终止，按 R 重新开始", "fail");
  }
}

// 幽灵机自己的后果判定。与真机【各算各的】：
// 它飞的是无增稳无保护的路子，完全可能它已经失速/超载受损，而真机还好好的。
function observeGhost() {
  const g = app.ghostSt;
  if (!g) return;
  const gm = g.h * FT2M;
  if (app.ghostPrevHm !== null) app.ghostVs = (gm - app.ghostPrevHm) / DT;
  app.ghostPrevHm = gm;
  // 与真机同样必须用【真实地形】的离地高度，不能用 JSBSim 的平面地面
  const terr = (app.use3d && app.scene?.terrainHeightAt) ? app.scene.terrainHeightAt(g.lat, g.lon) : null;
  const known = Number.isFinite(terr);
  const agl = known ? g.h * 0.3048 - terr : g.hAgl * 0.3048;
  app.ghostCon.update(g, { aglM: agl, vsMps: app.ghostVs, terrainKnown: known });
}

function physicsStep() {
  const st = unpack(app.fdm.readState());
  const stick = readStick();
  app.stick = stick;                          // 供渲染层画「幽灵舵位」（记录当前杆位）
  app.throttle = clamp(app.throttle + (held("KeyT") ? THROTTLE_RATE * DT : 0)
                                    - (held("KeyG") ? THROTTLE_RATE * DT : 0), 0, 1);
  const u = app.fcs.update(st, stick, DT);
  app.fdm.set("fcs/throttle-cmd-norm", app.throttle);
  app.fdm.set("fcs/elevator-cmd-norm", u.elev);
  app.fdm.set("fcs/aileron-cmd-norm", u.ail);
  app.fdm.set("fcs/rudder-cmd-norm", u.rud);
  app.fdm.set("fcs/pitch-trim-cmd-norm", u.trim);
  app.fdm.step();

  // ── 幽灵机：同杆位 / 同油门，唯一差别是舵面走 DIRECT（无增稳、无保护）──
  // 配平阶段(ghostDirect=false)故意让它跟真机吃同一套舵面指令，这样两机
  // 一开始的状态【完全一致】；否则配平的 6 秒里它们就已经分开了，
  // “从这里开始分岔”这个教学叙事就没了。
  if (app.ghostFdm) {
    const g = app.ghostDirect ? app.fcs.directOut : u;
    // 幽灵机的舵面按【它自己】的损伤衰减，与真机无关。
    // 用上一步的损伤值（多一步延迟，无关紧要）。
    const gAuth = DAMAGE_AUTH[app.ghostCon.hull] ?? 1;
    app.ghostFdm.set("fcs/throttle-cmd-norm", app.throttle);
    app.ghostFdm.set("fcs/elevator-cmd-norm", g.elev * gAuth);
    app.ghostFdm.set("fcs/aileron-cmd-norm", g.ail * gAuth);
    app.ghostFdm.set("fcs/rudder-cmd-norm", g.rud * gAuth);
    // 配平量跟真机【完全一致】。
    // 幽灵机的定义是「同样的杯位、同样的配平，去掉增稳与保护」——
    // 配平两边一致、不参与对照，对照的只是增稳/保护对姿态的作用。
    // （曾试过给它固定快照配平，结果 DIRECT 下真机配平是0、幽灵机不是，
    //   两者差的是配平而不是增稳，2.6s 就漂开 24m，把不变量也测崩了。）
    // 同时也解决了另一个坑：配平若给 0，幽灵机连平飞都保持不住，
    // 不碰杆 3 秒就漂开 66m、几秒内飞出画面，3D 上根本没法看。
    app.ghostFdm.set("fcs/pitch-trim-cmd-norm", u.trim || 0);
    // 幽灵机坠毁后不再步进：它已经是残骸，让它继续飞才是假的。
    // （真机坠毁会把整场冻结，幽灵机没有这个待遇 —— 它是参照物，不是主角。）
    if (!app.ghostCon.crashed) {
      app.ghostFdm.step();
      app.ghostPrevSt = app.ghostSt;
      app.ghostSt = unpack(app.ghostFdm.readState());
    }
    observeGhost();
  }

  app.prevSt = app.st;                        // 保留上一步状态，供渲染插值
  app.st = unpack(app.fdm.readState());
  app.out = u;
  app.simT += DT;
  observe();
}

// 快速稳定到平飞（不实时，加载时一次性跑完）
app.settle = function (seconds) {
  app.ghostDirect = false;        // 配平期：幽灵机跟真机吃同一套指令 → 初始状态完全一致
  for (let i = 0; i < seconds * RATE; i++) physicsStep();
  app.ghostDirect = true;         // 配平结束 → 幽灵机切到 DIRECT，从这一刻起才开始分岔
};

/** 先配平到平飞，再把法则切到本次运行的【开局法则】。
 *  ⚠ 配平必须固定用 NORMAL —— DIRECT 既没增稳也没自动配平，拿它配平只会越配越偏，
 *    实测以 DIRECT 为开局法则时 t≈0 已经是 θ=38.8°、φ=-18.6°、Vs=27.9 m/s（爬升 5500fpm），
 *    早就翻出去了，“以平飞开局”根本无从谈起。
 *  ⚠ 切法则时【配平量必须带过去】：配平轮位置是机体状态、不是法则的输出。
 *    丢掉它，DIRECT 一开局就失去配平、立刻掉头下坠。 */
app.trimThenOpen = function (seconds) {
  app.fcs = new FCS(LAW.NORMAL);
  app.fcs.gammaRef = 0;
  app.settle(seconds);
  if (app.initLaw !== LAW.NORMAL) {
    const trimHold = app.fcs.trim;
    app.fcs = new FCS(app.initLaw);
    app.fcs.trim = trimHold;
    app.fcs.gammaRef = 0;
  }
  return app.fcs.trim;
};

// ---------- 渲染插值 ----------
// 物理是 1/120s 固定步长整数步进，而渲染帧率与它不成整数比时（自适应刷新率、
// 高刷新率屏幕、掉帧），每帧消耗的步数会在 1、2 之间跳。
// 结果：平飞时看不出来，一旦机动就变成可见的角度抖动（"抽搐"）。
// 用累计器余量在"上一步/当前步"之间插值，任何帧率下动作都连续。
const wrap180 = (d) => ((((d % 360) + 540) % 360) - 180);   // 最短角差（处理 359→0）
function lerpSt(a, b, t) {
  if (!a) return b;                                          // 首帧无上一步
  const L = (k) => a[k] + (b[k] - a[k]) * t;
  let psi = a.psi + wrap180(b.psi - a.psi) * t;
  psi = ((psi % 360) + 360) % 360;
  return { ...b, lat: L("lat"), lon: L("lon"), h: L("h"), hAgl: L("hAgl"), vc: L("vc"),
           theta: L("theta"), phi: L("phi"), psi };
}

// ---------- 浮层 DOM ----------
function paintLog() {
  if (app.log.count === app.logSeq) return;
  app.logSeq = app.log.count;
  const items = app.log.recent(120);
  $("logList").innerHTML = items.map((e) =>
    `<div class="ev" data-lv="${e.level}"><span class="t">T+${e.t.toFixed(1)}</span>` +
    `<span class="lv">${LEVEL[e.level].label}</span>` +
    `<span class="tx">${esc(e.text)}</span></div>`).join("");
  $("logCount").textContent = app.log.count;
  // 事件打点缓存：只在日志变化时重建，避免每帧 map 出上千个对象
  app.evMarkers = app.log.items.map((e) => ({ t: e.t, color: LEVEL[e.level].color }));
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function paintStatus(now) {
  // 时钟 10Hz 就够（原来 60Hz），减少每帧 DOM 写入。
  // 首帧 lastClockPaint=0，now 很大，所以会立即写入，不需要特例分支。
  const clockTxt = app.paused ? `T+${app.simT.toFixed(1)}s ⏸ 已暂停` : `T+${app.simT.toFixed(1)}s`;
  if (clockTxt !== app.lastClock && now - app.lastClockPaint >= 100) {
    app.lastClock = clockTxt; app.lastClockPaint = now;
    $("clock").textContent = clockTxt;
  }
  if (now - app.lastLogPaint < 120) return;      // DOM 刷新节流（不影响物理）
  app.lastLogPaint = now;
  paintLog();
}

function toggleGhost() {
  if (!app.scene) return;
  const on = app.scene.setGhostVisible(!app.scene.getGhostVisible());
  app.say(on ? "无飞控参照机：显示 —— 同样的杆位与油门，但它没有增稳、没有包线保护" : "无飞控参照机：隐藏", "info");
}

// 指示器标签的展开/收起。
// 收起只隐藏【标签文字】，箭头仍在 —— “参照机在哪个方位”这个信息保留，
// 但屏幕上不再压着那块永远钉住的大标签。与 KeyV 的“整个参照机开关”是两件事。
function toggleGhostLabel() {
  if (!app.scene) return;
  const on = app.scene.setIndicatorExpanded(!app.scene.getIndicatorExpanded());
  const b = $("ghostLblBtn");
  if (b) b.textContent = "参照机标签: " + (on ? "展开" : "收起");
  app.say(on ? "参照机指示器：展开（箭头 + 标签）" : "参照机指示器：收起（仅保留箭头）", "info");
}

// ── 警告灯 ──
// 【正常时全灭】。真实座舱里“一切正常”是用没有灯亮来表达的，不是写一行“正常”，
// 所以这里默认 hidden，有异常才点亮。
// 分两级，与真机的主警告/主警戒同构：
//   warning 红   —— 需立即处置（失速 / 结构超限 / 坠毁）
//   caution 琥珀 —— 警戒（超载 / 超速 / 轻损）
// ⚠ 持续损伤（结构超限 / 轻损）也在这两只灯里，它们不会自己灭 ——
//    否则又会变成“伤好像自己好了”。
//    注：不设“曾失速”记忆灯（那是数据，不是警告）；但瞬时告警有 3 秒最短驻留，
//    见下面的 ANNUN_DWELL_MS —— 那是为了让 2 秒的失速窗口【能被看见】，不是记历史。
const ANNUN_LEVEL = {
  "坠毁": "warning", "失速": "warning", "结构超限": "warning",
  "超载": "caution", "超速": "caution", "轻损": "caution",
};
const ANNUN_ORDER = ["坠毁", "失速", "结构超限", "超载", "超速", "轻损"];

// 瞬时告警（取自【当前】状态量，状态一消失灯就灭）的最短驻留时长。
// 为什么需要：失速窗口实测只有约 2s（α 12.1°(6s) → 22.9°(8s) → 5.8°(10s)，随后自己改出），
// 亮一下就灭，肉眼极易漏掉 —— 演示里就表现成“好像从来没触发过失速”。
// 这与“曾失速”记忆灯的区别：驻留只把【刚刚发生】的告警拖长到可感知，
// 不是把历史数据做成警告；这四只灯本身仍然由瞬时量驱动。
const ANNUN_TRANSIENT = ["失速", "超载", "超速"];
const ANNUN_DWELL_MS = 3000;

function updateAnnunciator() {
  const el = $("annun");
  if (!el) return;
  const now = performance.now();
  const lit = new Set();
  if (app.con.hull !== HULL.INTACT) lit.add(HULL_LABEL[app.con.hull]);   // ① 累积损伤（不可逆）
  if (app.con.crashed) lit.add("坠毁");
  const fs = flightStateOf(app.st, app.aglM, app.con.hull, app.con.crashed);   // ② 当前状态
  const live = new Set();
  if (fs && fs.text !== "正常" && fs.text !== "坠毁") live.add(fs.text);

  // 瞬时告警的 3 秒最短驻留：状态点亮时刷新截止时刻，
  // 只要还没到期，即使当前已经恢复正常也继续亮。
  for (const t of ANNUN_TRANSIENT) {
    if (live.has(t)) app.annunHold[t] = now + ANNUN_DWELL_MS;
    if ((app.annunHold[t] ?? 0) > now) lit.add(t);
  }
  for (const t of live) lit.add(t);

  const list = ANNUN_ORDER.filter((t) => lit.has(t));
  const key = list.join("|");
  if (key === app.lastAnnun) return;          // 只在真的变了才动 DOM
  app.lastAnnun = key;
  if (!list.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = list.map((t) =>
    `<span class="lamp ${ANNUN_LEVEL[t] ?? "caution"}">${esc(t)}</span>`).join("");
}

// ── 指示器避让 UI 面板 ──
// 3D 指示器是画在 canvas 里的，而所有面板在 #ui 层（z-index 2）盖在 canvas 之上。
// 因此指示器一旦被摆到面板底下，屏幕上就“没有它”了 ——
// 座舱视角的仪表板最大（居中、宽 min(900px,74vw)、约占屏幕下方 37%），最容易被遮。
// 这里量出顶栏下沿与【通栏/居中】面板上沿，换算成 NDC 上、下半幅交给场景。
// 注：只用布局读（getBoundingClientRect）+ 节流，不每帧量，避免 layout thrashing。
function measureMarkerBounds() {
  const H = innerHeight || 1, W = innerWidth || 1;
  let floorPx = H;
  // 会压在屏幕下方中部的面板：时间历程栏、底栏、座舱仪表板
  for (const id of ["trendPanel", "barBottom", "instPanel", "logPanel"]) {
    const el = $(id);
    if (!el) continue;
    if (getComputedStyle(el).display === "none") continue;
    const r = el.getBoundingClientRect();
    // 只算【通栏或居中】的：窄侧栏不挡中间，不该把指示器白白赶到上半屏
    if (r.height < 4 || r.width < W * 0.45) continue;
    if (r.top < H * 0.35) continue;          // 顶部面板不算“地板”
    floorPx = Math.min(floorPx, r.top);
  }
  const tb = $("topbar");
  const ceilPx = tb ? tb.getBoundingClientRect().bottom : 0;
  return {
    up:   Math.max(0.05, 1 - (ceilPx / H) * 2),   // NDC：顶为 +1
    down: Math.max(0.05, (floorPx / H) * 2 - 1),  // 正数：向下允许的半幅
  };
}

function render(dt, alpha, now) {
  if (!app.st) return;
  const stR = lerpSt(app.prevSt, app.st, alpha);            // 渲染用插值状态
  const extra = { ...app.out, throttle: app.throttle, vs: app.vs,
                  casMsg: performance.now() < app.casUntil ? app.cas : null };

  const p = fit($("pfd"));
  if (p.ctx) drawPFD(p.ctx, p.w, p.h, stR, app.fcs, extra);
  const e = fit($("ecam"));
  if (e.ctx) drawECAM(e.ctx, e.w, e.h, stR, app.fcs, extra);

  // 外部视景：满屏 3D，初始化失败时回退到 2D
  // 第 4 个参数是 FCS 算好的「DIRECT 等价输出」，供幽灵参考用。
  // 不能传原始杯位让渲染层自己重算 —— FCS 内部对升降舵还有一层 elevRate 限速，
  // 两个限速器不同步会让幽灵在过渡段说谎（见 fcs.js 的注释与 ghost-probe.mjs）。
  // 幽灵机同样要做前后步插值 —— 物理是 120Hz 整数步进，不插值的话它会比真机明显抖。
  const ghostR = app.ghostSt ? lerpSt(app.ghostPrevSt, app.ghostSt, alpha) : null;
  // 两机各自的【累积损伤 + 终止态】也传下去：标签要能显示“自机 完好 ｜ 参照机 结构超限”
  // 传 crashed 是必需的：DESTROYED 是终止态，瞬时状态必须被钉死（详见 flightStateOf）
  const hulls = {
    own:   { hull: app.con.hull, crashed: app.con.crashed },
    ghost: { hull: app.ghostCon.hull, crashed: app.ghostCon.crashed },
  };
  if (app.use3d) app.scene.update(stR, dt, app.out, app.fcs.directOut, ghostR, hulls);
  else if (app.ext2d) { const x = fit(app.ext2d); if (x.ctx) drawExternal(x.ctx, x.w, x.h, stR); }

  // 时间历程：15Hz 重绘足够（120s 滚动窗，肉眼分不出 60Hz 与 15Hz）。
  // 同时把 fit() 也移进节流分支 —— fit() 读 offsetWidth 会**强制同步布局**，
  // 而下面又紧跟着写 DOM，两者交替就是 layout thrashing，帧时间因此抖动。
  if (now - app.lastTrendPaint >= 66) {
    app.lastTrendPaint = now;
    const tr = fit($("trend"));
    if (tr.ctx) drawTrend(tr.ctx, tr.w, tr.h, app.rec,
      { window: 120, keys: GROUPS[app.trendGroup] ?? GROUPS["气动"], events: app.evMarkers });
  }

  // 指示器避让 UI：面板几何只在换视角 / 改窗口 / 折叠面板时变，节流到 2Hz 量就够了。
  // 必须在下面那批 DOM 写入【之前】做，免得上写后读触发强制同步布局。
  if (now - app.lastBoundsPaint >= 500) {
    app.lastBoundsPaint = now;
    if (app.scene?.setMarkerBounds) app.scene.setMarkerBounds(measureMarkerBounds());
  }

  // 这些是每帧都写的 DOM。即使写入内容完全一样，赋 textContent/className 也会
  // 让布局失效。用缓存值拦一道，只在真正变化时才写 —— 配合上面的 fit() 布局抖动。
  const ann = app.fcs.annunciate();
  const badgeTxt = ann.lawText + (ann.protText ? " · " + ann.protText : "");
  if (badgeTxt !== app.lastBadge) { app.lastBadge = badgeTxt; $("lawBadge").textContent = badgeTxt; }
  const badgeCls = "badge " + (ann.law === "NORMAL" ? "ok" : ann.law === "ALTERNATE" ? "warn" : "bad");
  if (badgeCls !== app.lastBadgeCls) { app.lastBadgeCls = badgeCls; $("lawBadge").className = badgeCls; }
  const protTxt = ann.tags.length ? "模式/保护: " + ann.tags.join(", ") : "保护未介入";
  if (protTxt !== app.lastProt) { app.lastProt = protTxt; $("protoTags").textContent = protTxt; }

  // 警告灯：正常时全灭，异常才亮（状态判定与 3D 参照机标签共用同一份）
  updateAnnunciator();

  paintStatus(now);
}

// ---------- 主循环 ----------
// 倍速通过放大累计器实现：同样的真实时间喂进更多物理步。
// 带 12ms 时间预算，高倍速下宁可少走几步也不掉帧（否则会雪崩式追帧）。
let acc = 0, last = performance.now();
function frame(now) {
  const dtReal = Math.min(0.25, (now - last) / 1000);   // 必须先算，再更新 last
  last = now;
  if (app.paused) {
    // 暂停：既不推进物理、也不累积时间。acc 保持不动 → alpha 恒定 → 画面完全冻结，
    // 而且恢复时不会有“追赶爆发”（因为暂停期间一秒也没累积）。
    // 场景传 dt=0：否则螺旋桨会继续转、环绕视角会继续绕。
    // last 已在上面更新，所以恢复后第一帧的 dtReal 是正常帧间隔（不含暂停时长）。
    //
    // 但【油门】仍要能调：它是“推上去就停在那儿”的纯状态输入，不是瞬时操纵。
    // 原来暂停时一律不响应，按 T/G 毫无反应、PFD 上的 THR 数字也不动，
    // 看起来就和“油门坏了”一模一样。用真实帧间隔积分，速率与 physicsStep 一致。
    app.throttle = clamp(app.throttle + (held("KeyT") ? THROTTLE_RATE * dtReal : 0)
                                        - (held("KeyG") ? THROTTLE_RATE * dtReal : 0), 0, 1);
    render(0, clamp(acc / DT, 0, 1), now);
    requestAnimationFrame(frame);
    return;
  }
  acc += dtReal * app.rate;
  const maxSteps = 60 * app.rate;
  let guard = 0;
  const t0 = performance.now();
  while (acc >= DT && guard++ < maxSteps) {
    physicsStep(); acc -= DT;
    if ((guard & 15) === 0 && performance.now() - t0 > 12) break;
  }
  if (guard >= maxSteps) acc = 0;                       // 追不上就丢弃余量，别雪崩
  render(dtReal, clamp(acc / DT, 0, 1), now);
  requestAnimationFrame(frame);
}

// ---------- 坠毁：终止态 ----------
// 坠毁不是「暂停」，是【运行结束】：物理冻结，且所有会让它接着下去的入口都被禁掉，
// 只留重新开始（R 键 / 遮罩上的按钮）。
// 刻意不禁用的：相机切视角（看坠毁现场）、CSV 导出（存证）——
// 两者都不推进物理，不构成“继续”。
const CRASH_LOCK = ["pauseBtn", "preset", "lawNormal", "lawAltn", "lawDirect",
                    "fAlpha", "fAhrs", "fElev", "fAil", "fRud"];

function setControlsLocked(locked) {
  for (const id of CRASH_LOCK) { const el = $(id); if (el) el.disabled = locked; }
  for (const b of document.querySelectorAll("#rates button")) b.disabled = locked;
}

function showCrashOverlay(cause) {
  const ov = $("crashOverlay"), cc = $("crashCause");
  if (cc) cc.textContent = cause;
  if (ov) ov.hidden = false;
  setControlsLocked(true);
  const b = $("pauseBtn");
  if (b) { b.textContent = "暂停"; b.classList.remove("on"); }
}

function hideCrashOverlay() {
  const ov = $("crashOverlay");
  if (ov) ov.hidden = true;
  setControlsLocked(false);
}

// ---------- 暂停 ----------
function setPaused(v) {
  // 坠毁是终止态：拒绝任何“恢复”请求（空格 / 暂停按钮）
  if (!v && app.con && app.con.crashed) {
    app.say("已坠毁 —— 不能继续，只能重新开始（R）", "alert");
    return;
  }
  app.paused = !!v;
  const b = $("pauseBtn");
  if (b) { b.classList.toggle("on", app.paused); b.textContent = app.paused ? "继续" : "暂停"; }
  // 让时钟里的暂停标记立即刷新（paintStatus 有 100ms 节流 + 值缓存）
  app.lastClock = ""; app.lastClockPaint = 0;
}
function togglePause() {
  setPaused(!app.paused);
  app.say(app.paused ? "已暂停（空格继续）" : "继续飞行");
}

// ---------- 控件 ----------
function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  app.reset();                                          // 一次干净运行：清时钟/记录/日志
  for (const name of p.faults) app.fcs.injectFault(name);
  for (const [bid, fname] of FAULT_BTNS) $(bid).classList.toggle("on", p.faults.includes(fname));
  drainLawEvents();                                     // 立即冲刷，保证日志时序正确
  app.log.push(app.simT, "phase", `场景预设：${p.name}`, 0);
  app.log.push(app.simT, "mode", `当前法则 ${app.fcs.law}${p.faults.length ? "（故障：" + p.faults.join(", ") + "）" : ""}`, 0);
  app.say(`场景预设：${p.name}`);
}

function cycleCam() {
  if (!app.use3d || !app.scene) return;
  const m = app.scene.nextMode();
  $("camBtn").textContent = "视角: " + (CAM_LABEL[m] || m);
  applyCamClass(m);
  app.say("视角切换: " + (CAM_LABEL[m] || m));
}

/** 座舱视角下把仪表盘挪到屏幕中心（样式见 index.html 的 body.cam-cockpit） */
function applyCamClass(m) {
  document.body.classList.toggle("cam-cockpit", m === "cockpit");
}

const CAM_LABEL = { chase: "追机", cockpit: "座舱", cinematic: "环绕" };

function bindButtons() {
  // 暂停（也可用空格）
  $("pauseBtn").onclick = () => togglePause();

  // 场景预设
  const sel = $("preset");
  for (const p of PRESETS) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.onchange = () => { if (sel.value) { applyPreset(sel.value); sel.value = ""; } };

  // 倍速
  for (const v of SPEEDS) {
    const b = document.createElement("button");
    b.textContent = v + "x";
    b.className = app.rate === v ? "on" : "";
    b.onclick = () => {
      app.rate = v;
      [...$("rates").children].forEach((c) => (c.className = ""));
      b.className = "on";
      app.say(`仿真倍速 ${v}x`);
    };
    $("rates").appendChild(b);
  }

  // 条带图分组
  for (const g of Object.keys(GROUPS)) {
    const b = document.createElement("button");
    b.textContent = g;
    b.className = app.trendGroup === g ? "on" : "";
    b.style.padding = "1px 7px"; b.style.fontSize = "11px";
    b.onclick = () => {
      app.trendGroup = g;
      [...$("trendTabs").children].forEach((c) => (c.className = ""));
      b.className = "on";
    };
    $("trendTabs").appendChild(b);
  }

  // 法则
  for (const [id, law] of [["lawNormal", LAW.NORMAL], ["lawAltn", LAW.ALTERNATE], ["lawDirect", LAW.DIRECT]]) {
    $(id).onclick = () => { app.fcs.setLaw(law); app.say(`人工选择 ${law} LAW`, law === LAW.NORMAL ? "info" : "alert"); };
  }

  // ── 开局法则 ──
  // 法则属于【开局条件】，不是飞行中的旋钮：改了就直接开一次新运行，让它从 t=0 生效。
  // 原因（实测）：中途从 NORMAL 拨到 DIRECT 时，FCS 内部升降舵的【真机指令】要从
  // 增稳时代的值按 elevRate 爬向 DIRECT 目标，而【幽灵机等价量 directOut】早就在目标上了；
  // 两条限速积分器历史不同 → 两机在过渡段差开 0.19m，而不是严格重合。
  // 开局就定好，两条积分器从第一帧起同源，DIRECT 下两机才能真正逐位一致。
  const initSel = $("initLaw");
  if (initSel) {
    initSel.value = app.initLaw;
    initSel.onchange = () => {
      app.initLaw = initSel.value;
      app.reset();
      app.say(`新运行：开局法则 ${app.initLaw}`, app.initLaw === LAW.NORMAL ? "info" : "alert");
    };
  }
  // 故障注入
  for (const [id, name] of FAULT_BTNS) {
    $(id).onclick = () => {
      const has = app.fcs.faults.has(name);
      if (has) { app.fcs.clearFault(name); $(id).classList.remove("on"); app.say(`已清除故障 ${name}`); }
      else { app.fcs.injectFault(name); $(id).classList.add("on"); app.say(`故障注入 ${name}`, "fail"); }
    };
  }

  // 故障高亮的清理已收进 app.reset() —— 不再在每个按钮 handler 里各写一份，
  // 那正是键盘 R 与改开局法则两条路径漏掉清理的原因。
  $("reset").onclick = () => app.reset();
  $("crashRestart").onclick = () => app.reset();
  $("camBtn").onclick = cycleCam;
  $("ghostLblBtn").onclick = toggleGhostLabel;

  // CSV 导出
  $("csvBtn").onclick = () => {
    if (app.rec.count < 2) { app.say("暂无时间历程数据可导出", "alert"); return; }
    const r = app.rec.download();
    app.log.push(app.simT, "hw", `导出 CSV：${r.name}（${app.rec.count} 点 / ${(r.bytes / 1024).toFixed(0)} KB）`, 0);
    app.say(`已导出 ${app.rec.count} 点`);
  };

  // 面板收起
  for (const b of document.querySelectorAll(".tog")) {
    b.onclick = () => {
      const el = $(b.dataset.for);
      el.classList.toggle("collapsed");
      b.textContent = el.classList.contains("collapsed") ? "▸" : "▾";
    };
  }
  $("collapseAll").onclick = (ev) => {
    const anyOpen = COLLAPSIBLE.some((id) => !$(id).classList.contains("collapsed"));
    for (const id of COLLAPSIBLE) $(id).classList.toggle("collapsed", anyOpen);
    for (const b of document.querySelectorAll(".tog")) b.textContent = anyOpen ? "▸" : "▾";
    ev.target.textContent = anyOpen ? "展开面板" : "收起面板";
  };

  window.app = app;                                     // 便于控制台/自动化检查
  window.focus();
}

// ---------- 启动 ----------
(async () => {
  const setBoot = (t) => { const el = $("bootText"); if (el) el.textContent = t; };
  try {
    setBoot("正在加载飞行动力学内核 (JSBSim WASM)…");
    app.fdm = await createFdm({ onLog: (m) => console.warn("[jsbsim]", m) });
    // 幽灵机：第二套独立内核。同一初始条件、同样的杆位与油门，但舵面走 DIRECT。
    setBoot("正在加载无飞控参照机（同杆位、去掉增稳与保护）…");
    app.ghostFdm = await createFdm({ onLog: (m) => console.warn("[jsbsim:ghost]", m) });
    setBoot("正在配平到平飞…");
    app.initLaw = $("initLaw") ? $("initLaw").value : LAW.NORMAL;
    app.trimThenOpen(6);                     // 先配平(固定 NORMAL) → 再切到开局法则
    setBoot("正在构建 3D 视景…");
    initView();
    $("boot").style.display = "none";
    bindButtons();
    app.log.push(app.simT, "info", "系统就绪：JSBSim 内核装载完成，3D 视景已建立", 0);
    requestAnimationFrame(frame);
  } catch (err) {
    // 启动失败必须显式暴露，否则只会卡在加载页什么都看不到
    console.error("启动失败", err);
    const msg = (err && (err.stack || err.message)) || String(err);
    setBoot("启动失败：\n" + msg);
    const el = $("bootText");
    if (el) { el.style.whiteSpace = "pre-wrap"; el.style.maxWidth = "80vw"; el.style.fontSize = "12px"; el.style.textAlign = "left"; el.style.color = "#ff3d3d"; }
  }
})();

// ---------- 视景初始化：3D 优先，失败回退 2D ----------
function initView() {
  try {
    app.scene = createScene3D($("ext"));
    app.use3d = true;
    const b = $("camBtn");
    if (b) b.textContent = "视角: " + (CAM_LABEL[app.scene.getMode()] || "追机");
    applyCamClass(app.scene.getMode());
  } catch (err) {
    console.warn("3D 视景初始化失败，回退到 2D 视景：", err);
    app.use3d = false;
    const cv = document.createElement("canvas");
    cv.style.cssText = "width:100%;height:100%;display:block";
    $("ext").appendChild(cv);
    app.ext2d = cv;
  }
  addEventListener("resize", () => app.scene?.resize());
}
