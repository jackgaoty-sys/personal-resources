# fcs-demo（随 Skill 打包的副本）

这份目录是**飞控系统演示本体**（`fcs-demo`）的完整拷贝，随本 Skill 一起分发，
目的是让 Skill **自包含** —— 以后换机器、或本地已经不再保留 fcs-demo 时，
本 Skill 依然能原样跑起来。

---

## 1. 它是什么

一个跑在浏览器里的飞行控制系统演示：

- **飞控**（`src/fcs/fcs.js`）：俯仰/滚转/偏航三通道增稳、NORMAL/ALTERNATE/DIRECT 三套法则、
  迎角/载荷/坡度包线保护、五类故障注入、损伤接入飞行。
- **动力学**（`src/fdm/`）：JSBSim 编译成 WASM 的真 6-DoF 闭环；另有"无气动"假 FDM 适配器。
- **显示**（`src/displays/`、`src/scene/`）：PFD / ECAM / 时间历程 / 3D 视景 / 分级事件日志。
- **数据**（`public/data/`）：`jsbsim_wasm.wasm`（1.5 MB 内核）+ c172p 气动/发动机/螺旋桨数据表。

> `vendor/jsbsim/` 上游 JSBSim 源码**未随包分发**（它自带 `.git`，是个嵌套仓库，不适合直接入库）。
> 这里只保留了 Node 侧适配器（`src/fdm/jsbsimAdapter.js`）实际读取的 4 个数据文件：
> `vendor/jsbsim/aircraft/c172p/{c172p,reset00}.xml`、`vendor/jsbsim/engine/{eng_io320,prop_75in2f}.xml`。
> 浏览器侧（真正演示用的那条路径）不读 `vendor/`，它走 `public/data/`。

---

## 2. 气动开关：**已预装**

第 3 幕需要的"无气动阶段版"是**同一应用内的开关**，这份副本**已经装好**：

| URL | 形态 |
|---|---|
| `/?aero=1` | 真 6-DoF（JSBSim WASM 气动闭环）——**交付态** |
| `/?aero=0` | 无气动阶段版（假 FDM）——**演示道具** |

顶栏有 `气动: 开 / 关` 按钮，点击即切换并重新加载。

```sh
# 验证（应报告"已安装完整"）
node <SKILL_DIR>/scripts/apply_aero_toggle.mjs --dir "<SKILL_DIR>/fcs-demo" --check

# 还原成未打补丁的原件（备份在 backups/aero-toggle/original/，永不被覆盖）
node <SKILL_DIR>/scripts/apply_aero_toggle.mjs --dir "<SKILL_DIR>/fcs-demo" --revert
```

`backups/aero-toggle/original/` 里是真原件（`index.html`、`src__main.js`），随包提供，
所以 `--revert` 一定能回到未打补丁的状态。

---

## 3. 怎么跑

```sh
cd <SKILL_DIR>/fcs-demo
npm install                                        # 首次；预热需要 Playwright Chromium，不要跳过浏览器安装
npm run dev                                        # → http://localhost:5173/
```

冷启动要十几秒（WASM 1.5 MB + 双内核配平）。正式演示前用 Skill 的 `scripts/prewarm.mjs` 在隔离的无界面浏览器中完成初始化；不得提前在现场内部浏览器加载页面。

---

## 4. 本副本**不含**什么（以及怎么补）

| 排除项 | 大小 | 为什么 | 怎么补 |
|---|---|---|---|
| `node_modules/` | ~98 MB | 构建产物，不进仓库 | `npm install` |
| `dist/` | ~4 MB | 构建产物 | `npm run build` |
| `backups/*.tar.gz` | ~8.4 MB | 应用开发期的历史快照，与演示无关 | 不需要 |
| `experiments/out/*.png` | ~3.8 MB | 实验过程截图，与演示无关 | 不需要 |
| `vendor/jsbsim/` 除 4 个数据文件外 | ~2.2 MB | 上游 JSBSim 源码树（自带 `.git`）；运行时/演示/本 Skill 脚本均不需要 | 需要重跑 Node 实验时，从上游 JSBSim 仓库或原 fcs-demo 拷回 |

其余全部保留，包括 `experiments/out/*.csv`（第 3 幕 3.5 收口可直接引用的现成对照证据）。

---

## 5. 来源

- 取自：`fcs-demo` 开发工作区（`.../workspace/fcs-demo`）
- 打包时间：2026-09-20
- 打包时状态：气动开关**已安装完整**（6/6 锚点齐备）
- 打包方式：`rsync -a`，按上表排除；`vendor/jsbsim` 另做裁剪（只留 4 个数据文件）
- 已验证：`npm install` → `npm run dev` → `?aero=1` / `?aero=0` 均能正常启动（实测）

> 本目录是**副本**。若上游 fcs-demo 有更新，需要重新同步；
> 本 Skill 只编排演示流程，不改飞控内核（红线见 `SKILL.md` §6）。
