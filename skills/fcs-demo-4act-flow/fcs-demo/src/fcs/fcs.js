// 闭环飞控系统（FCS）v2
// ============================================================
// 飞控夹在"侧杆"和"舵面"之间：飞行员给意图 → 飞控算舵面指令 →
// 写入 fcs/*-cmd-norm → JSBSim 直通通道转成真实舵面偏转 → 气动力矩 → 飞机响应。
//
// 已实测符号约定（勿改，改了就是正反馈发散）：
//   elevator-cmd 正 → 低头 (θ↓, q↓, 载荷↓)   要抬头/加载荷须用负值
//   aileron-cmd  正 → 右滚 (φ↑, p↑)
//   rudder-cmd   正 → 左偏航 (r↓)
//   载荷因数 n_load = -accelerations/n-pilot-z-norm
// ============================================================

export const LAW = { NORMAL: "NORMAL", ALTERNATE: "ALTERNATE", DIRECT: "DIRECT" };
const SEVERITY = { NORMAL: 0, ALTERNATE: 1, DIRECT: 2 };   // 数字越大越降级

// 机体损伤 → 舵面权限 / 作动速率（比例）。
// 这是把 consequences 的机体状态【真正接进飞行】的地方。
// 原来 INTACT/MINOR/SEVERE 只是标签：实测飞机被标成“结构超限”后照样飞得好好的
// （+10s 后 α=-0.3°、nz=0.67，与未受损无差别），于是看起来像“自己恢复了”。
// 衰减写法沿用本模块已有的作动器降级（elevator_actuator 故障 → 权限 35%）。
// 权限降低 = 杆位“推不动那么多舵”；速率降低 = 响应变迟钝。两者都能在画面上看出来。
export const DAMAGE_AUTH = { INTACT: 1.0, MINOR: 0.75, SEVERE: 0.45 };
export const DAMAGE_RATE = { INTACT: 1.0, MINOR: 0.80, SEVERE: 0.55 };

export const P = {
  // 纵向
  nzPerStick: 2.0, nzMin: -1.0, nzMax: 2.5,
  KpNz: 0.45, KiNz: 0.10, Kq: 0.85,
  Kgamma: 0.30, Ktheta: 0.30,
  trimWashout: 0.9, trimLimit: 0.5,
  // 横航向
  pMax: 1.05, KpRoll: 0.85, KphiRoll: 0.30,
  Kr: 0.80, Kbeta: -0.35,
  // 脚舵权限（比例）。DIRECT 下是满权限 1.0（rud = -stick.yaw）。
  // 原来 NORMAL/ALTN 完全没有这一项 —— 方向舵只由阻尼与协调转弯驱动，
  // 于是按 Q 和按 E 输出的 rud 逐位相同（实测都是 0.0018），Q/E 等于没接。
  Kpedal: 0.55,
  // 低于此视为“松舵”，协调转弯才参与。
  // 必须要有死区：脚舵是 0/1 的键盘输入，没死区就无法区分“松舵”和“轻踩”。
  pedalDeadband: 0.02,
  // 包线保护
  alphaProt: 12.0, alphaMax: 15.0,
  thetaMin: -15, thetaMax: 25,
  bankMax: 55, bankReturn: 30,
  // 载荷硬限的推回增益（每超出 1g 给多少能面指令）。
  // 与迎角硬上限同构，但【必须无条件生效】—— 详见 update() 里那段注释。
  KnzHard: 0.5,
  // 作动器
  elevRate: 3.5,
};

export class FCS {
  constructor(commandedLaw = LAW.NORMAL) {
    this.commandedLaw = commandedLaw;   // 人工选择的法则（展示时可由演示台切换）
    this.law = commandedLaw;
    this.faults = new Set();
    this.protTags = new Set();
    this.Ierr = 0;
    this.trim = 0;
    this.gammaRef = null;
    this.bankRef = null;          // null = 需要重新锁存（与 gammaRef 同构的哨兵）
    this.lastOut = { elev: 0, ail: 0, rud: 0 };
    this.damage = "INTACT";       // 机体损伤等级（与 consequences 的 HULL 同名）
    this.statusLog = [];
  }

  setLaw(law) { this.commandedLaw = law; this.reevaluate(); return this.law; }

  /** 设置机体损伤等级。只影响舵面权限/速率，不改法则也不改保护逻辑。 */
  setDamage(hull) {
    this.damage = DAMAGE_AUTH[hull] !== undefined ? hull : "INTACT";
    return this.damage;
  }

