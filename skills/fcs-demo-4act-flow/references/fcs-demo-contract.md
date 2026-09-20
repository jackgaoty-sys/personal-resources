# fcs-demo 接口契约（已核实）

> 本文件记录**实测确认过**的接口细节。写驱动脚本、改补丁锚点、断言状态时以此为准，
> 不要凭记忆猜。源码位置以 `$FCS_DEMO` 为根。

---

## 1. 目录与职责

```
fcs-demo/
├─ index.html                     布局与样式（UI 元素 id 都在这里）
├─ vite.config.js                 dev base "/"，build base "/fcs-demo/"；optimizeDeps.exclude 必须保留
├─ public/data/                   JSBSim WASM + 机型/发动机数据（"气动数据"就在这里）
│  ├─ jsbsim_wasm.wasm            1.5 MB 内核
│  ├─ aircraft/c172p/c172p.xml    气动/质量/几何数据
│  └─ engine/{eng_io320,prop_75in2f}.xml
├─ src/
│  ├─ main.js            ★ 主循环 / 输入 / 事件采集 / 演示控制条 / 启动
│  ├─ fcs/fcs.js         ★ 飞控核心（自己写的部分）
│  ├─ fcs/consequences.js         失速/超限/触地判定（纯函数状态机，可 Node 直跑）
│  ├─ fdm/adapter.browser.js      ★ 浏览器版 FDM 适配层（气动开关的注入点）
│  ├─ fdm/jsbsimAdapter.js        Node 版（实验用，走 fs）
│  ├─ displays/cockpit.js         PFD / ECAM / 2D 视景
│  ├─ displays/trend.js           时间历程条带图
│  ├─ rec/recorder.js             时间历程录制 + CSV 导出
│  ├─ rec/eventlog.js             分级事件日志
│  └─ scene/{scene3d,geo}.js      3D 视景 + 真实地理底图
├─ experiments/                   验证脚本（*.mjs）与对照实验产出
└─ screenshots/                   既有截图
```

启动：`npm run dev` → `http://localhost:5173/`（dev 下 base 为 `/`，**不带** `/fcs-demo/` 前缀）。

---

## 2. FDM 适配层契约 ★ 气动开关的立足点

`src/fdm/adapter.browser.js` 导出：

```js
export async function createFdm({ ic = {}, onLog } = {})
//   → { sdk, readState(out?), get(p), set(p, v), step(), reset() }
export function unpack(stateFloat64Array) // → { h, hAgl, vc, vt, theta, phi, psi, alpha, beta, p, q, r, nz, mach, lat, lon }
export const STATE_PATHS = [...]           // 数组下标即状态数组布局
export const I = { [path]: index }
```

`main.js` 对 FDM 的**全部**用法（grep 实测，只有这些）：

```js
app.fdm.reset();                                   // :114  app.reset()
const st = unpack(app.fdm.readState());            // :269  physicsStep()
app.fdm.set("fcs/throttle-cmd-norm", app.throttle);      // :275
app.fdm.set("fcs/elevator-cmd-norm", u.elev);            // :276
app.fdm.set("fcs/aileron-cmd-norm",  u.ail);             // :277
app.fdm.set("fcs/rudder-cmd-norm",   u.rud);             // :278
app.fdm.set("fcs/pitch-trim-cmd-norm", u.trim);          // :279
app.fdm.step();                                          // :280
```

> **`.sdk` 从未被 `src/` 使用**（grep 确认）。所以假 FDM 返回 `sdk: null` 完全安全。

### STATE_PATHS 的真实顺序（假 FDM 必须一一对应）

| idx | 属性 | 单位 |
|---|---|---|
| 0 | `position/h-sl-ft` | ft |
| 1 | `position/h-agl-ft` | ft |
| 2 | `velocities/vc-kts` | kt |
| 3 | `velocities/vt-fps` | ft/s |
| 4 | `attitude/theta-deg` | ° |
| 5 | `attitude/phi-deg` | ° |
| 6 | `attitude/psi-deg` | ° |
| 7 | `aero/alpha-deg` | ° |
| 8 | `aero/beta-deg` | ° |
| 9 | `velocities/p-aero-rad_sec` | rad/s |
| 10 | `velocities/q-aero-rad_sec` | rad/s |
| 11 | `velocities/r-aero-rad_sec` | rad/s |
| 12 | `accelerations/n-pilot-z-norm` | g（**注意符号见下**） |
| 13 | `velocities/mach` | — |
| 14 | `position/lat-geod-deg` | ° |
| 15 | `position/long-gc-deg` | ° |

