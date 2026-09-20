// 后果系统：失速 / 超限 / 触地 的判定与分级
//
// 设计成纯函数式的状态机（不依赖 DOM / three），因此可以在 Node 里直接跑场景测试，
// 不必靠肉眼看画面来判断分级对不对。
//
// ⚠️ 重要边界：这是叠加在 JSBSim 之上的【叙事/评分层】，不是真实的毁伤模型。
//    JSBSim 的地面是平面（0 MSL），而 3D 里贴的是真实 DEM 地形，
//    所以“撞山”由本模块用真实地形高度判定，JSBSim 自身不会察觉到，
//    飞机也不会在 FDM 里真的解体。触发后由上层冻结运行并标注为坠毁。

export const HULL = {
  INTACT: "INTACT",       // 完好
  MINOR: "MINOR",         // 轻损（重着陆）
  SEVERE: "SEVERE",       // 结构超限
  DESTROYED: "DESTROYED", // 坠毁
};
export const HULL_LABEL = {
  INTACT: "完好", MINOR: "轻损", SEVERE: "结构超限", DESTROYED: "坠毁",
};

export const LIMITS = {
  // 失速迎角：取自 c172p 自身的阻力表 —— 0.2793 rad 处达峰后回落，即 16.0°
  alphaStallDeg: 16.0,
  alphaBuffetDeg: 13.5,          // 抖振/失速警告
  nzMax: 3.8, nzMin: -1.5,       // 结构过载
  vneKt: 160,                    // 不可超越速度
  gearHeightM: 1.30,             // 起落架离地高度（判定触地的几何下沿）
  // 接地垂直速度分级（m/s，括号内为 ft/min）
  vsMinor: -1.5,                 // ≈ -295 fpm
  vsSevere: -3.0,                // ≈ -590 fpm
  vsDestroyed: -6.0,             // ≈ -1180 fpm
  bankMinorDeg: 10,
  bankSevereDeg: 25,
  bankDestroyedDeg: 45,
  // 坡度读数（st.phi）可用的俯仰角上限。
  // φ 是欧拉角，在 θ=±90°（机头垂直）处万向节锁死：同一个物理姿态穿过极点后 φ 会翻转约 180°。
  // 实测：一架【无副翼输入】的倒扣飞机俯冲穿越 θ≈-84°，机身滚转率 p 恒定在 -1.7°/s
  // （几乎为零、全程未变），而 φ 在 0.5s 内从 -129° 跳到 -42° —— 那 150° 是坐标奇点，不是滚转。
  bankUsablePitchMaxDeg: 70,
};

/** 坡度读数是否可信。近垂直姿态下 φ 是任意值（见 LIMITS.bankUsablePitchMaxDeg）。 */
export function bankReadout(pitchDeg, phiDeg) {
  const usable = Math.abs(pitchDeg) <= LIMITS.bankUsablePitchMaxDeg;
  return { usable, deg: usable ? phiDeg : null };
}

/** 由接地瞬间的运动学参数定级。
 *  ⚠ 近垂直姿态（|θ| > bankUsablePitchMaxDeg）下 bankDeg 不可信，此时【只按垂直速度分级】。
 *    否则同一架飞机在穿越 θ=±90° 的过程中，前后 0.5 秒会被判成不同等级 ——
 *    “倒扣擦地”和“平飞擦地”可能得到同一个分级。
 *    注意 θ 本身没有奇点，所以 noseDown 判据不受影响。 */
export function classifyImpact(vsMps, bankDeg, pitchDeg) {
  const bankable = Math.abs(pitchDeg) <= LIMITS.bankUsablePitchMaxDeg;
  const ab = Math.abs(bankDeg);
  const noseDown = pitchDeg < -8;
  if (vsMps <= LIMITS.vsDestroyed || (bankable && ab >= LIMITS.bankDestroyedDeg)) return HULL.DESTROYED;
  if (vsMps <= LIMITS.vsSevere || (bankable && ab >= LIMITS.bankSevereDeg) || noseDown) return HULL.SEVERE;
  if (vsMps <= LIMITS.vsMinor || (bankable && ab >= LIMITS.bankMinorDeg)) return HULL.MINOR;
  return HULL.INTACT;
}

