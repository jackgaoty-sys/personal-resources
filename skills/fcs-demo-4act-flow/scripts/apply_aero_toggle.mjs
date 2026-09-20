#!/usr/bin/env node
// 气动开关安装器（幂等）
// ══════════════════════════════════════════════════════════════════
// 给 fcs-demo 装上「同一应用内的气动开关」：
//   ?aero=1（默认）→ 真 6-DoF（JSBSim WASM 气动力矩闭环）
//   ?aero=0        → 无气动阶段版（假 FDM：姿态乱飘、高度一路掉）
//
// 依据 fcs-demo 的 README：「换动力学实现只需改 adapter.browser.js 的 createFdm，
// main.js 和 fcs/ 零改动」—— 本脚本就是按这个结论做的，只动 main.js 的
// 导入行与一处按钮绑定，不碰 fcs/ 一行。
//
// 用法：
//   node apply_aero_toggle.mjs --dir <fcs-demo>            # 打补丁（可重复执行）
//   node apply_aero_toggle.mjs --dir <fcs-demo> --check     # 只检查（未打全则退出码 1）
//   node apply_aero_toggle.mjs --dir <fcs-demo> --revert    # 回滚到最近一次备份
//   node apply_aero_toggle.mjs --dir <fcs-demo> --force     # 连假 FDM 源文件也覆盖
//
// 安全设计：所有改动都基于**带捕获组的正则锚点**，锚点匹配数不等于 1 就报错退出，
// 绝不静默改坏文件；改动前把原文件备份到 <fcs-demo>/backups/aero-toggle/<时间戳>/。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = path.resolve(HERE, "../assets/aero-toggle/src/fdm/noaero.browser.js");

// ── 参数 ──
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODE = has("--check") ? "check" : has("--revert") ? "revert" : "apply";
const FORCE = has("--force");
const DIR = val("--dir");
if (!DIR) { console.error("用法: node apply_aero_toggle.mjs --dir <fcs-demo 目录> [--check|--revert|--force]"); process.exit(2); }
const ROOT = path.resolve(DIR);

const MAIN_JS = path.join(ROOT, "src/main.js");
const INDEX_HTML = path.join(ROOT, "index.html");
const ADAPTER_DST = path.join(ROOT, "src/fdm/noaero.browser.js");
const BACKUP_ROOT = path.join(ROOT, "backups/aero-toggle");

const log = (s) => console.log(s);
const ok = (s) => console.log("  ✓ " + s);
const bad = (s) => console.log("  ✗ " + s);
const warn = (s) => console.log("  ! " + s);

// ── 前置检查 ──
function preflight() {
  const missing = [MAIN_JS, INDEX_HTML].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error("找不到目标文件（--dir 指错了吗？）：\n  " + missing.join("\n  "));
    process.exit(2);
  }
  if (!fs.existsSync(ADAPTER_SRC)) {
    console.error("找不到假 FDM 源文件：" + ADAPTER_SRC);
    process.exit(2);
  }
}