**单位陷阱**：`st.h` 是 **ft**，`main.js` 自己乘 `FT2M = 0.3048` 换成米；
`app.vs` 也是 `main.js` 用相邻两帧高度差算的（m/s），**FDM 不提供 vs**。

**符号陷阱**：载荷因数的约定是 `n_load = -accelerations/n-pilot-z-norm`
（`fcs.js` 与 `main.js` 的 `observe()` 都按这个写）。假 FDM 直接往
`accelerations/n-pilot-z-norm` 写值即可，`unpack` 出来的 `nz` 会被上层再取负。

### 初始条件默认值（`createFdm` 内 `defaults`）

```
ic/h-sl-ft 4500 · ic/vc-kts 110 · ic/theta-deg 2 · ic/phi-deg 0 · ic/psi-deg 0 · ic/beta-deg 0
fcs/throttle-cmd-norm 0.62 · ic/lat-geod-deg 38.50 · ic/long-gc-deg -122.35   （纳帕谷）
```

`reset()` 的实现是 `resetToInitialConditions(2)` + 重放 IC。
假 FDM 的 `reset()` 只需回到初始条件。

---

## 3. 主循环与常量

| 常量 | 值 | 说明 |
|---|---|---|
| `RATE` | 120 | 物理步进 Hz |
| `DT` | 1/120 | 定步长 |
| `THROTTLE_INIT` | 0.62 | 与 FDM 的 IC 同值 |
| `THROTTLE_RATE` | 0.48 | 每秒油门行程（暂停时也用同一速率积分） |

- 渲染用 `lerpSt(prevSt, st, alpha)` 在前后物理步之间插值（`alpha = acc/DT`）。
- 暂停语义：**不推进物理也不累积时间**，`acc` 原封不动 → 恢复时没有"追赶爆发"。
  暂停时 `scene.update` 收 `dt=0`（否则螺旋桨会转、环绕视角会转）。
- 倍速通过放大 `acc` 实现，带 12 ms 帧预算。
- 坠毁 = **终止态**：冻结 + 锁定控件（`CRASH_LOCK` 列表），只留 `R`/遮罩按钮重开。
  刻意**不锁**相机切换与 CSV 导出（都不推进物理）。

### 配平（理解第 3 幕现象的关键）

`app.trimThenOpen(6)`：先**固定用 NORMAL 法则**跑 6 秒把飞机配平到平飞，再把法则切到
本次运行的"开局法则"，并**把配平量 `fcs.trim` 带过去**。

- 配平必须用 NORMAL：DIRECT 既没增稳也没自动配平，拿它配平只会越配越偏。
- 启动总过程：`createFdm`（真机）→ `createFdm`（幽灵机）→ `trimThenOpen(6)` → `initView()` → `bindButtons()`。
- 所以**首屏不是 t=0 的初始条件，而是配平后的平飞状态**。
  第 3 幕"乱飞"版本里，这 6 秒配平发生在无气动模型上，结果自然也不对 —— 这是正常的。

---

## 4. 飞控（`src/fcs/fcs.js`）

```js
export const LAW = { NORMAL, ALTERNATE, DIRECT };
export const DAMAGE_AUTH = { INTACT: 1.0, MINOR: 0.75, SEVERE: 0.45 };
export const P = { ...增益与限幅... };
export class FCS {
  constructor(commandedLaw = LAW.NORMAL)
  setLaw(law) / setDamage(hull) / injectFault(name) / clearFault(name) / clearAllFaults()
  reevaluate()            // 法则只能"变差"，不能自动恢复
  update(st, stick, dt)   // → { elev, ail, rud, trim }
  annunciate()            // → { law, lawText, protText, tags, faults }
  // 字段：law, commandedLaw, faults(Set), protTags(Set), trim, damage, statusLog[], lastOut, directOut
}
```

### 法则降级链

| 故障 | 结果 |
|---|---|
| （无） | NORMAL |
| `alpha_sensor` | 允许降到 ALTERNATE |
| `ahrs` | 允许降到 DIRECT |

