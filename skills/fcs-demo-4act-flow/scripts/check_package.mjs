#!/usr/bin/env node
// Skill 包自检
// ══════════════════════════════════════════════════════════════════
// 检查内容：
//   ① 包内文件齐全
//   ② 所有 JSON 可解析
//   ③ 所有脚本语法可过（node --check，不执行）
//   ④ 时间轴的 action 都在驱动支持列表内
//   ⑤ 假 FDM 覆盖了全部 16 个 STATE_PATHS（漏一个就会让 unpack 读出 NaN）
//   ⑥ 若给了 --dir，检查气动开关补丁状态与锚点是否仍然可匹配
//
// 用法：
//   node check_package.mjs
//   node check_package.mjs --dir /path/to/fcs-demo

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const i = argv.indexOf("--dir");
const DIR = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : null;

let fails = 0, warns = 0;
const ok = (s) => console.log("  ✓ " + s);
const bad = (s) => { console.log("  ✗ " + s); fails++; };
const warn = (s) => { console.log("  ! " + s); warns++; };
const section = (s) => console.log("\n" + s);

// ── ① 文件齐全 ──
section("① 包内文件");
const EXPECTED = [
  "SKILL.md",
  "references/fcs-demo-contract.md",
  "references/aero-toggle-spec.md",
  "references/timeline-schema.md",
  "references/runbook.md",
  "references/delivery-mode.md",
  "references/platform-guidance.md",
  "references/presenter-script.md",
  "references/quiz-bank.md",
  "assets/aero-toggle/src/fdm/noaero.browser.js",
  "assets/timeline.default.json",
  "assets/requirements.spec.template.md",
  "scripts/apply_aero_toggle.mjs",
  "scripts/demo_driver.mjs",
  "scripts/verify_noaero.mjs",
  "scripts/check_package.mjs",
];
for (const f of EXPECTED) {
  const p = path.join(PKG, f);
  if (fs.existsSync(p)) ok(f);
  else bad("缺失：" + f);
}

// ── ② JSON 可解析 ──
section("② JSON 解析");
const JSONS = ["assets/timeline.default.json"];
for (const f of JSONS) {
  const p = path.join(PKG, f);
  if (!fs.existsSync(p)) { bad("不存在：" + f); continue; }
  try { JSON.parse(fs.readFileSync(p, "utf8")); ok(f + " 可解析"); }
  catch (e) { bad(f + " 解析失败：" + e.message); }
}

// ── ③ 脚本语法 ──
section("③ 脚本语法（node --check，不执行）");
const SCRIPTS = ["scripts/apply_aero_toggle.mjs", "scripts/demo_driver.mjs", "scripts/verify_noaero.mjs",
                 "scripts/check_package.mjs",
                 "assets/aero-toggle/src/fdm/noaero.browser.js"];
for (const f of SCRIPTS) {
  const p = path.join(PKG, f);
  if (!fs.existsSync(p)) { bad("不存在：" + f); continue; }
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
    ok(f);
  } catch (e) {
    bad(f + " 语法错误：\n" + String(e.stderr || e.message).split("\n").slice(0, 6).join("\n"));
  }
}

// ── ④ 时间轴动作合法性 ──
section("④ 时间轴动作");
const KNOWN = new Set([
  "load", "waitSim", "wait", "keys", "press", "inject", "clearFaults", "setLaw",
  "preset", "speed", "camera", "pause", "resume", "ghost", "shot", "csv", "note", "eval",
  "expect",
]);
const REQUIRED = {
  load: ["aero"], waitSim: ["seconds"], wait: ["ms"], keys: ["hold", "ms"], press: ["code"],
  inject: ["faults"], setLaw: ["law"], preset: ["id"], speed: ["x"], camera: ["mode"],
  ghost: ["visible"], shot: ["name"], csv: ["name"], eval: ["expr"],
};
try {
  const tl = JSON.parse(fs.readFileSync(path.join(PKG, "assets/timeline.default.json"), "utf8"));
  let n = 0, badN = 0;
  for (const act of tl.acts || []) {
    for (const s of act.steps || []) {
      n++;
      if (!KNOWN.has(s.action)) { bad(`未知 action: ${s.action}`); badN++; continue; }
      if (s.action === "expect" && !Array.isArray(s.expect)) { bad(`${act.id}: expect 步缺 expect[]`); badN++; }
      for (const k of REQUIRED[s.action] || []) if (s[k] === undefined) { bad(`${act.id}: ${s.action} 缺 ${k}`); badN++; }
    }
  }
  if (!badN) ok(`${tl.acts.length} 幕 / ${n} 步，全部合法`);
} catch (e) { bad("时间轴不可用：" + e.message); }

