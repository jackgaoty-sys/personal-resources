#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  console.log("Usage: node scripts/prewarm.mjs --dir <fcs-demo> [--base-url http://localhost:5173] [--timeout-ms 30000]");
  process.exit(0);
}

const readArg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const demoDir = path.resolve(readArg("--dir", path.join(SKILL_DIR, "fcs-demo")));
const baseUrl = readArg("--base-url", "http://localhost:5173").replace(/\/$/, "");
const timeoutMs = Number(readArg("--timeout-ms", "30000"));
const packageJson = path.join(demoDir, "package.json");

if (!fs.existsSync(packageJson)) {
  throw new Error(`不是 fcs-demo 目录：${demoDir}`);
}

const requireFromDemo = createRequire(packageJson);
const { chromium } = requireFromDemo("playwright");
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  for (const aero of [0, 1]) {
    await page.goto(`${baseUrl}/?aero=${aero}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForFunction(() => window.app && window.app.st && window.app.simT > 0, null, { timeout: timeoutMs });
  }

  await page.goto("https://beta.cnai4s.com/science-tasks/139", { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForSelector("body", { timeout: timeoutMs });

  const card = pathToFileURL(path.join(SKILL_DIR, "assets", "aero-resource-download-card.html")).href;
  await page.goto(card, { waitUntil: "load", timeout: timeoutMs });
  await page.waitForSelector("main", { timeout: timeoutMs });

  await context.close();
  console.log("预热完成：服务、两种气动状态、外部数据源与资源卡片已就绪。请勿展示本日志。");
} finally {
  await browser.close();
}
