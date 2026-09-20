// 时间历程录制器 —— 可观测性基础设施
// ══════════════════════════════════════════════════════════════════
// 为什么需要它：
//   此前那个 Kbeta 符号错误（β 14–15°、方向舵饱和、速度掉到 67kt）是靠人肉眼
//   看出飞机"不对劲"才发现的。proof.mjs 全程只做纵向 A/B/C 断言，横航向的
//   β、方向舵、侧向过载**从未被画出来过、也从未被断言过**。
//   把状态量连续录下来，才谈得上"看见"和"复现"。
//
// 三个用途：
//   ① 条带图实时显示（趋势）
//   ② CSV 导出（离线分析 / 归档 / 回归对比）
//   ③ 事后复查（面板上的历史不会随 4 秒提示消失）

// ── 字段定义 ──
// 顺序即存储顺序，IDX 由它派生。新增字段只能**追加在末尾**，
// 否则历史 CSV 的列序会错位。
export const FIELDS = [
  { k: "t",     label: "仿真时间",   unit: "s",   group: "时间" },
  { k: "h",     label: "高度",      unit: "m",   group: "纵剖" },
  { k: "vc",    label: "空速",      unit: "kt",  group: "纵剖" },
  { k: "vs",    label: "升降率",    unit: "m/s", group: "纵剖" },
  { k: "alpha", label: "迎角α",     unit: "°",   group: "气动" },
  { k: "beta",  label: "侧滑角β",   unit: "°",   group: "气动" },
  { k: "nz",    label: "过载nz",    unit: "g",   group: "气动" },
  { k: "theta", label: "俯仰θ",     unit: "°",   group: "姿态" },
  { k: "phi",   label: "坡度φ",     unit: "°",   group: "姿态" },
  { k: "psi",   label: "航向ψ",     unit: "°",   group: "姿态" },
  { k: "elev",  label: "升降舵指令", unit: "",    group: "飞控" },
  { k: "ail",   label: "副翼指令",   unit: "",    group: "飞控" },
  { k: "rud",   label: "方向舵指令", unit: "",    group: "飞控" },
  { k: "trim",  label: "配平指令",   unit: "",    group: "飞控" },
  { k: "law",   label: "法则",      unit: "",    group: "飞控" },
  // 追加在末尾（上面的约定：新字段只能追加，否则历史 CSV 列序错位）。
  // 油门一直没被录下来过 —— 于是趋势图里没有它，导出的 CSV 里也没有它。
  { k: "thr",   label: "油门",      unit: "",    group: "飞控" },
];

export const IDX = Object.fromEntries(FIELDS.map((f, i) => [f.k, i]));
export const N_FIELDS = FIELDS.length;

// 法则用数字存，导出/显示时再映射回名字
export const LAW_CODE = { NORMAL: 0, ALTERNATE: 1, DIRECT: 2 };
export const LAW_NAME = ["NORMAL", "ALTN", "DIRECT"];

export class Recorder {
  /**
   * @param capacity    环形缓冲的点数上限（超出后覆盖最旧的）
   * @param every       每 N 个物理步记一次（120Hz / 2 = 60Hz 采样）
   * @param physicsRate 物理步进频率，用于换算采样率
   */
  constructor({ capacity = 36000, every = 2, physicsRate = 120 } = {}) {
    this.cap = capacity;
    this.every = every;
    this.physRate = physicsRate;
    this.buf = new Float64Array(capacity * N_FIELDS);
    this.head = 0;      // 下一个写入槽位
    this.count = 0;     // 已存点数（上限 cap）
    this.tick = 0;
    this.dropped = 0;   // 因容量满被覆盖的点数（提示用户"更早的数据已滚出"）
  }

  /** 实际采样率 Hz */
  get rate() { return this.physRate / this.every; }
  /** 缓冲覆盖的时间跨度（秒） */
  get span() { return this.count / this.rate; }

  /** 推入一行。row 是长度 N_FIELDS 的可复用数组（避免每帧产生垃圾） */
  pushRow(row) {
    if (this.tick++ % this.every) return;
    const o = this.head * N_FIELDS;
    for (let i = 0; i < N_FIELDS; i++) {
      const v = row[i];
      this.buf[o + i] = Number.isFinite(v) ? v : NaN;
    }
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    else this.dropped++;
  }

  clear() { this.head = 0; this.count = 0; this.tick = 0; this.dropped = 0; }

  /** 第 i 个样本的物理索引（0 = 最旧） */
  _slot(i) { return ((this.head - this.count + i) % this.cap + this.cap) % this.cap; }

  /** 读一个字段值：i = 样本序号，k = 字段名或 IDX */
  get(i, k) {
    if (i < 0 || i >= this.count) return NaN;
    const j = typeof k === "number" ? k : IDX[k];
    return this.buf[this._slot(i) * N_FIELDS + j];
  }

  /** 取 [from,to] 时间窗内的样本序号区间（左闭右开） */
  window(tFrom, tTo) {
    // buf 里的时间单调递增，可直接二分
    const t = (i) => this.get(i, "t");
    let lo = 0, hi = this.count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t(m) < tFrom) lo = m + 1; else hi = m; }
    const start = lo;
    hi = this.count;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t(m) <= tTo) lo = m + 1; else hi = m; }
    return [start, lo];
  }

  /** 某字段在样本区间内的极值（用于自适应量程） */
  range(k, i0 = 0, i1 = this.count) {
    let mn = Infinity, mx = -Infinity;
    for (let i = i0; i < i1; i++) {
      const v = this.get(i, k);
      if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
    }
    if (!Number.isFinite(mn)) return [NaN, NaN];
    return [mn, mx];
  }

  /** 导出 CSV 字符串 */
  toCSV(meta = {}) {
    const head = FIELDS.map((f) => (f.unit ? `${f.label}(${f.unit})` : f.label));
    const lines = [head.join(",")];
    const lawIdx = IDX.law;
    for (let i = 0; i < this.count; i++) {
      const s = this._slot(i) * N_FIELDS;
      const cells = new Array(N_FIELDS);
      for (let j = 0; j < N_FIELDS; j++) {
        const v = this.buf[s + j];
        if (j === lawIdx) cells[j] = LAW_NAME[v] ?? String(v);
        else if (!Number.isFinite(v)) cells[j] = "";
        else cells[j] = Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4);
      }
      lines.push(cells.join(","));
    }
    return lines.join("\n");
  }

  /** 触发浏览器下载 */
  download(meta = {}) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const name = `fcs-trace_${ts}_${this.count}pts.csv`;
    const blob = new Blob(["\ufeff" + this.toCSV(meta)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { name, bytes: blob.size };
  }
}
