// 无气动 FDM 适配器 —— 第 3 幕"阶段性产物"用的假动力学
// ══════════════════════════════════════════════════════════════════════
// 用途：演示剧本第 3 幕"平台输出了一个阶段性成果，有完整的前端展示，
//       但是飞机没有任何空气动力学模拟，乱飞"。
//
// 它【不是】一个低配版 JSBSim，也不是 JSBSim 的降级模式 —— 它是刻意做成
// 「少了气动这一块」的占位动力学：
//
//   ① 姿态：操纵面指令直连角加速度积分。没有气动阻尼、没有静稳定性、
//      没有配平平衡点 → 输入撤掉后姿态【不会自己回来】，也没有"平飞"这个状态。
//      实测松手 60s：坡度自己摆到 ±18°（峰峰 36°），俯仰缓慢漂移约 5°。
//   ② 垂向：没有升力去抵消重力 → 高度一路掉（实测 ≈ -1680 fpm），拉杆也拉不回来
//      （推力在垂向只有一个 sin(θ) 分量，压不住重力）。
//   ③ 过载：不来自气动/惯性耦合，只是给显示层的占位数字（恒约 1g）→ 拉满杆过载
//      也不涨。保护逻辑会照常算出并播报 LOAD/PITCH 标签，但**飞机不理会**——
//      保护在这里没有作用对象（实测：满杆后 θ 直接翻到 180°，高度照样掉）。
//   ④ 迎角/侧滑角：不由气流与机体姿态的几何关系解出，是合成量（±7° 缓摆）→
//      于是飞控的 FPA HOLD 实际上在"追一个不存在的信号"。
//
// 因此观众看到的"乱飞"是【物理缺失】的下场，而不是随机崩溃。这一点很重要：
// 演示时能讲清楚"因为少了哪一块，所以变成了这样"。
//
// ── 接口契约（必须与 fdm/adapter.browser.js 完全一致，否则 main.js 要改）──
//   createNoAeroFdm({ ic, onLog }) -> { sdk, readState, get, set, step, reset }
//   状态数组的顺序 = STATE_PATHS（从 adapter.browser.js 引入 I 来保证下标一致，
//   这样 main.js 里的 unpack() 不需要任何改动就能解这个数组）。
//   本模块只被 main.js 用到的 5 个属性驱动：
//     fcs/throttle-cmd-norm, fcs/elevator-cmd-norm, fcs/aileron-cmd-norm,
//     fcs/rudder-cmd-norm, fcs/pitch-trim-cmd-norm
//
// 单位约定：高度 ft、空速 kt、垂直速度 ft/s、姿态 deg、角速率 rad/s。
// 符号约定沿用 src/fcs/fcs.js 文件头（勿改）：
//   elevator 正 → 低头（θ↓, q↓）  aileron 正 → 右滚（φ↑, p↑）  rudder 正 → 左偏航（r↓）

import { STATE_PATHS, I } from "./adapter.browser.js";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const G_FPS2 = 32.174;          // 重力加速度 ft/s²
const KTS_PER_FPS = 0.592484;   // 1 ft/s = 0.592484 kt
const M_PER_DEG_LAT = 111320;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── 可调参数（都在这里，调完"乱飞"的观感直接变）──

// 操纵→角加速度增益。刻意取得【小】：舵面打了飞机也不太动，
// 于是"操纵无力、不听使唤"成为最直观的症状。
const Q_GAIN = 0.30;   // 升降舵 → qdot（rad/s²/单位指令）
const P_GAIN = 0.40;   // 副翼   → pdot
const R_GAIN = 0.25;   // 方向舵 → rdot

// 阻尼。几乎为零 —— 这就是"没有气动阻尼"的意思。
// 不要调大：调大了飞控就能把姿态按下去，第 3 幕的症状立刻消失（实测过）。
const Q_DAMP = 0.010, P_DAMP = 0.010, R_DAMP = 0.015;

// 姿态扰动噪声（确定性正弦合成，不用随机数 → 每次演示完全可复现）。
// 作用：手不碰杆时飞机也在持续乱飘，说明"这不是操纵问题，是模型问题"。
//
// ⚠ 滚转噪声【必须用低频】，这是实测出来的：
//   高频扰动（1.1/3.1 Hz）会被飞控的滚转速率环（KpRoll）直接滤掉 ——
//   实测松手 60s 坡度峰峰只有 0.4°，画面看着像一架正常的飞机，"乱飞"消失。
//   改成低频（0.045/0.11 Hz）后飞控按不住，坡度峰峰 36°，症状才可见。
//   俯仰同样调低会反过来：θ 摆到 96° 并误触 PITCH 保护，所以俯仰保持高频。
const NOISE_Q = 0.035, NOISE_P = 0.090, NOISE_R = 0.030;

// 角速率硬限幅（rad/s）。防发散到 NaN，同时保留"翻滚"的观感。
const RATE_LIMIT = 3.0;

