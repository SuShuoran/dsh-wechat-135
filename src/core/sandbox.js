/**
 * sandbox.js — 一个「干净的页面」标签页，用来在不碰 135 编辑器状态的前提下
 * 预览 / 解析 / 清空模板 HTML。
 *
 * 为什么需要：模板清空、套版、排版预览都是**破坏性 DOM 操作**。
 * 在编辑器里直接做，稍有不慎就把用户正在编辑的稿子改了（历史上被覆盖过两次）。
 * 所以默认流程是：读编辑器 HTML → 灌进沙箱页 → 在沙箱里折腾 → 满意了再写回编辑器。
 */
import { evaluate, evaluateJson, newTab, sleep } from './cdp.js';
import { buildSandboxHtml } from './template.js';

export const SANDBOX_TAB_MARK = 'wx135-sandbox';

/** 找（或新建）沙箱标签页。 */
export async function ensureSandboxTab(host, targets) {
  const found = (targets || []).find(
    (t) => t.type === 'page' && (t.url || '').startsWith('about:blank'),
  );
  if (found) return found;
  return newTab(host, 'about:blank');
}

/** 把一段完整 HTML 写进沙箱页。 */
export async function loadSandboxHtml(conn, html, { width = 375 } = {}) {
  const full = buildSandboxHtml(html, { width });
  const payload = JSON.stringify(full);
  try {
    await conn.send('Page.bringToFront');
  } catch {
    /* ignore */
  }
  await evaluate(conn, `(() => { document.open(); document.write(${payload}); document.close(); return 'ok'; })()`);
  await sleep(600);
  return waitSandboxImages(conn);
}

/**
 * 等沙箱里的图片加载完。
 *
 * **从 Node 侧轮询，不在页面里等**：沙箱页通常是后台标签页，Chrome 会把后台标签页的
 * setTimeout 降到每分钟一次，页面里的 "8 秒超时" 根本不会按时触发，整个 evaluate 会挂死。
 */
export async function waitSandboxImages(conn, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { total: 0, done: 0, failed: 0 };
  while (Date.now() < deadline) {
    last = await evaluateJson(conn, `(() => {
      const imgs = [...document.images];
      let done = 0;
      let failed = 0;
      for (const im of imgs) {
        if (!im.complete) continue;
        done += 1;
        if (!im.naturalWidth) failed += 1;
      }
      return JSON.stringify({ total: imgs.length, done, failed });
    })()`);
    if (!last || last.total === 0 || last.done >= last.total) {
      return { ok: true, ...last, waitedMs: timeoutMs - (deadline - Date.now()) };
    }
    await sleep(350);
  }
  return { ok: false, ...last, timeout: true, waitedMs: timeoutMs };
}

/** 沙箱页的通用根元素表达式（buildSandboxHtml 里那个 #wx135-sandbox）。 */
export const SANDBOX_ROOT = "document.getElementById('wx135-sandbox')";
