/**
 * browser.js — 管一个「带调试端口」的专用浏览器实例。
 *
 * 为什么必须专用实例：135 编辑器的账号状态、草稿状态都在浏览器 profile 里。
 * 用用户日常的 Edge 开 `--remote-debugging-port` 会把他的正常会话搅进调试实例；
 * 所以插件自己开一个独立 `--user-data-dir`，**135 只在这个实例里登录一次**。
 *
 * 两个来源：
 *   1. 已经有一个 9333 在监听（比如用户按提示手动起的）→ 直接接管，不重复拉。
 *   2. 没在监听 → 找到 Edge/Chrome 可执行文件，后台拉起，等 /json/version 出现。
 *
 * 拉不起来（沙箱禁进程等）不是致命错误：把"手动启动命令"原样返回给调用方。
 */
import { spawn } from 'node:child_process';
import { DEFAULT_HOST, browserVersion, sleep } from './cdp.js';
import { ensureDir, profileDir, resolveBrowserPath } from './paths.js';

export const EDITOR_URL = 'https://www.135editor.com/beautify_editor.html';

export function hostToPort(host = DEFAULT_HOST) {
  try {
    return Number(new URL(host).port) || 9333;
  } catch {
    return 9333;
  }
}

/** 手动启动命令（用户自己开浏览器时照抄这一行）。 */
export function manualLaunchCommand({ host = DEFAULT_HOST, profile = profileDir() } = {}) {
  const browser = resolveBrowserPath() || '<Edge 或 Chrome 的 exe 路径>';
  const port = hostToPort(host);
  return `"${browser}" --remote-debugging-port=${port} --user-data-dir="${profile}" --remote-allow-origins=* --no-first-run "${EDITOR_URL}"`;
}

/** 探一下调试端口是否活着。 */
export async function probeBrowser(host = DEFAULT_HOST) {
  try {
    const version = await browserVersion(host);
    return { ok: true, host, browser: version?.Browser || '', wsUrl: version?.webSocketDebuggerUrl || '' };
  } catch (e) {
    return { ok: false, host, error: String(e?.message || e) };
  }
}

/** 拉起浏览器；已经是活的就直接返回。 */
export async function ensureBrowser({
  host = DEFAULT_HOST,
  profile,
  browserPath,
  launch = true,
  url = EDITOR_URL,
  waitMs = 25000,
} = {}) {
  const running = await probeBrowser(host);
  if (running.ok) return { ...running, started: false };

  if (!launch) {
    return {
      ok: false,
      host,
      error: '调试端口没有监听',
      manualCommand: manualLaunchCommand({ host, profile: profile || profileDir() }),
    };
  }

  const exe = resolveBrowserPath(browserPath);
  if (!exe) {
    return {
      ok: false,
      host,
      error: '找不到 Edge/Chrome 可执行文件',
      manualCommand: manualLaunchCommand({ host, profile: profile || profileDir() }),
    };
  }

  const port = hostToPort(host);
  const userDataDir = ensureDir(profile || profileDir());
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeMiniMenu',
    url,
  ];

  let spawnError = null;
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.unref();
  } catch (e) {
    spawnError = e;
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(500);
    if (spawnError) break;
    const result = await probeBrowser(host);
    if (result.ok) return { ...result, started: true, executable: exe, profileDir: userDataDir };
  }

  return {
    ok: false,
    host,
    error: spawnError ? `启动浏览器失败: ${spawnError.message}` : '浏览器已启动但调试端口未就绪',
    manualCommand: manualLaunchCommand({ host, profile: userDataDir }),
  };
}