取"人工选择"与"故障允许"中**更降级**的那一个。变更记进 `fcs.statusLog`
（`{from, to, reason}`），由 `main.js` 的 `drainLawEvents()` 搬进事件日志。

### 五类故障（`injectFault` 的名字，必须一字不差）

`alpha_sensor` · `ahrs` · `elevator_actuator`（权限降到 35%）· `aileron_jam` · `rudder_jam`

### 保护标签（`protTags`）

- 模式类（不是告警）：`FPA HOLD`、`BANK HOLD`
- 保护类（是告警）：`ALPHA PROT`、`ALPHA MAX`、`LOAD`、`PITCH`、`BANK`

`main.js` 用 `MODE_TAGS = new Set(["FPA HOLD", "BANK HOLD"])` 把两类分开 ——
不分的话一上电就报"保护介入"，把正常工作状态说成告警。

### 舵面符号约定（**勿改**）

```
elevator-cmd 正 → 低头 (θ↓, q↓, 载荷↓)    ← 要抬头须用负值
aileron-cmd  正 → 右滚 (φ↑, p↑)
rudder-cmd   正 → 左偏航 (r↓)
```

改错就是正反馈发散（文件头有实测记录）。

---

## 5. 后果系统（`src/fcs/consequences.js`）

```js
export const HULL = { INTACT, MINOR, SEVERE, DESTROYED };
export const HULL_LABEL = { INTACT:"完好", MINOR:"轻损", SEVERE:"结构超限", DESTROYED:"坠毁" };
export const LIMITS = {
  alphaStallDeg: 16.0, alphaBuffetDeg: 13.5,
  nzMax: 3.8, nzMin: -1.5, vneKt: 160,
  gearHeightM: 1.30,
  vsMinor: -1.5, vsSevere: -3.0, vsDestroyed: -6.0,        // m/s
  bankMinorDeg: 10, bankSevereDeg: 25, bankDestroyedDeg: 45,
  bankUsablePitchMaxDeg: 70,     // |θ|>70° 时 φ 是欧拉角奇点产物，不可用
};
export class Consequences { update(st, {aglM, vsMps, terrainKnown}); takePending(); reset(); hull; crashed; impact; everStalled }
export function flightStateOf(st, aglM, hull, crashed)  // → { text, color, dmg }
```

- 警告灯（`#annun`）**正常时全灭**，异常才亮；两级：`warning`(红) / `caution`(琥珀)。
- 瞬时告警有 3 秒最短驻留（`ANNUN_DWELL_MS`），因为失速窗口实测只有约 2 秒。
- 损伤**真正接进飞行**：`app.fcs.setDamage(app.con.hull)` → 衰减舵面权限/作动速率。
  所以"结构超限"不只是标签，飞机真的会变笨。
- 离地高度优先用 **3D 真实地形**（`scene.terrainHeightAt`），
  因为 JSBSim 的地面是平面，山头比飞机高它也不会察觉。

---

## 6. UI 元素 id（自动化与补丁都靠它）

**顶栏 `#topbar`**：`clock` `lawBadge` `protoTags` `pauseBtn` `rates` `preset` `csvBtn` `collapseAll`
（本 Skill 增加：`aeroBtn`）

**面板**：`logPanel`/`logList`/`logCount` · `instPanel`/`pfd`/`ecam` · `trendPanel`/`trend`/`trendTabs`

**底栏 `#barBottom`**：`initLaw` · `lawNormal`/`lawAltn`/`lawDirect` ·
`fAlpha`/`fAhrs`/`fElev`/`fAil`/`fRud` · `camBtn` · `ghostLblBtn` · `reset`

**其他**：`boot`/`bootText` · `ext`（3D 容器）· `annun`（警告灯）·
`crashOverlay`/`crashCause`/`crashRestart` · `ui`

### 键盘

`W/S`（或 `↑/↓`）俯仰 · `A/D`（或 `←/→`）滚转 · `Q/E` 偏航 · `T/G` 油门 ·
`空格` 暂停 · `R` 重置 · `C` 视角 · `V` 参照机开关

> `keydown` 长按会连发，`main.js` 统一在分发离散动作前 `if (e.repeat) return`。
> 自动化发送按键时不要依赖长按触发离散动作，**用 `keyboard.down/up` + 明确的间隔**。

### 视角

