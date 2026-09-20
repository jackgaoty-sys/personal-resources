#!/usr/bin/env node
// 四幕演示时间轴驱动（Playwright）
// ══════════════════════════════════════════════════════════════════
// 驱动的是【真实运行的应用】：真 JSBSim 内核、真飞控、真配平。
// 因此它随时可以被人工接管 —— 展示人在浏览器里手操不会被脚本回滚。
//
// 用法：
//   node demo_driver.mjs --dir <fcs-demo> --dry      # 只校验时间轴结构，不启浏览器
//
// ⚠ 本脚本【不再执行演示】。演示的全部动作必须在 Codar **内置浏览器**里触发
//   （in_app_browser_navigate / interact / evaluate / screenshot）—— 观众看的是 Codar 里的
//   画面；这里起的独立窗口 Chromium 观众看不到，不算演示。见 references/browser-stage-contract.md。
//   非 --dry 的调用会直接报错退出。
//
// 它现在的两个用途：
//   ① --dry 校验时间轴结构；② 当【提词单】读 —— 每一幕该按什么、该看什么、该断言什么。
//
// （历史上的浏览器执行路径与 --no-pause 均已停用；下面的执行代码保留仅作参考。）

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";

// ── 参数 ──
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DIR = val("--dir");
const TIMELINE = val("--timeline", "assets/timeline.default.json");
const OUT = path.resolve(val("--out", "./demo-artifacts"));
const URL_OVERRIDE = val("--url");
const HEADLESS = has("--headless");
const DRY = has("--dry");

// 明确拒绝旧旗标：宁可报错，也不要“以为跳过了暂停、其实没跳过”这类静默歧义。
if (has("--no-pause")) {
  console.error("✗ --no-pause 已被移除：本驱动只支持实机演示，暂停点必须由真人推进。");
  console.error("  演示前只想校验时间轴，请用 --dry。见 references/browser-stage-contract.md。");
  process.exit(2);
}

// 本脚本【不再执行演示】。演示的全部动作必须在 Codar 内置浏览器里触发：
// 这里起的是独立窗口的 Chromium，观众看不到它，不算演示（见 browser-stage-contract.md）。
if (!DRY) {
  console.error("✗ 本脚本不再执行演示。");
  console.error("  演示的全部动作必须在 Codar 内置浏览器里触发（in_app_browser_*）——");
  console.error("  独立窗口的 Chromium 观众看不到，不算演示。");
  console.error("  这里只保留 --dry：校验时间轴结构，不启浏览器。");
  process.exit(2);
}

if (!DIR) { console.error("用法: node demo_driver.mjs --dir <fcs-demo 目录> [--timeline ...] [--out ...]"); process.exit(2); }
const ROOT = path.resolve(DIR);

const logLines = [];
const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function say(s) { const line = `[${nowIso()}] ${s}`; console.log(line); logLines.push(line); }
function head(s) { const line = `\n======== ${s} ========`; console.log(line); logLines.push(line); }

// ── 加载时间轴 ──
function loadTimeline() {
  const p = path.isAbsolute(TIMELINE) ? TIMELINE : path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", TIMELINE);
  const cands = [TIMELINE, p];
  let file = null;
  for (const c of cands) if (c && fs.existsSync(c)) { file = c; break; }
  if (!file) { console.error("找不到时间轴文件：" + TIMELINE); process.exit(2); }
  const tl = JSON.parse(fs.readFileSync(file, "utf8"));
  say(`时间轴：${file}（${tl.acts.length} 幕）`);
  return tl;
}

