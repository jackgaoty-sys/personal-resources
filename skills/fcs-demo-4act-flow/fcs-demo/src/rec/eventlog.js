// 飞控事件日志 —— 持久化、分级、可回溯
// ══════════════════════════════════════════════════════════════════
// 为什么需要它：
//   改造前，飞控唯一对外说的话是 app.say() —— 一个 4 秒后自动消失的提示。
//   而 fcs.statusLog 明明已经把"法则何时降级、因为什么故障"记下来了，
//   却从未被渲染出来。结果就是：**演示里最该被看到的信息（为什么降级）恰恰是丢掉的。**
//
// 分级照抄航空惯例：信息 / 模式 / 阶段 / 硬件 / 注意 / 故障
// 严重度递增，配色随之从灰→青→紫→绿→琥珀→红。

export const LEVEL = {
  info:  { label: "INFO",  color: "#7d8fa4" },
  mode:  { label: "MODE",  color: "#00d9ff" },
  phase: { label: "PHASE", color: "#b388ff" },
  hw:    { label: "HW",    color: "#00e676" },
  alert: { label: "ALERT", color: "#ffab00" },
  fail:  { label: "FAIL",  color: "#ff3d3d" },
};

export class EventLog {
  constructor({ capacity = 800 } = {}) {
    this.cap = capacity;
    this.items = [];
    this._seq = 0;
  }

  /**
   * 记一条。返回是否真的写入（用于判断是否需要刷新 DOM）。
   * 去重规则：同一文本在 window 秒内不重复记。
   * 必要性：保护介入是**每步**都在触发的（protTags 每步重建），
   * 不去重的话日志会被同一个事件瞬间刷满。
   */
  push(t, level, text, dedupWindow = 1.0) {
    if (!LEVEL[level]) level = "info";
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i];
      if (t - e.t > dedupWindow) break;
      if (e.text === text) return false;
    }
    this.items.push({ t, level, text, seq: ++this._seq });
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
    return true;
  }

  /** 按时间倒序取最近 n 条（最新的在最前，便于面板直接渲染） */
  recent(n = 120) {
    return this.items.slice(-n).reverse();
  }

  get count() { return this.items.length; }

  clear() { this.items.length = 0; this._seq = 0; }
}
