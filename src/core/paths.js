/**
 * paths.js — 插件的落盘位置与浏览器可执行文件查找。
 *
 * 约定（与工作区里另外两个插件一致）：数据放 `$DSH_HOME`，默认 `~/.dsh`。
 *   - 浏览器用户目录：<DSH_HOME>/wechat-135/browser   （135 账号登录状态存在这里，只登一次）
 *   - 备份：          <DSH_HOME>/wechat-135/backups   （每次写编辑器前自动备份）
 *   - 产物：          <DSH_HOME>/wechat-135/out       （截图 / 分析 JSON / 生成的 HTML）
 *
 * 每一项都能用环境变量覆盖，方便本地开发：
 *   WX135_DATA_DIR / WX135_PROFILE_DIR / WX135_BROWSER_PATH
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dshHome(env = process.env) {
  return env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
}

export function dataDir(env = process.env) {
  return env.WX135_DATA_DIR || join(dshHome(env), 'wechat-135');
}

export function profileDir(env = process.env) {
  return env.WX135_PROFILE_DIR || join(dataDir(env), 'browser');
}

export function backupsDir(env = process.env) {
  return join(dataDir(env), 'backups');
}

export function outDir(env = process.env) {
  return join(dataDir(env), 'out');
}

/** 确保目录存在并返回路径。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 时间戳，用于文件名：2026-11-14T22-30-11。 */
export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/** 常见 Chromium 内核浏览器安装位置（Windows 优先 Edge）。 */
export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function resolveBrowserPath(explicit, env = process.env) {
  const wanted = explicit || env.WX135_BROWSER_PATH;
  if (wanted && existsSync(wanted)) return wanted;
  for (const p of BROWSER_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}