// ── 校验（--dry）──
const KNOWN_ACTIONS = new Set([
  "load", "waitSim", "wait", "keys", "press", "inject", "clearFaults", "setLaw",
  "preset", "speed", "camera", "pause", "resume", "ghost", "shot", "csv", "note", "eval",
  "expect",   // 纯断言步：不动浏览器，只跑 expect[]（用于把"这一幕成立"钉在时间轴上）
]);
const REQUIRED = {
  load: ["aero"], waitSim: ["seconds"], wait: ["ms"], keys: ["hold", "ms"], press: ["code"],
  inject: ["faults"], setLaw: ["law"], preset: ["id"], speed: ["x"], camera: ["mode"],
  ghost: ["visible"], shot: ["name"], csv: ["name"], eval: ["expr"],
};
function validate(tl) {
  const errs = [];
  if (!tl.acts || !Array.isArray(tl.acts)) errs.push("缺少 acts 数组");
  (tl.acts || []).forEach((a, ai) => {
    if (!a.id) errs.push(`acts[${ai}] 缺少 id`);
    (a.steps || []).forEach((s, si) => {
      const at = `acts[${ai}].steps[${si}]`;
      if (!KNOWN_ACTIONS.has(s.action)) { errs.push(`${at} 未知 action: ${s.action}`); return; }
      for (const k of REQUIRED[s.action] || []) {
        if (s[k] === undefined) errs.push(`${at} (${s.action}) 缺少参数 ${k}`);
      }
      if (s.expect && !Array.isArray(s.expect)) errs.push(`${at} expect 应为数组`);
    });
  });
  return errs;
}

// ── 接管 ──
let SKIP_PAUSES = false;   // 只能由真人在暂停点输入 skip 置位，没有别的入口
const rl = DRY ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
// stdin 是管道/重定向且已 EOF 时，readline 会自行 close，之后 rl.question 会抛
// ERR_USE_AFTER_CLOSE。注意：这里【不再】降级为“自动继续” —— 那等于无人值守假演示。
let rlClosed = false;
if (rl) rl.on("close", () => { rlClosed = true; });
let pendingNextAct = false;

function abortTakeover() {
  // 接管不可用 = 演不了。这是硬错误，不是可以“降级处理”的情况。
  say("✗ 无法接管 —— 本驱动没有无人值守模式。");
  say("  暂停点必须由真人在真实终端里按 Enter 推进。");
  say("  演示前只想校验时间轴，请用 --dry。见 references/browser-stage-contract.md。");
  return "abort";
}

function takeover(promptText) {
  // 真人刚刚输入过 skip —— 那是现场时间不够时的主动取舍，允许。
  if (SKIP_PAUSES) return Promise.resolve("continue");
  // 接管不可用：绝不“自动继续”，否则整段教学会被静默跳过。
  if (!rl || rlClosed) return Promise.resolve(abortTakeover());
  return new Promise((resolve) => {
    const onAnswer = (ans) => {
      const a = (ans || "").trim().toLowerCase();
      if (a === "q") { say("展示人请求退出。"); rl.close(); resolve("quit"); }
      else if (a === "skip") { SKIP_PAUSES = true; say("已跳过剩余全部暂停点。"); resolve("continue"); }
      else if (a === "next") { say("跳到下一幕。"); resolve("next"); }
      else if (a === "p") {
        try { rl.question("   已暂停。再按 Enter 继续 > ", () => resolve("continue")); }
        catch { rlClosed = true; resolve(abortTakeover()); }
      } else resolve("continue");
    };
    try {
      rl.question(`\n⏸  ${promptText}\n   [Enter=继续 / p=暂停 / next=下一幕 / skip=跳过全部暂停 / q=退出] > `, onAnswer);
    } catch {
      // 例：printf '\n' | node demo_driver.mjs … —— stdin 已 EOF，接管不可用。
      // 不降级为自动继续：那会让四幕在没人看的情况下“跑完”，等于假演示。
      rlClosed = true;
      resolve(abortTakeover());
    }
  });
}

