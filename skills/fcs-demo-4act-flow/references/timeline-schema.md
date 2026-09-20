# 时间轴 Schema 与检查表语义

时间轴是"把现场该按什么固化下来"的**检查表**。它**不是**飞行数据回放，也**不再驱动浏览器** ——
四幕的每一个动作都在 **Codar 内置浏览器**里手工触发（见 `browser-stage-contract.md`），
时间轴负责告诉你：这一幕该按什么、该看什么、该断言什么。

> ⚠ 时间轴**没有执行器**。`demo_driver.mjs` 只剩 `--dry`（校验结构，不启浏览器），
> 非 `--dry` 调用会报错退出。文档里凡提到“驱动 / 接管热键”的地方，都是历史行为。

---

## 1. 顶层结构

```json
{
  "version": 1,
  "meta": {
    "name": "飞控系统四幕演示",
    "baseUrl": "http://localhost:5173",
    "outDir": "./demo-artifacts"
  },
  "defaults": {
    "stepTimeoutMs": 20000,
    "settleMs": 800,
    "shotQuality": 80
  },
  "acts": [
    {
      "id": "act1",
      "title": "第 1 幕 · 进入平台",
      "pauseBefore": true,
      "narration": "讲解提示（会打进 run.log，并可作为提词）",
      "steps": [ ... ]
    }
  ]
}
```

- `acts[]`：幕。**幕边界默认暂停等回车**（`pauseBefore`，第一幕可设 `false`）。
- `narration`：只用于日志/提词，不驱动浏览器。
- `defaults.settleMs`：每个动作之后固定等待的毫秒数，给画面留出"被看见"的时间。

---

## 2. step 通用字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `action` | string | 见下表的动作名（必填） |
| `note` | string | 提词/日志文本 |
| `pause` | bool | 本步执行**前**暂停等接管（覆盖幕级默认） |
| `settleMs` | number | 本步后的额外等待 |
| `expect` | array | 断言，见 §4 |
| `optional` | bool | 失败只警告不报错（现场容错用） |

`pause` 与幕级 `pauseBefore` 是"或"关系。

---

## 3. 动作表

| action | 参数 | 行为 |
|---|---|---|
| `load` | `{ aero: 0\|1, query?: string }` | 导航到 `baseUrl + "/?aero=" + aero`（可附加 query），并等待应用就绪 |
| `waitSim` | `{ seconds }` | 等待**仿真时间**推进 N 秒（比 `wait` 稳，倍速下等价真实时间不同） |
| `wait` | `{ ms }` | 等待真实毫秒 |
| `keys` | `{ hold: ["KeyD"], ms: 1200 }` | 按下这些键、保持 `ms` 后松开（长按用，如滚转） |
| `press` | `{ code: "Space" }` | 单次按键（离散动作：`Space`/`R`/`C`/`V`） |
| `inject` | `{ faults: ["ahrs"] }` | 逐个 `app.fcs.injectFault(name)` + 同步按钮高亮 |
| `clearFaults` | `{}` | `app.fcs.clearAllFaults()` 并清掉按钮高亮 |
| `setLaw` | `{ law: "NORMAL"\|"ALTERNATE"\|"DIRECT" }` | `app.fcs.setLaw(law)` |
| `preset` | `{ id: "ahrs" }` | 选中 `#preset` 并触发 `change`（等价于点场景预设） |
| `speed` | `{ x: 2 }` | 点倍速按钮 |
| `camera` | `{ mode: "cockpit" }` | 循环 `C` 直到 `scene.getMode()` 命中 |
| `pause` / `resume` | `{}` | 置 `app.paused` |
| `ghost` | `{ visible: true }` | `V` 或直接调 `scene.setGhostVisible` |
| `shot` | `{ name, fullPage?: false }` | 截图 → `<outDir>/<name>.png`（可选；现场展示以内部浏览器为准） |
| `csv` | `{ name }` | 触发界面导出 CSV，用下载事件接住并另存为 `<outDir>/<name>.csv` |
| `note` | `{ text }` | 只写 `run.log`（不碰浏览器） |
| `expect` | `{ expect: [...] }` | **纯断言步**：不动浏览器，只跑 `expect[]`。用于把"这一幕成立"钉在时间轴上 |
| `eval` | `{ expr, save?: "varName" }` | 在页面上下文求值；`save` 可存进变量供后续断言用 |

