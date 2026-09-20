# 气动开关 · 技术规格

> 目标：在**同一个应用**里做出"有前端、无气动、乱飞"的阶段版，并能一键切回真气动。
> 依据：fcs-demo 的 README 已自证注入点成立 ——
> *"换动力学实现：`adapter.browser.js` 的 `createFdm` 改成走 WebSocket 连后端 JSBSim 即可，
> `main.js` 和 `fcs/` 零改动。"*

---

## 1. 设计

开关的唯一真值是 URL 查询参数：

| URL | 行为 | 用途 |
|---|---|---|
| `?aero=1`（默认，无参数也是它） | `createFdm` = 真 JSBSim WASM 6-DoF | 第 4 幕成品态、第 3 幕 3.4 之后 |
| `?aero=0` | `createFdm` = `createNoAeroFdm`（占位动力学） | 第 3 幕 3.1–3.3 阶段版 |

选 URL 参数而不是运行中热切换，理由是**干净**：

- 切换即重新加载 → 内核、FDM、配平、幽灵机全部从零重建，不留上一版的状态残渣。
  热切换则要处理"无气动配平过的姿态交给气动模型"这种脏交接，得不偿失。
- 对自动化友好：Playwright 只要 `page.goto(url + '?aero=0')`，不需要点 DOM。
- 页面刷新在观感上完全符合剧情："我们改完代码，重新跑一遍"。

顶栏按钮只是把改 URL 的手动动作变成一个点击（等价于改参数后刷新）。

---

## 2. 为什么假 FDM 能让"乱飞"看起来是真缺东西，而不是坏掉

`assets/aero-toggle/src/fdm/noaero.browser.js` 刻意去掉了四样东西，
每一件都对应剧情里可以点出来的一个症状（下表现象均为**实测值**，非估计）：

| 去掉的东西 | 现象（实测） | 讲法 |
|---|---|---|
| 气动阻尼 + 静稳定性 + 配平平衡点 | 松手时坡度自己摆到 **±18°（峰峰 36°）**；配平轮拨了没效果 | "它没有'平飞'这个状态" |
| 升力 | 高度一路掉（**-1681 fpm**）；满杆拉 40s 后 θ 翻到 **180°**，高度**照样掉** | "重力没有任何东西抵消" |
| 迎角/侧滑角的几何解算（改为合成量） | 迎角在 **-4.5° ~ 10.3°** 之间缓摆，与姿态/操纵对不上 | "迎角不是算出来的，是编出来的；飞控在追一个不存在的信号" |
| 过载的来源（改为与操纵无关的占位值） | 过载恒 **1.04 g**，拉满杆也不涨 | "保护没有作用对象" |

### 2.1 关于"保护”：实测比"不介入”更好讲

早期设计假设是"保护永远不会介入"，**实测不是这样**：

| 操作 | 保护标签 | 飞机 |
|---|---|---|
| 松手 | 无 | 坡度自己摆到 ±18°，高度 -1681 fpm |
| 满杆拉到底 | `LOAD` + `PITCH` **会亮** | θ 翻到 180°，高度照样掉 |
| 压杆右滚 | `BANK` **会亮** | φ 到 98°，高度照样掉 |

也就是说：保护逻辑照常计算、照常播报，**但飞机完全不理会** —— 因为过载和迎角
根本不由操纵产生，保护没有可作用的物理对象。

这比"一行都不亮”更适合教学，而且正好是 C 组选择题迷惑项 D 的解说：
**先有对象，才谈得上保护**。演示时不要把这条讲成"保护失灵”，
要讲成"保护算对了，只是没有东西可供它作用"。

同时**保留**了完整的显示链路（PFD / ECAM / 3D / 事件日志 / 时间历程 / CSV 导出），
所以"有完整的前端展示"这句剧情是字面成立的 ——
前端的每一块都在正常工作，是它背后的动力学在说谎。

### 状态数组的顺序必须一致

`main.js` 用 `unpack(app.fdm.readState())` 解包，而 `unpack` 的下标来自
`adapter.browser.js` 的 `I`（由 `STATE_PATHS` 派生）。
所以 `noaero.browser.js` 直接 `import { STATE_PATHS, I }`，
用 `I["..."]` 写数组 —— 下标永远不会漂移。

> 副作用：无气动模式下依然会 import `@0x62/jsbsim-wasm` 这个 JS 包（但**不会**拉 1.5 MB 的
> `.wasm` 二进制，因为只在真模式下才用 `wasmBinaryUrl`）。这是拿"少加载 1.5 MB"换"下标绝对一致"，
> 值得。