// ── 补丁定义 ──
// detect: 判定"是否已打"的哨兵（用出现次数，避免误判）
// find/replace: 带捕获组的正则，用来保留原缩进
const MAIN_PATCHES = [
  {
    name: "main.js · 导入行",
    file: MAIN_JS,
    detect: (s) => s.includes('import { createFdm as createAeroFdm, unpack } from "./fdm/adapter.browser.js";')
      && s.includes('import { createNoAeroFdm } from "./fdm/noaero.browser.js";'),
    find: /^import \{ createFdm, unpack \} from "\.\/fdm\/adapter\.browser\.js";[ \t]*$/m,
    replace: () => [
      `import { createFdm as createAeroFdm, unpack } from "./fdm/adapter.browser.js";`,
      `import { createNoAeroFdm } from "./fdm/noaero.browser.js";`,
    ].join("\n"),
  },
  {
    name: "main.js · 气动开关定义",
    file: MAIN_JS,
    // 放在 import 块【之后】：插在 import 中间虽然合法（ESM 会提升），但读起来像错误
    detect: (s) => s.includes("window.__AERO__"),
    find: /^const RATE = 120, DT = 1 \/ RATE, FT2M = 0\.3048;[ \t]*$/m,
    replace: (m) => [
      `// 气动开关（演示用，见 skill: fcs-demo-4act-flow）`,
      `//   ?aero=1（默认）→ 真 6-DoF：JSBSim WASM 气动力矩闭环`,
      `//   ?aero=0        → 无气动阶段版：占位动力学，姿态乱飘、高度一路掉`,
      `const AERO_ON = new URLSearchParams(location.search).get("aero") !== "0";`,
      `const createFdm = AERO_ON ? createAeroFdm : createNoAeroFdm;`,
      `window.__AERO__ = AERO_ON;`,
      ``,
      `const RATE = 120, DT = 1 / RATE, FT2M = 0.3048;`,
    ].join("\n"),
  },
  {
    name: "main.js · 启动日志如实描述",
    file: MAIN_JS,
    detect: (s) => s.includes("简化动力学（无气动数据）"),
    find: /^([ \t]*)app\.log\.push\(app\.simT, "info", "系统就绪：JSBSim 内核装载完成，3D 视景已建立", 0\);[ \t]*$/m,
    replace: (m) => [
      `${m[1]}app.log.push(app.simT, "info", AERO_ON`,
      `${m[1]}  ? "系统就绪：JSBSim 内核装载完成，3D 视景已建立"`,
      `${m[1]}  : "系统就绪：简化动力学（无气动数据），3D 视景已建立", 0);`,
    ].join("\n"),
  },
  {
    name: "main.js · 顶栏按钮绑定",
    file: MAIN_JS,
    detect: (s) => s.includes('"aeroBtn"') && s.includes("气动: "),
    find: /^([ \t]*)window\.app = app;([^\n]*)$/m,
    replace: (m) => [
      `${m[1]}// 气动开关（演示用）：点击后带 ?aero=0|1 重新加载`,
      `${m[1]}const ab = $("aeroBtn");`,
      `${m[1]}if (ab) {`,
      `${m[1]}  ab.textContent = "气动: " + (AERO_ON ? "开" : "关");`,
      `${m[1]}  ab.classList.toggle("on", !AERO_ON);`,
      `${m[1]}  ab.onclick = () => {`,
      `${m[1]}    const p = new URLSearchParams(location.search);`,
      `${m[1]}    p.set("aero", AERO_ON ? "0" : "1");`,
      `${m[1]}    location.search = p.toString();`,
      `${m[1]}  };`,
      `${m[1]}}`,
      ``,
      `${m[1]}window.app = app;${m[2]}`,
    ].join("\n"),
  },
];

const HTML_PATCHES = [
  {
    name: "index.html · 顶栏气动按钮",
    file: INDEX_HTML,
    detect: (s) => s.includes('id="aeroBtn"'),
    find: /^([ \t]*)<button id="csvBtn"[^\n]*<\/button>[ \t]*$/m,
    replace: (m) => [
      `${m[1]}<button id="aeroBtn" title="气动开关（演示用）：?aero=1 = 真 6-DoF 闭环；?aero=0 = 无气动阶段版。点击切换并重新加载">气动: --</button>`,
      `${m[1]}<button id="csvBtn" title="把已录制的时间历程导出为 CSV">导出 CSV</button>`,
    ].join("\n"),
  },
];

const ALL_PATCHES = [...MAIN_PATCHES, ...HTML_PATCHES];

// ── 检查 ──
function checkStatus() {
  const rows = [];
  for (const p of ALL_PATCHES) {
    const src = fs.readFileSync(p.file, "utf8");
    rows.push({ name: p.name, applied: !!p.detect(src) });
  }
  rows.push({
    name: "src/fdm/noaero.browser.js 存在",
    applied: fs.existsSync(ADAPTER_DST),
  });
  return rows;
}

function cmdCheck() {
  log(`检查气动开关安装状态：${ROOT}`);
  const rows = checkStatus();
  let allOk = true;
  for (const r of rows) { (r.applied ? ok : bad)(r.name); if (!r.applied) allOk = false; }
  if (allOk) log("\n已安装完整 —— 可用 ?aero=0 演示阶段版。");
  else log("\n未安装完整。执行不带 --check 的命令即可打补丁。");
  return allOk ? 0 : 1;
}

// ── 备份工具 ──
// 备份文件名用 "__" 代替路径分隔符（src__main.js、index.html），回滚时还原。
function flatName(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join("__");
}

/** 把 [MAIN_JS, INDEX_HTML] 备份到 <BACKUP_ROOT>/<name>/ */
function backupTo(name) {
  const dir = path.join(BACKUP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [MAIN_JS, INDEX_HTML]) fs.copyFileSync(f, path.join(dir, flatName(f)));
  return dir;
}