/** 撞地形（不是落地，是飞到地面之下）：不管速度多少，都按坠毁算 */
export function classifyTerrainStrike() { return HULL.DESTROYED; }

/**
 * 由「瞬时飞行状态 + 累积损伤」算出一份可显示的状态描述。
 *
 * 为什么放在这里、而不是各显示层自己写：3D 参照机标签与顶部状态带都要用同一份结果，
 * 各写一份迟早会漂开 —— 本项目已经栽过这种跟头（键位提示写着 Q/E 偏航，
 * 而方向舵在 NORMAL 法则下根本没接）。阈值也一并取本模块的 LIMITS，不再另立一套数。
 *
 * 返回 { text, color, dmg }：
 *   text/color = 【当前】飞行状态（每帧都可能变）
 *   dmg        = 【累积】损伤（不可逆，可为 null）
 * 但【终止态例外】：crashed 或 DESTROYED 直接返回 text="坠毁"、dmg=null。
 */
export function flightStateOf(st, aglM, hull, crashed = false) {
  if (!st) return null;
  // ── 终止态：直接钉死为坠毁，不再看任何瞬时量 ──
  // 实测到的自相矛盾显示：“参照机 正常 · 坠毁”。
  // 成因：瞬时状态是用【离地高度】判断的（≤1.3m 才算坠毁），而损伤是 latch 住的；
  // 飞机被标成已毁后仍在高空，就会同时得出“正常”和“坠毁”。
  // 关键区分：MINOR/SEVERE 是【可存活】状态（当前飞行状态仍有意义）；
  // DESTROYED 是【终止】状态（残骸不可能“正常”）。两者不能一样处理。
  if (crashed || hull === HULL.DESTROYED) return { text: "坠毁", color: "#ff6b6b", dmg: null };

  let text = "正常", color = "#7ee08a";
  if (Number.isFinite(aglM) && aglM <= LIMITS.gearHeightM) { text = "坠毁"; color = "#ff6b6b"; }
  else if (st.alpha >= LIMITS.alphaStallDeg) { text = "失速"; color = "#ff6b6b"; }
  else {
    const nz = -st.nz;                                   // 载荷因数约定 n_load = -n-pilot-z
    if (nz > LIMITS.nzMax || nz < LIMITS.nzMin) { text = "超载"; color = "#ffcf6b"; }
    else if (st.vc > LIMITS.vneKt) { text = "超速"; color = "#ffcf6b"; }
  }
  // 可存活的累积损伤：只做【后缀】，不顶掉当前状态
  let dmg = null;
  if (hull === HULL.SEVERE) dmg = { text: "结构超限", color: "#ff6b6b" };
  else if (hull === HULL.MINOR) dmg = { text: "轻损", color: "#ffcf6b" };
  return { text, color, dmg };
}

/** 两次失速播报之间至少要隔这么多物理步（120Hz 下 240 步 ≈ 2s） */
export const STALL_RELOG_STEPS = 240;

const RANK = { INTACT: 0, MINOR: 1, SEVERE: 2, DESTROYED: 3 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);

export class Consequences {
  constructor() { this.reset(); }

  reset() {
    this.hull = HULL.INTACT;
    this.stalledNow = false;
    this.everStalled = false;
    this.stallCount = 0;
    this.overG = false;
    this.overspeed = false;
    this.onGround = false;
    this.crashed = false;
    this.impact = null;        // { vsMps, bankDeg, bankUsable, pitchDeg, kind }
    this.peakAlpha = -Infinity;
    this.peakNz = -Infinity;
    this.peakVc = 0;
    this.peakVs = 0;
    this.pending = [];         // 待上层写入事件日志的条目
    this._stallLatched = false;
    // 初值必须直接给满冷却值：否则从 0 开始递增时前面的步数永远过不了阈值，
    // 真实的【首次失速】会被静默吞掉（回归测试抓到过）。
    this._stallQuiet = STALL_RELOG_STEPS;
  }

  _worse(h) {
    if (RANK[h] > RANK[this.hull]) { this.hull = h; this.pending.push({ level: "fail", text: `机体状态升至「${HULL_LABEL[h]}」` }); }
  }