### 参数在哪调

`noaero.browser.js` 顶部集中了一组常量：`Q_GAIN/P_GAIN/R_GAIN`（操纵力度）、
`Q_DAMP/P_DAMP/R_DAMP`（阻尼，**调大就会自己稳住，症状消失**）、`NOISE_*`（乱飘幅度）、
`DRAG_SINK`（下沉终端速度 → 决定"多久砸地"）。
调完只需刷新页面，不需要重新打补丁。

> ⚠ **踩过的坑（改参数前必读）**：
> ① **滚转噪声必须低频**。用高频（1.1 Hz）时会被飞控的滚转速率环
>    （`KpRoll`）直接滤掉 —— 实测松手 60s 坡度峰峰只剩 **0.4°**，
>    画面看着像一架正常的飞机，"乱飞"彻底消失。改用 0.045/0.11 Hz 后才得到 36°。
> ② **俯仰噪声相反，必须保持高频**。调低频后 θ 会摆到 96° 并误触 `PITCH` 保护。
> ③ **占位过载要写负值**。上层用的是 `n_load = -n-pilot-z-norm`，
>    写正值会让飞控解出 -1g、立刻误触 `LOAD` 硬限保护。
> ④ `DRAG_SINK` 决定演示窗口：当前值下从 4500 ft 到触地约 **130 s**。
>    调大它会很快砸地（"这一幕讲不完"），调小则下沉不明显（"看不出问题"）。
>
> 改完参数后**必须**跑四场景复测：`node scripts/verify_noaero.mjs --dir <fcs-demo>`（见 §5）。

---

## 3. 补丁锚点（apply_aero_toggle.mjs 依赖这些字符串）

脚本按**精确字符串匹配**改文件；任一锚点找不到就报错退出（绝不静默改坏）。
如果 fcs-demo 的源码结构变了，**先改这里的锚点，再改脚本**。

### 3.1 新增文件

```
<FCS_DEMO>/src/fdm/noaero.browser.js        ← 从 assets/aero-toggle/src/fdm/noaero.browser.js 复制
```

### 3.2 `src/main.js` — 改动 4 处

**(a) 导入行**

原：
```js
import { createFdm, unpack } from "./fdm/adapter.browser.js";
```

改为：
```js
import { createFdm as createAeroFdm, unpack } from "./fdm/adapter.browser.js";
import { createNoAeroFdm } from "./fdm/noaero.browser.js";
```

**(a2) 开关定义**（插在 import 块**之后**，锚点是 `const RATE = ...` 那一行之前）

```js
// 气动开关（演示用，见 skill: fcs-demo-4act-flow）
//   ?aero=1（默认）→ 真 6-DoF：JSBSim WASM 气动力矩闭环
//   ?aero=0        → 无气动阶段版：占位动力学，姿态乱飘、高度一路掉
const AERO_ON = new URLSearchParams(location.search).get("aero") !== "0";
const createFdm = AERO_ON ? createAeroFdm : createNoAeroFdm;
window.__AERO__ = AERO_ON;
```

> 为什么不直接把这几行接在 import 后面一起插：那样会把 `const` 语句夹在
> `import` 列表中间（还有 6 个 import 在后面）。ESM 会提升导入、语法也合法，
> 但读起来像是在报错。分两处改，导入归导入、定义归定义。

> `main.js` 后面有两处 `await createFdm(...)`（真机 + 幽灵机），
> 改为按开关分派后它们都自动走同一条路，无需再改。

**(b) 启动日志如实描述**

原：
```js
    app.log.push(app.simT, "info", "系统就绪：JSBSim 内核装载完成，3D 视景已建立", 0);
```
改为：
```js
    app.log.push(app.simT, "info", AERO_ON
      ? "系统就绪：JSBSim 内核装载完成，3D 视景已建立"
      : "系统就绪：简化动力学（无气动数据），3D 视景已建立", 0);
```

**为什么必须改**：不改的话，`?aero=0` 时事件日志会写着"JSBSim 内核装载完成"——
系统在说谎。第 3 幕的教学价值恰恰在于"系统自己承认缺了什么"。
所以这条日志是**教学道具**，不要为了"看起来更完整"改回去。

**(c) 顶栏按钮绑定**（插在 `bindButtons()` 末尾、`window.app = app;` 之前）