> `keys` 的键名用 **`KeyboardEvent.code`**：`KeyW/KeyS/KeyA/KeyD/KeyQ/KeyE/KeyT/KeyG/Space/KeyR/KeyC/KeyV`。
>
> `expect` **不是**独立动作之外的新机制 —— 任何 step 都可以带 `expect` 字段。
> `action: "expect"` 只是"这个 step 不做事、只断言"的写法，便于把判据单独列出来读。
> `Space`/`R`/`C`/`V` 属于离散动作且 `main.js` 有 `if (e.repeat) return` 保护 ——
> **用 `press` 而不是 `keys`**，否则长按语义会变成"按了一次"。

---

## 4. 断言（`expect`）

```json
"expect": [
  { "expr": "app.fcs.law === 'DIRECT'", "desc": "AHRS 失效应降到 DIRECT" },
  { "expr": "app.st.h * 0.3048 > 500", "desc": "高度仍在安全范围" }
]
```

- `expr` 在**页面上下文**求值，可访问 `app`、`window.__AERO__`。
- 断言失败：**记 error 并高亮，但不中断**（现场演示不能因为一条断言挂掉整场）。
  加 `"optional": true` 连 error 都不记。
- 建议每个幕至少一条"这一幕成立"的断言，例如：
  - 第 3 幕 3.1：`window.__AERO__ === false`
  - 第 3 幕 3.4：`window.__AERO__ === true`
  - 第 3 幕收口：`app.st.h` 在 `aero=0` 时下降、`aero=1` 时能稳住

---

## 5. 交互（在内置浏览器里）

演示时**没有脚本在跑**，所以不存在“接管”这回事 —— 每一步都是你亲手在内置浏览器里做的。

| 动作 | 工具 |
|---|---|
| 切页面（`?aero=0` / `?aero=1`） | `in_app_browser_navigate` |
| 按键（`W/S`、`R`、`V`、`Space`…） | `in_app_browser_interact`（`press`）或 `in_app_browser_evaluate` 派发 `keydown`/`keyup` |
| 点按钮（顶栏“气动”、`导出 CSV`、场景预设） | `in_app_browser_interact`（`click` / `select`） |
| 读状态、求值断言 | `in_app_browser_evaluate` |
| 截图（可选，非必需） | `in_app_browser_screenshot` |

观众随时能上手，因为操作的就是**观众正看着的那个浏览器窗口**。

> ⚠ **不要用独立窗口的 Playwright 演**（`demo_driver.mjs`）。那是另一个窗口，观众没在看它 ——
> 即使画面内容一模一样，也不算演示。展示窗口要求见 `browser-stage-contract.md`。

---

## 6. 就绪判定

`load` 之后必须等到：

```js
window.app && window.app.st && window.app.simT > 0
```

不要只等 `DOMContentLoaded`：WASM 要加载（1.5 MB）、配平要跑 6 秒物理步。
无气动模式下同样要走完 `trimThenOpen(6)`，所以这条判据通用。

额外：`?aero=1` 时首屏还会创建**第二套内核**（幽灵机），总加载时间约为单内核的 1.8 倍。
冷启动给到 `stepTimeoutMs: 20000` 比较安全。

---

## 7. 时间轴里的"幕"与剧本节的对应

`assets/timeline.default.json` 的幕 id 与《剧本》小节：

| 幕 id | 剧本小节 | 关键动作 |
|---|---|---|
| `act1` | 1. 学生进入卓工平台 Ai Lab | 入口画面当场可见（截图非必需；本 Skill 只做记录，不模拟平台本身） |
| `act2` | 2. 需求分析 | 对话收集需求 → 模型生成 `requirements.spec.md` → 内部浏览器展示 |
| `act3` | 3. 阶段性成果与改进 | `load{aero:0}` → 诊断 → CNAI4S 外部资源 → 模拟下载卡片 → `load{aero:1}` → 对照 |
| `act4` | 4. 成果产出 | 试飞：正常法则 → 保护 → 故障降级 → 参照机 → CSV |

**第 3 幕的 `pause` 是刻意的**：题目与学生的回答发生在浏览器之外，
平台必须停下来把舞台交给展示人，否则会自动跳过整段教学。