// ── ⑤ 假 FDM 的 STATE_PATHS 覆盖 ──
section("⑤ 假 FDM 状态字段覆盖");
const STATE_PATHS = [
  "position/h-sl-ft", "position/h-agl-ft", "velocities/vc-kts", "velocities/vt-fps",
  "attitude/theta-deg", "attitude/phi-deg", "attitude/psi-deg",
  "aero/alpha-deg", "aero/beta-deg",
  "velocities/p-aero-rad_sec", "velocities/q-aero-rad_sec", "velocities/r-aero-rad_sec",
  "accelerations/n-pilot-z-norm", "velocities/mach",
  "position/lat-geod-deg", "position/long-gc-deg",
];
const adPath = path.join(PKG, "assets/aero-toggle/src/fdm/noaero.browser.js");
if (fs.existsSync(adPath)) {
  const src = fs.readFileSync(adPath, "utf8");
  const missing = STATE_PATHS.filter((p) => !src.includes(`"${p}"`));
  if (missing.length) bad("假 FDM 未写入这些状态字段（unpack 会读到 NaN）：\n      " + missing.join("\n      "));
  else ok(`全部 ${STATE_PATHS.length} 个状态字段均已写入`);
  // 接口契约
  for (const m of ["readState", "get:", "set:", "step:", "reset:"]) {
    if (src.includes(m)) ok(`导出接口含 ${m.replace(":", "")}`);
    else bad(`导出接口缺 ${m.replace(":", "")}`);
  }
  if (src.includes("STATE_PATHS") && src.includes("from \"./adapter.browser.js\"")) ok("状态下标复用 adapter.browser.js 的 I（不会漂移）");
  else warn("未复用 adapter.browser.js 的 I —— 请确认下标与 STATE_PATHS 一致");
}

// ── ⑥ 目标项目的补丁状态 ──
section("⑥ 目标项目补丁状态");
if (!DIR) {
  warn("未提供 --dir，跳过（用 --dir <fcs-demo> 可检查补丁状态）");
} else {
  const mainJs = path.join(DIR, "src/main.js");
  const html = path.join(DIR, "index.html");
  if (!fs.existsSync(mainJs) || !fs.existsSync(html)) {
    bad(`--dir 不是 fcs-demo 目录（缺 src/main.js 或 index.html）：${DIR}`);
  } else {
    const m = fs.readFileSync(mainJs, "utf8");
    const h = fs.readFileSync(html, "utf8");
    const checks = [
      ["main.js 已导入假 FDM", m.includes("createNoAeroFdm")],
      ["main.js 有 AERO_ON 开关", m.includes("window.__AERO__")],
      ["main.js 启动日志如实描述", m.includes("简化动力学（无气动数据）")],
      ["main.js 绑定了 aeroBtn", m.includes('"aeroBtn"')],
      ["index.html 有 aeroBtn", h.includes('id="aeroBtn"')],
      ["假 FDM 文件已落盘", fs.existsSync(path.join(DIR, "src/fdm/noaero.browser.js"))],
    ];
    const done = checks.filter(([, p]) => p).length;
    // 「全没打」与「全打了」都是合法状态，只有「打了一半」才是真问题。
    if (done === 0) {
      warn(`气动开关【未安装】（${checks.length} 项均未打）—— 这是初始状态，不算错误。`);
      warn("要演示第 3 幕请执行：node scripts/apply_aero_toggle.mjs --dir " + DIR);
    } else if (done === checks.length) {
      ok(`气动开关【已完整安装】（${done}/${checks.length}）`);
    } else {
      for (const [name, pass] of checks) (pass ? ok : bad)(name);
      bad(`补丁只打了 ${done}/${checks.length} 项 —— 状态不一致，请重新执行 apply_aero_toggle.mjs`);
    }

    // 锚点是否仍可匹配（未打补丁时才有意义）
    const ANCHORS = [
      ["main.js 导入行锚点", /^import \{ createFdm, unpack \} from "\.\/fdm\/adapter\.browser\.js";[ \t]*$/m],
      ["main.js RATE 行锚点", /^const RATE = 120, DT = 1 \/ RATE, FT2M = 0\.3048;[ \t]*$/m],
      ["main.js 启动日志锚点", /^([ \t]*)app\.log\.push\(app\.simT, "info", "系统就绪：JSBSim 内核装载完成，3D 视景已建立", 0\);[ \t]*$/m],
      ["main.js window.app 锚点", /^([ \t]*)window\.app = app;([^\n]*)$/m],
      ["index.html csvBtn 锚点", /^([ \t]*)<button id="csvBtn"[^\n]*<\/button>[ \t]*$/m],
    ];
    for (const [name, re] of ANCHORS) {
      const src = name.startsWith("index.html") ? h : m;
      const n = (src.match(new RegExp(re.source, re.flags + "g")) || []).length;
      if (n === 1) ok(`${name} 可匹配`);
      else if (n === 0) warn(`${name} 匹配 0 次 —— 可能已打补丁，或源码结构已变`);
      else bad(`${name} 匹配 ${n} 次（应为 0 或 1）—— 请更新锚点后再打补丁`);
    }
  }
}

// ── 汇总 ──
console.log("\n" + "─".repeat(48));
console.log(fails === 0 ? `自检通过（${warns} 条提醒）` : `自检失败：${fails} 项错误，${warns} 条提醒`);
process.exit(fails === 0 ? 0 : 1);