  /**
   * 每物理步调用。
   * @param st      解包后的飞行状态
   * @param ctx     { aglM: 对【真实地形】的离地高度(m)，terrainKnown: bool }
   */
  update(st, ctx = {}) {
    const nz = -st.nz;
    this.peakAlpha = Math.max(this.peakAlpha, st.alpha);
    this.peakNz = Math.max(this.peakNz, nz);
    this.peakVc = Math.max(this.peakVc, st.vc);

    // ── 失速 ──
    // 实测：DIRECT 下失控时迎角会在阈值上下剧烈震荡，不加冷却会连发几十条，
    // 把事件日志刷满（实测 90 秒内 29 条）。这里要求至少隔 240 步（≈2s）才再报一次。
    this._stallQuiet++;
    this.stalledNow = st.alpha >= LIMITS.alphaStallDeg;
    if (this.stalledNow) {
      if (!this._stallLatched && this._stallQuiet >= STALL_RELOG_STEPS) {
        this._stallLatched = true;
        this._stallQuiet = 0;
        this.everStalled = true;
        this.stallCount++;
        this.pending.push({ level: "fail", text: `失速：迎角 ${st.alpha.toFixed(1)}° ≥ ${LIMITS.alphaStallDeg}°` });
      }
    } else if (st.alpha < LIMITS.alphaStallDeg - 2) {
      this._stallLatched = false;
    }

    // ── 结构超载 ──
    if ((nz > LIMITS.nzMax || nz < LIMITS.nzMin) && !this.overG) {
      this.overG = true;
      this.pending.push({ level: "fail", text: `结构超载：${nz.toFixed(2)}g（限制 ${LIMITS.nzMin}~${LIMITS.nzMax}g）` });
      this._worse(HULL.SEVERE);
    }

    // ── 超速 ──
    if (st.vc > LIMITS.vneKt && !this.overspeed) {
      this.overspeed = true;
      this.pending.push({ level: "fail", text: `超速：${st.vc.toFixed(0)}kt > Vne ${LIMITS.vneKt}kt` });
      this._worse(HULL.SEVERE);
    }

    // ── 触地 / 撞地（用真实地形高度判定）──
    if (ctx.terrainKnown && this.crashed === false) {
      const agl = ctx.aglM;
      const hit = agl <= LIMITS.gearHeightM;
      if (hit && !this.onGround) {
        this.onGround = true;
        const kind = agl < 0 ? "terrain" : "touchdown";
        const k = kind === "terrain"
          ? classifyTerrainStrike()
          : classifyImpact(ctx.vsMps ?? 0, st.phi, st.theta);
        const bk = bankReadout(st.theta, st.phi);
        this.impact = { vsMps: ctx.vsMps ?? 0, bankDeg: bk.deg, bankUsable: bk.usable,
                        pitchDeg: st.theta, kind, severity: k };
        this._worse(k);
        const bankTxt = bk.usable ? `坡度 ${st.phi.toFixed(0)}°` : "坡度不可用（近垂直姿态）";
        this.pending.push({
          level: k === HULL.INTACT ? "phase" : "fail",
          text: kind === "terrain"
            ? `撞地（地形）：垂直速度 ${((ctx.vsMps ?? 0) * 196.85).toFixed(0)} fpm，${bankTxt} → ${HULL_LABEL[k]}`
            : `接地：垂直速度 ${((ctx.vsMps ?? 0) * 196.85).toFixed(0)} fpm，${bankTxt} → ${HULL_LABEL[k]}`,
        });
        if (k === HULL.DESTROYED || k === HULL.SEVERE) this.crashed = true;
      } else if (!hit && agl > LIMITS.gearHeightM + 3) {
        this.onGround = false;
      }
    }
    return this.hull;
  }

  takePending() { const p = this.pending; this.pending = []; return p; }

  summary() {
    return {
      hull: this.hull, hullLabel: HULL_LABEL[this.hull],
      everStalled: this.everStalled, stallCount: this.stallCount,
      overG: this.overG, overspeed: this.overspeed, crashed: this.crashed,
      impact: this.impact,
      peakAlpha: +this.peakAlpha.toFixed(1), peakNz: +this.peakNz.toFixed(2),
      peakVc: +this.peakVc.toFixed(0),
    };
  }
}