// 推力：满油门对应的前向加速度（ft/s²）与粗糙的前向阻力系数占位。
// 这两个数只为了"速度别飞掉"，不构成任何气动模型 —— 注意拉杆不会带来诱导阻力，
// 这也是"少了气动"的一个旁证。
const THRUST_FPS2 = 12.0;
const DRAG_FWD = 2.17e-4;       // 与 12.0 配平后终端空速≈185ft/s（110kt）

// 垂向下沉：重力项 + 一个"阻力占位"阻尼（给下沉一个终端速度）。
// 终端下沉速度 ≈ -(G_FPS2 / (vt*DRAG_SINK))，在 110kt 下约 -29 ft/s（-1700 fpm）。
// 有了它，从 4500ft 砸到地面要 2 分钟以上，给现场留足了讲解时间；
// 没有它则 20 秒落地，"阶段性成果"这一幕根本讲不完。
const DRAG_SINK = 0.006;

// 合成迎角/侧滑角（不是解出来的，是编出来的 —— 这正是问题之一）
// 幅度取到 ±7°：飞控的 FPA HOLD 会把"扰迹角 = θ − α"拉到参考值，
// 而 α 是假的、还在自己摆，于是 θ 被迫跟着 α 一起摆 ——
// 画面上就是"飞控在追一个不存在的信号"。这是本模型最好用的一条症状。
// 上限守在失速告警线（13.5°）以下：这里是"缺气动"，不是"真的失速"。
function synthAlpha(t) { return 3 + 6 * Math.sin(2 * Math.PI * 0.11 * t) + 1.5 * Math.sin(2 * Math.PI * 0.43 * t + 0.6); }
function synthBeta(t) { return 1.5 * Math.sin(2 * Math.PI * 0.17 * t + 2.1); }
// 过载占位：几乎恒为 1g，与操纵无关 → 载荷保护永远不介入
function synthNz(t) { return 1.0 + 0.04 * Math.sin(2 * Math.PI * 0.09 * t); }

export const DEFAULT_IC = {
  "ic/h-sl-ft": 4500, "ic/vc-kts": 110, "ic/theta-deg": 2,
  "ic/phi-deg": 0, "ic/psi-deg": 0, "ic/beta-deg": 0,
  "fcs/throttle-cmd-norm": 0.62,
  "ic/lat-geod-deg": 38.50, "ic/long-gc-deg": -122.35,
};