`chase` 追机 / `cockpit` 座舱 / `cinematic` 环绕（`C` 键或 `camBtn` 轮换）。
座舱视角会给 `body` 加 `cam-cockpit` 类（仪表盘居中）。

---

## 7. 场景预设（`PRESETS`，第 4 幕一键演示用）

| id | 名称 | 故障 |
|---|---|---|
| `normal` | 正常法则（基线） | — |
| `alpha` | α 传感器失效 → ALTN LAW | `alpha_sensor` |
| `ahrs` | AHRS 失效 → DIRECT LAW | `ahrs` |
| `elev` | 升降舵作动器降级（35% 权限） | `elevator_actuator` |
| `ail` | 副翼卡阻 | `aileron_jam` |
| `rud` | 方向舵卡阻 | `rudder_jam` |
| `multi` | 多重故障（AHRS + 副翼卡阻） | `ahrs` + `aileron_jam` |

`applyPreset(id)` 的语义是**开一次全新的运行**：`app.reset()` → 注入故障 → 冲刷日志 → 记两条事件。

---

## 8. 记录与日志（导出物）

### Recorder（`rec/recorder.js`）→ CSV 列序

`Recorder({capacity: 36000, every: 2, physicsRate: 120})` → 实际 60 Hz 采样，覆盖 600 s。

CSV 表头（**顺序即列序，新字段只能追加**）：

```
仿真时间(s), 高度(m), 空速(kt), 升降率(m/s), 迎角α(°), 侧滑角β(°), 过载nz(g),
俯仰θ(°), 坡度φ(°), 航向ψ(°), 升降舵指令, 副翼指令, 方向舵指令, 配平指令, 法则, 油门
```

- `法则` 列是 `NORMAL/ALTN/DIRECT` 文本。
- 导出文件名：`fcs-trace_<ISO时间>_<点数>pts.csv`，带 UTF-8 BOM。

### EventLog（`rec/eventlog.js`）→ 分级

`info`(灰) `mode`(青) `phase`(紫) `hw`(绿) `alert`(琥珀) `fail`(红)；
同一文本 `dedupWindow` 秒内不重复记；容量 800 条，`recent(n)` 返回倒序。

### 自动化入口

`bindButtons()` 末尾有 `window.app = app;` ——
**所有状态都能从 `window.app` 读到**，这是驱动脚本/断言的基础：

```js
window.app.st            // { h, hAgl, vc, vt, theta, phi, psi, alpha, beta, p, q, r, nz, mach, lat, lon }
window.app.out           // { elev, ail, rud, trim }
window.app.fcs.law       // "NORMAL" | "ALTERNATE" | "DIRECT"
window.app.fcs.protTags  // Set
window.app.fcs.faults    // Set
window.app.simT          // 仿真时间 s
window.app.paused        // bool
window.app.rec.count     // 已录点数
window.app.log.count     // 日志条数
window.app.con.hull      // "INTACT" | ...
window.app.use3d         // 3D 是否可用
window.app.scene.getMode()
```

（气动开关补丁再加一个 `window.__AERO__`。）

> ⚠ `app.st` 是**配平后**的当前步状态；首帧渲染前 `app.st` 为 `null`。
> 驱动脚本等待就绪的条件应为 `window.app && window.app.st && window.app.simT > 0`。

---

## 9. 现存验证脚本（可直接复用的证据来源）

```
experiments/proof.mjs              ★ 对照实验：证明飞控影响飞行（A/B/C 组）
experiments/sign-test.mjs          舵面符号约定实测
experiments/verify-browser-path.mjs 浏览器加载路径验证
experiments/pause-test.mjs         暂停语义（15/15）
experiments/cockpit-panel-check.mjs 座舱面板比例
experiments/consequence-test.mjs   后果分级
```

对照实验产出（**第 3 幕的现成证据**）：

```
experiments/out/A1_无飞控_DIRECT.csv   A2_有飞控_NORMAL.csv
experiments/out/B1_无飞控_DIRECT.csv   B2_有飞控_NORMAL.csv
experiments/out/C1_传感器正常.csv      C2_传感器故障.csv
```

这些 CSV 的列是精简版（`t,h_ft,vc_kts,theta_deg,phi_deg,alpha_deg,nz,elev_cmd`），
与界面上"导出 CSV"的列序**不同**，讲的时候别混。
