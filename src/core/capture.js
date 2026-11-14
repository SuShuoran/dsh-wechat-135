/**
 * capture.js — 把正文/预览页截成能看的图。
 *
 * 两个目标：
 *   1. 编辑器里的正文（iframe 内部滚动，外层 chrome 要藏掉）
 *   2. 普通页面（135 的预览页 / 本地渲染的 HTML）：按手机宽度滚屏截
 *
 * 为什么分屏而不是整页长图：
 *   - 135 的正文动辄上万像素，`Page.captureScreenshot` 会直接报
 *     `Unable to capture screenshot`；
 *   - 图片任一边超过 8192px 时，read_image 也打不开。
 *   所以固定 430 宽、每屏 1400 高，逐屏滚动逐屏截。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureScreenshot, clearViewport, evaluate, evaluateJson, setViewport, sleep } from './cdp.js';
import { FRAME_FINDER } from './editor.js';

const HIDE_CHROME = String.raw`
  const hide = ['#header', '.header', '#js_left', '.editorslide', '.left-nav', '.sidebar', '#pay_all',
    '.nav-bar', '.top-nav', '.editor-top', '.right-tools', '.float-tools'];
  window.__wx135Hidden = [];
  for (const s of hide) {
    document.querySelectorAll(s).forEach((e) => {
      if (e.style.display !== 'none') {
        window.__wx135Hidden.push([e, e.style.display]);
        e.style.display = 'none';
      }
    });
  }
  const area = document.querySelector('#js_editor, .editor2, .editor-main, #edui1');
  if (area) {
    window.__wx135Hidden.push([area, { position: area.style.position, width: area.style.width, margin: area.style.margin, padding: area.style.padding }]);
    area.style.position = 'static';
    area.style.width = '100%';
    area.style.margin = '0';
    area.style.padding = '0';
  }
  document.querySelectorAll('.edui-editor').forEach((e) => {
    window.__wx135Hidden.push([e, { border: e.style.border }]);
    e.style.border = '0';
  });
  window.scrollTo(0, 0);
`;

/** 把 hideChrome 改过的样式还原（截完图不能在用户页面上留指纹）。 */
const RESTORE_CHROME = String.raw`
  const saved = window.__wx135Hidden || [];
  for (const [el, prev] of saved) {
    try {
      if (typeof prev === 'string') el.style.display = prev;
      else for (const k of Object.keys(prev)) el.style[k] = prev[k];
    } catch (e) { /* ignore */ }
  }
  window.__wx135Hidden = null;
`;

/**
 * 截编辑器正文。返回 { files, contentHeight, width, sliceH }。
 * @param {object} opts
 * @param {string} opts.outDir 输出目录（绝对路径）
 */
export async function captureEditorSlices(conn, {
  outDir,
  width = 430,
  sliceH = 1400,
  maxSlices = 20,
  settleMs = 700,
  prefix = 'editor',
} = {}) {
  if (!outDir) throw new Error('outDir is required');
  mkdirSync(outDir, { recursive: true });
  try {
    await conn.send('Page.bringToFront');
  } catch {
    /* ignore */
  }

  await setViewport(conn, { width, height: sliceH, mobile: true });
  await sleep(800);
  await evaluate(conn, `(() => { ${HIDE_CHROME} return 'ok'; })()`);
  await sleep(400);

  const measured = await evaluateJson(conn, `(() => { ${FRAME_FINDER}
    const f = __wxPickEditorFrame();
    if (!f) return JSON.stringify({ ok: false });
    const d = f.contentDocument;
    const h = Math.max(d.body ? d.body.scrollHeight : 0, d.documentElement ? d.documentElement.scrollHeight : 0);
    return JSON.stringify({ ok: true, height: h, textLen: (d.body.innerText || '').length });
  })()`);
  if (!measured?.ok) {
    await clearViewport(conn);
    throw new Error('找不到编辑器正文 iframe');
  }

  const contentHeight = Math.max(measured.height || 0, 600);
  const slices = Math.min(maxSlices, Math.max(1, Math.ceil(contentHeight / sliceH)));
  const files = [];
  try {
    for (let i = 0; i < slices; i += 1) {
      const y = Math.min(i * sliceH, Math.max(0, contentHeight - sliceH * 0.25));
      await evaluate(conn, `(() => { ${FRAME_FINDER}
        const f = __wxPickEditorFrame();
        if (f && f.contentWindow) f.contentWindow.scrollTo(0, ${Math.round(y)});
        window.scrollTo(0, 0);
        return 'ok';
      })()`);
      await sleep(settleMs);
      const buffer = await captureScreenshot(conn, { format: 'png' });
      const file = join(outDir, `${prefix}-${String(i).padStart(2, '0')}.png`);
      writeFileSync(file, buffer);
      files.push(file);
    }
  } finally {
    await evaluate(conn, `(() => { ${RESTORE_CHROME} return 'ok'; })()`).catch(() => {});
    await clearViewport(conn);
  }
  return { files, contentHeight, width, sliceH };
}

/**
 * 截普通页面（预览页 / 本地渲染页）。先滚一遍让懒加载图片出来，再逐屏截。
 */
export async function capturePageSlices(conn, {
  outDir,
  width = 430,
  sliceH = 1400,
  maxSlices = 20,
  settleMs = 500,
  prefix = 'page',
} = {}) {
  if (!outDir) throw new Error('outDir is required');
  mkdirSync(outDir, { recursive: true });
  try {
    await conn.send('Page.bringToFront');
  } catch {
    /* ignore */
  }

  await setViewport(conn, { width, height: sliceH, mobile: true });
  await sleep(1000);

  // 预热：先滚到最下面，触发图片加载
  const rough = await evaluate(conn, 'document.documentElement.scrollHeight');
  for (let y = 0; y < Math.min(Number(rough) || 0, 60000); y += Math.floor(sliceH * 0.8)) {
    await evaluate(conn, `window.scrollTo(0, ${y}); undefined`);
    await sleep(220);
  }
  await evaluate(conn, 'window.scrollTo(0, 0); undefined');
  await sleep(800);

  const total = Number(await evaluate(conn, 'document.documentElement.scrollHeight')) || sliceH;
  const slices = Math.min(maxSlices, Math.max(1, Math.ceil(total / sliceH)));
  const files = [];
  for (let i = 0; i < slices; i += 1) {
    const y = Math.min(i * sliceH, Math.max(0, total - sliceH * 0.3));
    await evaluate(conn, `window.scrollTo(0, ${Math.round(y)}); undefined`);
    await sleep(settleMs);
    const buffer = await captureScreenshot(conn, { format: 'png' });
    const file = join(outDir, `${prefix}-${String(i).padStart(2, '0')}.png`);
    writeFileSync(file, buffer);
    files.push(file);
  }
  await clearViewport(conn);
  return { files, contentHeight: total, width, sliceH };
}