export async function createNoAeroFdm({ ic = {}, onLog } = {}) {
  const icOverrides = { ...DEFAULT_IC, ...ic };
  const props = new Map();          // main.js 写进来的 5 个属性
  const st = {
    hFt: 4500, vt: 185, vc: 110, vs: 0,
    theta: 2, phi: 0, psi: 0,
    p: 0, q: 0, r: 0,
    lat: 38.5, lon: -122.35,
    simT: 0,
  };

  const applyIc = () => {
    let vc = 110;
    for (const [k, v] of Object.entries(icOverrides)) {
      if (k === "ic/h-sl-ft") st.hFt = v;
      else if (k === "ic/vc-kts") vc = v;
      else if (k === "ic/theta-deg") st.theta = v;
      else if (k === "ic/phi-deg") st.phi = v;
      else if (k === "ic/psi-deg") st.psi = v;
      else if (k === "ic/lat-geod-deg") st.lat = v;
      else if (k === "ic/long-gc-deg") st.lon = v;
      else props.set(k, v);         // throttle-cmd / 等
    }
    st.vc = vc;
    st.vt = vc / KTS_PER_FPS;
    st.vs = 0;
    st.p = st.q = st.r = 0;
    st.simT = 0;
  };
  applyIc();
  onLog?.("无气动阶段版：已装载占位动力学（没有气动数据、没有 6-DoF 内核）");

  const num = (k, d = 0) => { const v = props.get(k); return Number.isFinite(v) ? v : d; };
  const noise = (t, f1, f2, amp) => amp * (Math.sin(2 * Math.PI * f1 * t) + 0.6 * Math.sin(2 * Math.PI * f2 * t + 1.0));

  /** 推进一个物理步。dt 固定 1/120（与 main.js 的 RATE 一致）。 */
  const step = (dt = 1 / 120) => {
    const t = st.simT;
    const throttle = clamp(num("fcs/throttle-cmd-norm", 0.62), 0, 1);
    const elev = num("fcs/elevator-cmd-norm");
    const ail = num("fcs/aileron-cmd-norm");
    const rud = num("fcs/rudder-cmd-norm");
    // pitch-trim-cmd-norm 被刻意【忽略】：没有气动就没有配平平衡点，
    // 配平轮在真实模型里能洗掉稳态舵偏，在这里拨了没有任何效果 —— 这是症状之一。

    // ── ① 姿态：操纵直连角加速度，无气动阻尼、无静稳定、无配平 ──
    st.q += (-Q_GAIN * elev - Q_DAMP * st.q + noise(t, 0.7, 2.3, NOISE_Q)) * dt;
    st.p += (P_GAIN * ail - P_DAMP * st.p + noise(t, 0.045, 0.11, NOISE_P)) * dt;   // 低频：见 NOISE_* 处注释
    st.r += (-R_GAIN * rud - R_DAMP * st.r + noise(t, 0.9, 2.7, NOISE_R)) * dt;
    st.p = clamp(st.p, -RATE_LIMIT, RATE_LIMIT);
    st.q = clamp(st.q, -RATE_LIMIT, RATE_LIMIT);
    st.r = clamp(st.r, -RATE_LIMIT, RATE_LIMIT);

    st.theta += st.q * RAD2DEG * dt;
    st.phi += st.p * RAD2DEG * dt;
    // 欧拉角 ψ 的奇点：近垂直姿态下 1/cosθ 会爆，给一个下限把数值兜住
    st.psi += (st.r * RAD2DEG * dt) / Math.max(0.25, Math.cos(st.theta * DEG2RAD));
    st.psi = ((st.psi % 360) + 360) % 360;
    // 姿态不设限（要能翻过去才叫乱飞），只把数值兜在合法范围内
    st.theta = clamp(st.theta, -180, 180);
    st.phi = clamp(st.phi, -180, 180);

    // ── ② 前向：推力 vs 粗糙阻力占位 ──
    const thrustAcc = THRUST_FPS2 * throttle;
    st.vt += (thrustAcc - DRAG_FWD * st.vt * st.vt) * dt;
    st.vt = clamp(st.vt, 20, 700);
    st.vc = st.vt * KTS_PER_FPS;

    // ── ③ 垂向：没有升力抵消重力，只有推力的 sinθ 分量在帮倒忙 ──
    const aVert = thrustAcc * Math.sin(st.theta * DEG2RAD) - G_FPS2;
    st.vs += (aVert - st.vs * st.vt * DRAG_SINK) * dt;
    st.vs = clamp(st.vs, -600, 200);
    st.hFt += st.vs * dt;
    st.hFt = clamp(st.hFt, -1000, 60000);

    // ── ④ 地面航迹：沿 ψ 前进（速度方向当作随姿态，简化处理）──
    const gsMps = st.vt * 0.3048;
    const dN = gsMps * dt * Math.cos(st.psi * DEG2RAD);
    const dE = gsMps * dt * Math.sin(st.psi * DEG2RAD);
    st.lat += dN / M_PER_DEG_LAT;
    st.lon += dE / (M_PER_DEG_LAT * Math.max(0.2, Math.cos(st.lat * DEG2RAD)));

    st.simT += dt;
  };

  const readState = (out) => {
    const o = out instanceof Float64Array && out.length === STATE_PATHS.length
      ? out : new Float64Array(STATE_PATHS.length);
    const t = st.simT;
    o[I["position/h-sl-ft"]] = st.hFt;
    o[I["position/h-agl-ft"]] = st.hFt;          // 假模型没有地形，AGL 就报 MSL
    o[I["velocities/vc-kts"]] = st.vc;
    o[I["velocities/vt-fps"]] = st.vt;
    o[I["attitude/theta-deg"]] = st.theta;
    o[I["attitude/phi-deg"]] = st.phi;
    o[I["attitude/psi-deg"]] = st.psi;
    o[I["aero/alpha-deg"]] = synthAlpha(t);      // 合成量，不是解出来的
    o[I["aero/beta-deg"]] = synthBeta(t);
    o[I["velocities/p-aero-rad_sec"]] = st.p;
    o[I["velocities/q-aero-rad_sec"]] = st.q;
    o[I["velocities/r-aero-rad_sec"]] = st.r;
    o[I["accelerations/n-pilot-z-norm"]] = -synthNz(t);   // 与操纵无关的占位过载
    // ⚠ 符号：上层（fcs.js 与 main.js 的 observe）用的是 n_load = -n-pilot-z-norm，
    // 所以要报告"载荷因数 1g"，这里必须写【负值】。写成正值会让飞控解出 -1g，
    // 立刻触发 LOAD 硬限保护 —— 而本模型的前提是"保护无从触发"（实测过）。
    o[I["velocities/mach"]] = st.vt / 1116.4;
    o[I["position/lat-geod-deg"]] = st.lat;
    o[I["position/long-gc-deg"]] = st.lon;
    return o;
  };

  return {
    sdk: null,                                   // 故意没有内核
    readState,
    get: (p) => props.has(p) ? props.get(p) : NaN,
    set: (p, v) => { props.set(p, v); },
    step: (dt) => step(dt),
    reset: () => { applyIc(); onLog?.("无气动阶段版：重置到初始条件"); },
    /** 诊断用：暴露内部状态，便于自动化断言"气动确实关着" */
    __noaero: true,
  };
}