  injectFault(name) { this.faults.add(name); return this.reevaluate(); }
  clearFault(name) { this.faults.delete(name); return this.reevaluate(); }
  clearAllFaults() { this.faults.clear(); return this.reevaluate(); }

  // ---- 降级逻辑：法则只能"变差"，不能自动恢复 ----
  reevaluate() {
    const ahrsOk = !this.faults.has("ahrs");
    const alphaOk = !this.faults.has("alpha_sensor");
    let allowed = LAW.NORMAL;
    if (!alphaOk) allowed = LAW.ALTERNATE;
    if (!ahrsOk) allowed = LAW.DIRECT;

    // 取"人工选择"与"故障允许"中更降级的那一个
    const next = SEVERITY[allowed] > SEVERITY[this.commandedLaw] ? allowed : this.commandedLaw;
    const prev = this.law;
    this.law = next;
    if (prev !== next) {
      this.statusLog.push({ from: prev, to: next, reason: [...this.faults].join("+") || "manual" });
    }
    return this.law;
  }

  _alpha(st) { return this.faults.has("alpha_sensor") ? 0 : st.alpha; }
  _nz(st) { return -st.nz; }
  _gamma(st) { return st.theta - this._alpha(st); }   // 航迹角 ≈ 俯仰角 − 迎角