// ── 回滚 ──
function cmdRevert() {
  if (!fs.existsSync(BACKUP_ROOT)) { console.error("没有备份目录，无法回滚：" + BACKUP_ROOT); return 2; }
  const dirs = fs.readdirSync(BACKUP_ROOT).filter((d) => fs.statSync(path.join(BACKUP_ROOT, d)).isDirectory()).sort();
  if (!dirs.length) { console.error("备份目录为空，无法回滚。"); return 2; }

  // 优先用 original（真正的原件）。只有它不在时才退而用最新一个，并明确告知风险 ——
  // 若退到 partial-<时间戳>，那里面存的是"打了一半"的状态，不是原件。
  let name = "original";
  if (!dirs.includes("original")) {
    name = dirs[dirs.length - 1];
    warn(`没有 original 备份，改用「${name}」—— 它【可能不是原件】，请确认后再继续。`);
  }
  const dir = path.join(BACKUP_ROOT, name);
  log(`从备份回滚：${dir}`);
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const dst = path.join(ROOT, f.split("__").join(path.sep));
    if (!fs.existsSync(path.dirname(dst))) { warn(`跳过（目标目录不存在）：${f}`); continue; }
    fs.copyFileSync(path.join(dir, f), dst);
    ok(`${f} → ${path.relative(ROOT, dst)}`);
    n++;
  }
  // 假 FDM 是纯新增文件，回滚时直接删掉
  if (fs.existsSync(ADAPTER_DST)) { fs.unlinkSync(ADAPTER_DST); ok("已删除 src/fdm/noaero.browser.js"); n++; }
  log(`\n回滚完成（${n} 项）。`);
  return 0;
}

// ── 打补丁 ──
function cmdApply() {
  log(`安装气动开关：${ROOT}`);

  const status = checkStatus();
  const done = status.filter((r) => r.applied).length;
  const total = status.length;

  // 全部已装：什么都不改，也不建备份。
  // 这一条是【回滚正确性的前提】：若重复执行也备份，备份里存的会是"已打过补丁"的
  // 文件，revert 就会把补丁还原成它自己（实测过，表现为 diff 不为空）。
  if (done === total && !FORCE) {
    ok(`已完整安装（${done}/${total}），无需改动。`);
    log("要强制覆盖假 FDM 源文件请加 --force。");
    return 0;
  }

  // 1) 备份
  if (done === 0) {
    const dir = path.join(BACKUP_ROOT, "original");
    if (fs.existsSync(dir)) ok("原件备份已存在（保留最早的一份，不覆盖）→ backups/aero-toggle/original/");
    else { backupTo("original"); ok("已备份原件 → backups/aero-toggle/original/"); }
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = backupTo(`partial-${stamp}`);
    warn(`当前是「打了一半」的状态（${done}/${total}），已备份到 ${path.relative(ROOT, dir)}（不是原件！）`);
  }

  // 2) 假 FDM 源文件
  const needCopy = FORCE || !fs.existsSync(ADAPTER_DST);
  if (needCopy) {
    fs.mkdirSync(path.dirname(ADAPTER_DST), { recursive: true });
    fs.copyFileSync(ADAPTER_SRC, ADAPTER_DST);
    ok("已写入 src/fdm/noaero.browser.js");
  } else {
    const same = fs.readFileSync(ADAPTER_SRC, "utf8") === fs.readFileSync(ADAPTER_DST, "utf8");
    if (same) ok("src/fdm/noaero.browser.js 已是最新（未改动）");
    else warn("src/fdm/noaero.browser.js 已存在且与 skill 版本不同 —— 保留现状；要覆盖请加 --force");
  }

  // 3) 逐条打补丁
  let changed = 0;
  for (const p of ALL_PATCHES) {
    const src = fs.readFileSync(p.file, "utf8");
    if (p.detect(src)) { ok(`${p.name}（已打，跳过）`); continue; }
    const matches = src.match(new RegExp(p.find.source, p.find.flags.includes("g") ? p.find.flags : p.find.flags + "g"));
    const count = matches ? matches.length : 0;
    if (count !== 1) {
      console.error(`\n锚点匹配数异常（期望 1，实际 ${count}）：${p.name}`);
      console.error(`文件：${p.file}`);
      console.error(`锚点：${p.find}`);
      console.error("源码结构可能已变 —— 先更新 references/aero-toggle-spec.md 的锚点，再改本脚本。已打的补丁保留，请手工核对。");
      return 3;
    }
    const out = src.replace(p.find, (...a) => p.replace(a));
    fs.writeFileSync(p.file, out);
    ok(p.name);
    changed++;
  }

  log(`\n完成：新增/修改 ${changed} 处。`);
  const rows = checkStatus();
  const allOk = rows.every((r) => r.applied);
  if (!allOk) { bad("自检未通过，请检查上面的 ✗ 项。"); return 1; }

  log("");
  log("下一步：");
  log(`  cd ${ROOT} && npm run dev`);
  log("  真 6-DoF：    http://localhost:5173/?aero=1");
  log("  无气动阶段版：http://localhost:5173/?aero=0");
  return 0;
}

preflight();
const code = MODE === "check" ? cmdCheck() : MODE === "revert" ? cmdRevert() : cmdApply();
process.exit(code);