原：
```js
  window.app = app;                                     // 便于控制台/自动化检查
```
改为：
```js
  // 气动开关（演示用）：点击后带 ?aero=0|1 重新加载
  const ab = $("aeroBtn");
  if (ab) {
    ab.textContent = "气动: " + (AERO_ON ? "开" : "关");
    ab.classList.toggle("on", !AERO_ON);
    ab.onclick = () => {
      const p = new URLSearchParams(location.search);
      p.set("aero", AERO_ON ? "0" : "1");
      location.search = p.toString();
    };
  }

  window.app = app;                                     // 便于控制台/自动化检查
```

### 3.3 `index.html` — 改动 1 处

原：
```html
      <button id="csvBtn" title="把已录制的时间历程导出为 CSV">导出 CSV</button>
```
改为：
```html
      <button id="aeroBtn" title="气动开关（演示用）：?aero=1 = 真 6-DoF 闭环；?aero=0 = 无气动阶段版。点击切换并重新加载">气动: --</button>
      <button id="csvBtn" title="把已录制的时间历程导出为 CSV">导出 CSV</button>
```

> 放在顶栏（而不是底部控制条）：它是一个"构建开关"，不是飞行操纵，
> 混在故障注入/法则按钮里会让观众误以为它是飞行功能。

---

## 4. 验证清单（打完补丁后逐条过）

```sh
node scripts/apply_aero_toggle.mjs --dir "$FCS_DEMO" --check     # 新增文件 + 4 处改动都在
cd "$FCS_DEMO" && npm run dev
```

浏览器里：

| # | 检查 | 期望 |
|---|---|---|
| 1 | `?aero=1` 打开 | 正常：能配平到平飞，顶栏"气动: 开" |
| 2 | `?aero=0` 打开 | 顶栏"气动: 关"；启动日志出现"简化动力学（无气动数据）" |
| 3 | `?aero=0` 松手 10s 不动 | 坡度自己摆到 ±18°；高度持续下降（约 -1680 fpm） |
| 4 | `?aero=0` 拉满杆 | 高度仍然掉，**且姿态会翻过去（θ→180°）**；`LOAD`/`PITCH` 标签**会亮**，但飞机不理会 |
| 5 | `?aero=0` 拨配平 | 无可见效果 |
| 6 | `?aero=0` 点顶栏"气动" | 刷新并变回 `?aero=1` |
| 7 | `?aero=0` 下 PFD/ECAM/3D/日志/时间历程 | **全部正常渲染**（关键：前端是好的） |
| 8 | `?aero=0` 导出 CSV | 能导出，且能看到 `升降率` 一路为负 |

第 7 条是本幕的题眼：**前端全对、动力学全错**。演示时要先把第 7 条演足，
再引到第 3 条 —— 否则观众会以为"整个东西都是坏的"，教学效果就变成"看笑话"了。

---

## 5. 复测（改了参数就跑）

```sh
node scripts/verify_noaero.mjs --dir "$FCS_DEMO"
node scripts/verify_noaero.mjs --dir "$FCS_DEMO" --verbose   # 附带轨迹采样
```

它把 **fcs-demo 的真实 FCS** 与假 FDM 接成闭环，跑四个场景并与文档承诺的区间对比：

| 场景 | 断言 |
|---|---|
| A 松手 60s | 坡度峰峰 20–60°（太小=飞控按住了→症状消失；太大=要翻）、下沉 -1300～-2100 fpm、保护标签为空、不触地 |
| B 满杆拉到底 40s | 最大\|θ\| ≥ 120°（确实翻过去了）、保护标签 ≥ 1 个、仍在下沉 |
| C 压杆右滚 40s | 最大\|φ\| ≥ 60°、出现 `BANK` 标签 |
| D 松手 120s | 不触地（演示窗口 ≥ 2 分钟） |

当前实测基线：

```
场景                  坡度峰峰  最大|θ|  过载    保护标签      下沉(fpm)
A 松手 60s              36°      10°   1.04g  —            -1681
B 满杆拉到底 40s        35°     180°   1.04g  LOAD,PITCH   -1659
C 压杆右滚 40s          95°       9°   1.04g  BANK         -1684
D 松手 120s             36°      10°   1.04g  —            -1677
```

失败时的常见原因（脚本会直接提示）：有人改了 `NOISE_*`/`DAMP`/`GAIN`，
或把滚转噪声改回了高频。
