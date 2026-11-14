/**
 * index.js — dsh-wechat-135 插件入口。**只做注册**：
 *   - 一个 Host 半侧（本文件）：把 `src/tools.js` 里的工具注册给 agent；
 *   - 浏览器操作全部通过本机 CDP（`src/core/*`），不需要任何 npm 依赖。
 *
 * 之后加 Client 半侧（DSH 右侧「公众号」面板）时，再补 `lib/client.js`
 * 与 package.json 的 `dsh.client` 字段；那之前不要声明 client，否则激活会因缺 bundle 失败。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as paths from './core/paths.js';
import { createTools } from './tools.js';

export const name = 'dsh-wechat-135';

/**
 * 只声明 `tools`。**不要**把 `attachments` / `webServer` 写进 inject：
 * cordis 的 inject 是硬前缀，服务没就绪 apply 根本不会被调用，插件会永远停在"加载中"。
 * 需要可选服务时用 `ctx.get()` / `ctx.inject([...], cb)` 运行期探测。
 */
export const inject = ['tools'];

/**
 * 解析宿主的 `@deepseek-ai/dsh-tools`。
 *
 * 正常安装时裸包名就能解析（DSH 的 cordis loader 会从 app.asar 里给它自己的包做解析），
 * 但本地开发/测试、或者插件被软链到 workspace 时可能解析不到，所以按顺序兜底：
 *   1. 裸包名
 *   2. `DSH_TOOLS_PATH` 环境变量
 *   3. Electron 安装目录里的 app.asar / app.asar.unpacked
 */
async function loadDefineTool() {
  const tried = [];
  const tryImport = async (spec) => {
    try {
      const mod = await import(spec);
      if (mod?.defineTool) return mod.defineTool;
      tried.push(`${spec}: 模块里没有 defineTool`);
    } catch (e) {
      tried.push(`${spec}: ${e?.code || e?.message || e}`);
    }
    return null;
  };

  const bare = await tryImport('@deepseek-ai/dsh-tools');
  if (bare) return bare;

  if (process.env.DSH_TOOLS_PATH) {
    const { pathToFileURL } = await import('node:url');
    const override = await tryImport(pathToFileURL(process.env.DSH_TOOLS_PATH).href);
    if (override) return override;
  }

  // Electron 宿主：<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js
  const resources = process.resourcesPath
    || (process.execPath ? join(process.execPath, '..', '..', 'resources') : null);
  if (resources) {
    const { pathToFileURL } = await import('node:url');
    const rel = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'];
    const candidates = [
      join(resources, 'app.asar', ...rel),
      join(resources, 'app.asar.unpacked', ...rel),
    ];
    for (const candidate of candidates) {
      const fn = await tryImport(pathToFileURL(candidate).href);
      if (fn) return fn;
    }
  }

  throw new Error(
    `无法解析 @deepseek-ai/dsh-tools。已尝试：\n- ${tried.join('\n- ')}`,
  );
}

/** 宿主启动阶段会同步等 apply；任何 await 卡死都会把整个应用卡在启动屏。 */
const APPLY_TIMEOUT_MS = 15000;

export async function apply(ctx) {
  try {
    return await withTimeout(registerAll(ctx), APPLY_TIMEOUT_MS, 'registerAll');
  } catch (e) {
    // 最坏情况是插件不能用，而不是应用起不来
    try {
      ctx?.logger?.error?.(`[dsh-wechat-135] 加载失败: ${e?.stack ?? e}`);
    } catch {
      /* 连日志都写不了就算了 */
    }
    writeLoadStatus({ ok: false, error: String(e?.stack || e?.message || e) });
    if (process.env.DSH_WECHAT135_DEBUG) throw e;
    return () => {};
  }
}

/**
 * 把加载结果写到 `~/.dsh/wechat-135/plugin-load.json`。
 * 宿主的 logger 在 Desktop 里不好找，"插件到底加载成功没有"必须有个确定的观察点。
 */
function writeLoadStatus(payload) {
  try {
    const { ensureDir, dataDir } = paths;
    const dir = ensureDir(dataDir());
    const file = join(dir, 'plugin-load.json');
    writeFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2),
      'utf8',
    );
  } catch {
    /* 写不了就算了，不能因为记日志把插件搞挂 */
  }
}

async function registerAll(ctx) {
  const defineTool = await loadDefineTool();
  const tools = createTools(defineTool);
  const disposers = [];
  try {
    for (const tool of tools) disposers.push(ctx.tools.register(tool));
  } catch (e) {
    // 注册到一半失败：把已注册的收回去，避免半残状态
    for (const d of disposers.reverse()) d?.();
    throw e;
  }
  try {
    ctx?.logger?.info?.(`[dsh-wechat-135] 已注册 ${tools.length} 个工具`);
  } catch {
    /* ignore */
  }
  writeLoadStatus({ ok: true, tools: tools.map((t) => t.name) });
  return () => {
    for (const dispose of disposers.reverse()) dispose?.();
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