  update(st, stick, dt) {
    this.protTags.clear();
    const alpha = this._alpha(st);
    const alphaUsable = !this.faults.has("alpha_sensor");
    const ahrsUsable = !this.faults.has("ahrs");
    const nz = this._nz(st);
    const q = ahrsUsable ? st.q : 0;

    let elevTotal, ail, rud;

    // ── 「DIRECT 法则等价输出」：杆位直连舵面，并同样经过**本层的**作动器限速 ──
    // 存在的理由：渲染层的幽灵参考需要它。不能在渲染层拿杆位自己重算 ——
    // 因为升降舵在 FCS 里就已经被 elevRate 限速了（而且只有升降舵有这层限速，
    // 副翼/方向舵没有），两个限速器不同步，幽灵会在过渡段说谎。
    // 实测（experiments/ghost-probe.mjs）：DIRECT 下松杆，out.elev 以 ~3.3/s
    // 衰减（≈ elevRate 3.5），而渲染层 slew 是 3.2/s，于是两者分叉。
    // 放在这里算，保证幽灵与真实舵面出自【同一次调用】且经过同一套限速。
    const dTgt = -stick.pitch;
    const dRate = P.elevRate * dt;
    const dPrev = this.directOut ? this.directOut.elev : 0;
    this.directOut = {
      elev: dPrev + Math.max(-dRate, Math.min(dRate, dTgt - dPrev)),
      ail: stick.roll,
      rud: -stick.yaw,
    };

    // ══════════ 直接法则：杆位直连舵面，无增稳/无保护/无自动配平 ══════════
    if (this.law === LAW.DIRECT) {
      elevTotal = -stick.pitch;
      ail = stick.roll;
      rud = -stick.yaw;
      this.Ierr = 0;
      // 配平轮位置是【机体状态】，不随法则归零 —— 真实的 DIRECT 降级里，配平轮不会
      // 自己弹回零位。原来这里写 this.trim = 0，后果是：一进 DIRECT 就失去配平，
      // 而本应用没有手配平控件，于是它必然掉头下坠 —— 连“以平飞开局”都做不到。
      // 保持配平量、只是不再继续洗出（洗出在上面的 else 分支里），才是“不再自动配平”。
      this.gammaRef = null;
      this.bankRef = null;
    } else {
      const neutralPitch = Math.abs(stick.pitch) < 0.05;

      // ---------- 纵向外环：杆中位保持航迹角；杆偏转则指令载荷因数 ----------
      let total;
      if (neutralPitch) {
        if (this.gammaRef === null) this.gammaRef = this._gamma(st);   // 松杆瞬间锁存航迹
        const gErr = this.gammaRef - this._gamma(st);                  // deg，正=需要爬升
        total = -P.Kgamma * (gErr / 10);                               // 负指令=抬头
        this.protTags.add("FPA HOLD");
      } else {
        this.gammaRef = null;
        let nzCmd = 1 + stick.pitch * P.nzPerStick;
        if (this.law === LAW.NORMAL) {
          if (nzCmd > P.nzMax) { nzCmd = P.nzMax; this.protTags.add("LOAD"); }
          if (nzCmd < P.nzMin) { nzCmd = P.nzMin; this.protTags.add("LOAD"); }
          if (alphaUsable && alpha > P.alphaProt) {
            this.protTags.add("ALPHA PROT");
            nzCmd = Math.min(nzCmd, nz);        // 不再允许继续加载荷
          }
        }
        const err = nzCmd - nz;
        // 积分【照常累积】，±2 的限幅就是抗饱和保护。
        // 曾试过在这里加一条「指令一被限幅就冻结积分」的抗饱和 —— 那是错的：
        // 饱和发生在【作动器】（末尾的 c(elevCmd)），而满杆时指令被限到 2.5g 是常态，
        // 不是异常。在那里冻结的后果是 Ierr 全程恒为 0，俯仰通道的积分项被废掉，
        // 而它只换来了 0.08g 的峰值改善（3.68→3.60）。控制项比那 0.08g 重要。
        // 若将来要做真正的抗饱和，位置应挂在作动器饱和上（back-calculation）。
        this.Ierr = Math.max(-2, Math.min(2, this.Ierr + err * dt));
        total = -(P.KpNz * err + P.KiNz * this.Ierr);
      }

      // 俯仰姿态保护
      if (this.law === LAW.NORMAL) {
        if (st.theta > P.thetaMax) { total = Math.max(total, 0); this.protTags.add("PITCH"); }
        if (st.theta < P.thetaMin) { total = Math.min(total, 0); this.protTags.add("PITCH"); }
      }
      // 俯仰角速率阻尼（正 q 需正指令抑制）
      total += P.Kq * q * 0.05;

      // 迎角硬上限：无条件强制推出
      if (this.law === LAW.NORMAL && alphaUsable && alpha > P.alphaMax) {
        total += 0.35 * (alpha - P.alphaMax);
        this.protTags.add("ALPHA MAX");
      }

      // ── 载荷硬限：与迎角硬上限同构，但【必须放在所有分支之后】──
      // 原来 nzCmd 的 nzMax/nzMin 限幅只写在「俯仰杆偏转」那条分支里，
      // 俯仰杆回中时走的是 FPA HOLD（保持航迹角），那条路径【没有任何载荷上限】。
      // 实测：按住 D 滚到 109°（倒扣），FPA HOLD 为了拉住航迹角把 nz 推到 4.25g
      // → 触发结构超限。在 75° 坡度保持平飞转弯确实需要 1/cos(75°)=3.86g，
      // 所以问题不在物理，而在真机的电传法则绝不会让你到那个姿态。
      // 符号：total 正 = 低头；nz 偏大要卸荷（推头）→ 正；偏小要加载（拉头）→ 负。
      if (this.law === LAW.NORMAL && ahrsUsable) {
        if (nz > P.nzMax) { total += P.KnzHard * (nz - P.nzMax); this.protTags.add("LOAD"); }
        else if (nz < P.nzMin) { total -= P.KnzHard * (P.nzMin - nz); this.protTags.add("LOAD"); }
      }
      elevTotal = total;

      // ---------- 自动配平：把稳态舵面偏转 washout 到 THS 配平上 ----------
      if (this.law === LAW.NORMAL && ahrsUsable) {
        this.trim += P.trimWashout * (elevTotal - this.trim) * dt * 10;
        this.trim = Math.max(-P.trimLimit, Math.min(P.trimLimit, this.trim));
      }

      // ---------- 横向 ----------
      // 与俯仰通道同构：杆中位才需要参考，压杆时把参考清空（纯速率指令），
      // 松杆瞬间用 bankRef === null 作哨兵重新锁存当前坡度。
      const neutralRoll = Math.abs(stick.roll) < 0.05;
      // 坡度保护的状态判断【与杆位无关】—— 这是关键。
      const overBank = this.law === LAW.NORMAL && ahrsUsable && Math.abs(st.phi) > P.bankMax;
      if (overBank) this.protTags.add("BANK");

      if (neutralRoll) {
        if (this.bankRef === null) {
          let ref = st.phi;
          if (overBank) ref = Math.sign(ref) * P.bankReturn;
          this.bankRef = ref;
        }
        if (ahrsUsable) this.protTags.add("BANK HOLD");
        // 速率环 + 坡度保持环（坡度误差是“度”，按俯仰通道同样的 /10 归一化）
        ail = P.KpRoll * (0 - (ahrsUsable ? st.p : 0))
            + P.KphiRoll * ((this.bankRef - (ahrsUsable ? st.phi : 0)) / 10);
      } else {
        this.bankRef = null;                 // 压杆：清空坡度参考
        const pCmd = stick.roll * P.pMax;    // 纯速率指令，满杆 = pMax rad/s
        ail = P.KpRoll * (pCmd - (ahrsUsable ? st.p : 0));
      }
      // ── 坡度保护：无条件生效，按住滚转杆也绕不过去 ──
      // 原来 bankMax 只写在 neutralRoll 分支里，于是只要【按住】滚转杆就能把它绕过：
      // 实测按住 D 可滚到 109°（倒扣），之后 FPA HOLD 拉杆追航迹角 → nz 4.25g → 结构超限。
      // 真机的坡度保护同样是常开的，不随杆位开关。
      if (overBank) {
        ail = P.KpRoll * (0 - st.p)
            + P.KphiRoll * ((Math.sign(st.phi) * P.bankReturn - st.phi) / 10);
      }
      if (this.law === LAW.ALTERNATE) ail *= 0.6;   // 备用法则滚转权限降低

      // ---------- 偏航：脚舵 + 阻尼 + 协调转弯 ----------
      // 脚舵权限是必须的（原来这段里根本没有 stick.yaw，Q/E 在 NORMAL 下等于没接）。
      // 踩舵时【协调转弯让位】：beta 反馈项会把飞行员刻意建立的侧滑立刻拉平，
      // 不让位的话“加了权限”也只是数字好看、现象照旧。
      // 只让协调项退位、保留 Kr*r —— 那是【速率】阻尼，稳态侧滑时 r→0
      // 它自然归零、不会和飞行员对拉，但能继续压住荷兰滚。
      const pedal = -stick.yaw;                      // 符号同 DIRECT：rud = -yaw
      const coordinating = Math.abs(pedal) <= P.pedalDeadband;
      rud = P.Kpedal * pedal
          + P.Kr * (ahrsUsable ? st.r : 0)
          + (coordinating ? P.Kbeta * (ahrsUsable ? st.beta : 0) : 0);
    }

    // ---------- 作动器模型 ----------
    const auth = DAMAGE_AUTH[this.damage] ?? 1;
    const rateScale = DAMAGE_RATE[this.damage] ?? 1;
    const rate = P.elevRate * rateScale * dt;
    const c = (v) => Math.max(-1, Math.min(1, v));
    // 权限衰减作用在【指令】上，而不是最后乘在输出上：
    // lastOut 要参与下面的速率限制，两边得同量纲，否则限速会拿
    // “未衰减的指令”去比“已衰减的上一步输出”，在受损后凭空多出一个台阶。
    let elevCmd = this.law === LAW.DIRECT ? elevTotal : elevTotal - this.trim;
    elevCmd *= auth;
    elevCmd = Math.max(this.lastOut.elev - rate, Math.min(this.lastOut.elev + rate, elevCmd));
    if (this.faults.has("elevator_actuator")) {
      elevCmd = this.lastOut.elev + (elevCmd - this.lastOut.elev) * 0.35;   // 权限降到 35%
    }
    ail *= auth;
    rud *= auth;
    if (this.faults.has("aileron_jam")) ail = this.lastOut.ail;
    if (this.faults.has("rudder_jam")) rud = this.lastOut.rud;

    const out = { elev: c(elevCmd), ail: c(ail), rud: c(rud), trim: c(this.trim) };
    this.lastOut = out;
    // 幽灵参考用：与 out 同源同限速的「无增稳」对照值
    this.directOut.elev = c(this.directOut.elev);
    this.directOut.ail = c(this.directOut.ail);
    this.directOut.rud = c(this.directOut.rud);
    return out;
  }

  annunciate() {
    const lost = this.law !== LAW.NORMAL;
    return {
      law: this.law,
      lawText: this.law === LAW.NORMAL ? "NORMAL LAW" : this.law === LAW.ALTERNATE ? "ALTN LAW" : "DIRECT LAW",
      protText: lost ? "PROT LOST" : "",
      tags: [...this.protTags],
      faults: [...this.faults],
    };
  }
}