// ── 动作执行 ──
async function execStep(page, step, ctx) {
  const settle = step.settleMs ?? ctx.defaults.settleMs ?? 800;
  const timeout = ctx.defaults.stepTimeoutMs ?? 20000;
  const A = step.action;

  switch (A) {
    case "load": {
      const base = (URL_OVERRIDE || ctx.meta.baseUrl || "http://localhost:5173").replace(/\/$/, "");
      const url = `${base}/?aero=${step.aero}${step.query ? "&" + step.query : ""}`;
      say(`load → ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForFunction(() => window.app && window.app.st && window.app.simT > 0, null, { timeout });
      say(`  就绪：aero=${await page.evaluate(() => window.__AERO__)}，simT=${(await page.evaluate(() => window.app.simT)).toFixed(2)}s`);
      break;
    }

    case "waitSim": {
      const t0 = await page.evaluate(() => window.app.simT);
      say(`waitSim ${step.seconds}s`);
      await page.waitForFunction((a) => window.app.simT >= a.t0 + a.s, { t0, s: step.seconds }, { timeout: Math.max(timeout, step.seconds * 4000) });
      break;
    }

    case "wait":
      say(`wait ${step.ms}ms`);
      await page.waitForTimeout(step.ms);
      break;

    case "keys": {
      say(`keys ${step.hold.join("+")} 保持 ${step.ms}ms`);
      for (const k of step.hold) await page.keyboard.down(k);
      await page.waitForTimeout(step.ms);
      for (const k of step.hold.slice().reverse()) await page.keyboard.up(k);
      break;
    }

    case "press":
      say(`press ${step.code}`);
      await page.keyboard.press(step.code);
      break;

    case "inject": {
      say(`inject ${step.faults.join(", ")}`);
      await page.evaluate((faults) => {
        const ids = { alpha_sensor: "fAlpha", ahrs: "fAhrs", elevator_actuator: "fElev", aileron_jam: "fAil", rudder_jam: "fRud" };
        for (const f of faults) {
          window.app.fcs.injectFault(f);
          const el = document.getElementById(ids[f]);
          if (el) el.classList.add("on");
        }
      }, step.faults);
      break;
    }

    case "clearFaults":
      say("clearFaults");
      await page.evaluate(() => {
        window.app.fcs.clearAllFaults();
        for (const id of ["fAlpha", "fAhrs", "fElev", "fAil", "fRud"]) {
          const el = document.getElementById(id);
          if (el) el.classList.remove("on");
        }
      });
      break;

    case "setLaw":
      say(`setLaw ${step.law}`);
      await page.evaluate((law) => window.app.fcs.setLaw(law), step.law);
      break;

    case "preset": {
      say(`preset ${step.id}`);
      await page.selectOption("#preset", step.id);
      await page.waitForTimeout(300);
      break;
    }

    case "speed": {
      say(`speed ${step.x}x`);
      await page.evaluate((x) => {
        const btns = Array.from(document.querySelectorAll("#rates button"));
        const b = btns.find((el) => el.textContent.trim() === x + "x");
        if (b) b.click();
      }, step.x);
      break;
    }

    case "camera": {
      say(`camera ${step.mode}`);
      for (let i = 0; i < 5; i++) {
        const cur = await page.evaluate(() => (window.app.scene ? window.app.scene.getMode() : null));
        if (cur === step.mode) break;
        await page.keyboard.press("KeyC");
        await page.waitForTimeout(400);
      }
      const got = await page.evaluate(() => (window.app.scene ? window.app.scene.getMode() : null));
      if (got !== step.mode) say(`  ! 视角未切到 ${step.mode}（当前 ${got}）`);
      break;
    }

    case "pause":
      say("pause（把画面交给展示人后，脚本会停在下一步之前）");
      await setPaused(page, true);
      break;

    case "resume":
      say("resume");
      await setPaused(page, false);
      break;

    case "ghost":
      say(`ghost visible=${step.visible}`);
      await page.evaluate((v) => {
        if (!window.app.scene) return;
        // 只在状态不一致时切换（setGhostVisible 是翻转语义，V 键同款）
        const cur = window.app.scene.getGhostVisible();
        if (cur !== v) window.app.scene.setGhostVisible(v);
      }, step.visible);
      break;

    case "shot": {
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `${step.name}.png`);
      await page.screenshot({ path: file, fullPage: !!step.fullPage });
      say(`shot → ${file}`);
      break;
    }

    case "csv": {
      fs.mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `${step.name}.csv`);
      const hasData = await page.evaluate(() => window.app.rec.count >= 2);
      if (!hasData) { say("  ! 暂无可导出数据（rec.count < 2），跳过"); break; }
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout }),
        page.click("#csvBtn"),
      ]);
      await download.saveAs(file);
      say(`csv → ${file}`);
      break;
    }

    case "note":
      say(`note: ${step.text || ""}`);
      break;

    case "expect":
      // 纯断言步：什么也不做，断言由 runExpects() 在下面统一执行。
      // 单独成步是为了让"这一幕成立的判据"在时间轴里可见、可注释。
      if (step.note) say(`assert: ${step.note}`);
      break;

    case "eval": {
      const v = await page.evaluate((src) => (0, eval)(src), step.expr);
      if (step.save) ctx.vars[step.save] = v;
      say(`eval ${step.expr}  ⇒ ${JSON.stringify(v)}`);
      break;
    }

    default:
      say(`  ! 未实现的动作：${A}`);
  }

  if (settle > 0 && !["note", "eval", "expect"].includes(A)) await page.waitForTimeout(settle);
}

async function setPaused(page, want) {
  const cur = await page.evaluate(() => !!window.app.paused);
  if (cur === want) return;
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => !!window.app.paused);
  if (after !== want) say(`  ! 暂停状态未达预期（want=${want}, got=${after}）—— 可能处于坠毁终止态`);
}

// ── 断言 ──
async function runExpects(page, step, ctx) {
  if (!step.expect) return;
  for (const e of step.expect) {
    let pass = false, err = null;
    try { pass = await page.evaluate((src) => !!(0, eval)(src), e.expr); }
    catch (ex) { err = ex.message; }
    if (pass) say(`  ✓ 断言通过：${e.desc || e.expr}`);
    else if (step.optional || e.optional) say(`  ! 断言未通过（optional）：${e.desc || e.expr}${err ? " · " + err : ""}`);
    else say(`  ✗ 断言失败：${e.desc || e.expr}${err ? " · " + err : ""}   [expr: ${e.expr}]`);
  }
}

// ── 主流程 ──
async function main() {
  const tl = loadTimeline();
  let quitEarly = false;
  const ctx = {
    meta: tl.meta || {},
    defaults: tl.defaults || {},
    vars: {},
  };

  const errs = validate(tl);
  if (errs.length) { console.error("时间轴校验失败：\n  " + errs.join("\n  ")); process.exit(3); }
  say("时间轴校验通过。");

  if (DRY) { say("--dry 模式：不启动浏览器，退出。"); finish(0); return; }

  // ── 解析 playwright（从 fcs-demo 的依赖里找）──
  let chromium;
  try {
    const req = createRequire(path.join(ROOT, "package.json"));
    const pwPath = req.resolve("playwright");
    // Node 24 + playwright(CJS) 互操作：具名导出取不到，需从 default 上取
    const _pw = await import(pwPath);
    chromium = _pw.chromium ?? _pw.default?.chromium;
    if (!chromium) throw new Error("无法从 playwright 取到 chromium");
    say(`playwright：${pwPath}`);
  } catch (e) {
    console.error("\n未能在 fcs-demo 里找到 playwright。请先在 fcs-demo 里安装：");
    console.error("  cd " + ROOT + " && npm i -D playwright && npx playwright install chromium");
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") logLines.push(`    [page error] ${m.text()}`); });

  fs.mkdirSync(OUT, { recursive: true });

  for (const act of tl.acts) {
    head(`${act.id} · ${act.title || ""}`);
    if (act.narration) say(`讲解提示：${act.narration}`);

    const needPause = (act.pauseBefore ?? true);   // 幕边界一律暂停，没有开关可以关掉
    if (needPause) {
      const r = await takeover(`即将开始【${act.title || act.id}】。`);
      if (r === "abort") { await browser.close(); finish(1); return; }
      if (r === "quit") { quitEarly = true; break; }
    }

    for (const step of act.steps || []) {
      if (step.pause) {
        const r = await takeover(`${act.id} 暂停点：${step.note || step.action}`);
        if (r === "abort") { await browser.close(); finish(1); return; }
        if (r === "quit") { await browser.close(); finish(0); return; }
        if (r === "next") break;
      }
      if (step.note) say(`— ${step.note}`);
      try {
        await execStep(page, step, ctx);
      } catch (ex) {
        say(`  ! 步骤出错（不中断）：${step.action} · ${ex.message}`);
      }
      await runExpects(page, step, ctx);
    }
  }

  say(quitEarly
    ? "\n展示人提前退出 —— 未跑完全部幕（已产出的文件保留）。"
    : "\n全部幕执行完毕。");
  // 收尾提示只在“接管本来可用”时才问；否则不必报错。
  if (rl && !rlClosed) await takeover("演示结束。按 Enter 关闭浏览器。").catch(() => {});
  await browser.close();
  finish(0);
}

function finish(code) {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "run.log"), logLines.join("\n") + "\n");
    console.log(`\n日志：${path.join(OUT, "run.log")}`);
  } catch { /* 忽略 */ }
  if (rl) rl.close();
  process.exit(code);
}

main().catch((e) => { console.error("驱动异常：", e); finish(1); });
