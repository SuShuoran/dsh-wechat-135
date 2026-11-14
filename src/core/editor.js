/**
 * editor.js — 135 编辑器页面的读写。
 *
 * 135 的正文在一个 UEditor iframe 里（`#ueditor_1`，contenteditable）。
 * **历史踩坑**：`UE.getEditor('ueditor_1').setContent()` 会返回成功但实际没写进去，
 * 唯一可靠的是直接写 `iframe.contentDocument.body.innerHTML` 再派发 `input` 事件。
 *
 * 另一个踩坑：用户经常同时开多个编辑器标签页，所以工具层必须先按内容特征选标签页，
 * 写完必须回读校验（首行/尾行/图片数/section 开闭数）。
 */
import { evaluate, evaluateJson, mouseClick, sleep } from './cdp.js';

/** 页面里找正文 iframe 的小工具（会被拼进每段页面 JS 前面）。 */
export const FRAME_FINDER = String.raw`
const __wxPickEditorFrame = () => {
  const byId = document.getElementById('ueditor_1');
  const usable = (f) => {
    try { const d = f && f.contentDocument; return !!(d && d.body); } catch (e) { return false; }
  };
  if (usable(byId)) return byId;
  let best = null;
  let bestLen = -1;
  for (const f of document.querySelectorAll('iframe')) {
    if (!usable(f)) continue;
    const n = (f.contentDocument.body.innerText || '').length;
    if (n > bestLen) { bestLen = n; best = f; }
  }
  return best;
};
`;

/** 把一段页面 JS 包成表达式。 */
function wrap(body) {
  return `(() => {\n${FRAME_FINDER}\n${body}\n})()`;
}

/** 解除弹窗遮挡 + 展开右侧工具栏（135 的保存按钮常被遮罩吞掉点击）。 */
export const CLEAR_OVERLAYS = String.raw`
  document.querySelectorAll('.modal-backdrop').forEach((e) => { e.style.display = 'none'; });
  document.querySelectorAll('.modal.show').forEach((e) => { e.style.display = 'none'; });
  document.body.classList.remove('modal-open');
  const rail = document.querySelector('.editorslide');
  if (rail) rail.style.display = 'block';
`;

/** 判断一个标签页是不是 135 编辑器。 */
export function isEditorUrl(url = '') {
  // 注意：135editor.com 这个域名本身就带 "editor"，只匹配 editor 字样会把官网首页也当成编辑器
  return /135editor\.com/i.test(url) && /(beautify_editor|editor\.html|editor\/)/i.test(url);
}

/** 从标签页列表里筛出编辑器。 */
export function listEditorTabs(targets = []) {
  return targets
    .filter((t) => t?.type === 'page' && isEditorUrl(t.url || ''))
    .map((t) => ({ id: t.id, url: t.url, title: t.title || '' }));
}

/** 读页面级状态 + 正文摘要（不返回整段 HTML，便宜）。 */
export async function detectEditor(conn) {
  const body = String.raw`
  const f = __wxPickEditorFrame();
  const page = {
    href: location.href,
    title: document.title,
    isEditor: /beautify_editor|editor/i.test(location.href),
    hasSaveSync: (document.body.innerText || '').includes('保存同步'),
    hasPreview: (document.body.innerText || '').includes('预览分享'),
    hasTemplateBrand: (document.body.innerText || '').includes('模板中心'),
  };
  if (!f) return JSON.stringify({ ok: false, page });
  const d = f.contentDocument;
  const b = d.body;
  const html = b.innerHTML || '';
  const text = b.innerText || '';
  const open = (html.match(/<section\b/gi) || []).length;
  const close = (html.match(/<\/section>/gi) || []).length;
  return JSON.stringify({
    ok: true,
    page,
    editor: {
      frameId: f.id || '',
      textLen: text.length,
      htmlLen: html.length,
      sections: [open, close],
      imgs: b.querySelectorAll('img').length,
      head: text.slice(0, 120).replace(/\n/g, ' '),
      tail: text.trim().slice(-160),
    },
  });`;
  return evaluateJson(conn, wrap(body));
}

/** 读整段正文 HTML。 */
export async function readEditorHtml(conn) {
  const body = String.raw`
  const f = __wxPickEditorFrame();
  if (!f) return JSON.stringify({ ok: false, error: '找不到编辑器 iframe' });
  return JSON.stringify({ ok: true, html: f.contentDocument.body.innerHTML });`;
  return evaluateJson(conn, wrap(body));
}

/**
 * 写入正文 HTML。**调用方必须先备份**（工具层做）。
 * 写完立即回读校验；返回 { ok, before, after }。
 */
export async function writeEditorHtml(conn, html) {
  const payload = JSON.stringify(html);
  const body = String.raw`
  const f = __wxPickEditorFrame();
  if (!f) return JSON.stringify({ ok: false, error: '找不到编辑器 iframe' });
  const b = f.contentDocument.body;
  const before = { textLen: (b.innerText || '').length, htmlLen: (b.innerHTML || '').length };
  b.innerHTML = __WX_HTML__;
  b.dispatchEvent(new Event('input', { bubbles: true }));
  b.dispatchEvent(new Event('change', { bubbles: true }));
  const afterHtml = b.innerHTML || '';
  const afterText = b.innerText || '';
  const open = (afterHtml.match(/<section\b/gi) || []).length;
  const close = (afterHtml.match(/<\/section>/gi) || []).length;
  return JSON.stringify({
    ok: true,
    before,
    after: {
      textLen: afterText.length,
      htmlLen: afterHtml.length,
      sections: [open, close],
      imgs: b.querySelectorAll('img').length,
      head: afterText.slice(0, 120).replace(/\n/g, ' '),
      tail: afterText.trim().slice(-160),
    },
  });`;
  return evaluateJson(conn, wrap(body.replace('__WX_HTML__', () => payload)));
}

/**
 * 在页面里按"元素自己的文字"找可点击控件，返回屏幕坐标。
 * 同一个按钮可能有 7 个 DOM 副本，只保留 offsetHeight>0 且宽度>0 的。
 */
export async function findControls(conn, texts) {
  const wanted = JSON.stringify(texts);
  const body = String.raw`
  const wanted = __WANTED__;
  const rows = [];
  for (const el of document.querySelectorAll('a,button,li,span,div,p')) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join('');
    if (!own || !wanted.includes(own)) continue;
    const r = el.getBoundingClientRect();
    if (el.offsetHeight > 0 && r.width > 0 && r.height > 0) {
      rows.push({ text: own, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
  }
  return JSON.stringify(rows);`;
  const rows = await evaluateJson(conn, wrap(body.replace('__WANTED__', () => wanted)));
  return Array.isArray(rows) ? rows : [];
}

/**
 * 点「快速保存」或「保存同步」，并抓保存请求确认真的发出去了。
 *
 * 135 的保存是 `POST /wx_msgs/save/<msgId>`；按钮本身经常被遮罩挡住，
 * 所以先清遮挡，再用物理鼠标事件点坐标。
 */
export async function saveDraft(conn, { sync = false, timeoutMs = 20000 } = {}) {
  const label = sync ? '保存同步' : '快速保存';
  const requests = [];
  const off = conn.on('Network.requestWillBeSent', (params) => {
    const url = params?.request?.url || '';
    if (/\/wx_msgs\/save\//i.test(url)) {
      requests.push({ url: url.slice(0, 300), method: params.request.method || 'POST' });
    }
  });
  try {
    await conn.send('Network.enable');
    await evaluate(conn, `(() => { ${CLEAR_OVERLAYS} return 'ok'; })()`);
    await sleep(300);
    const rows = await findControls(conn, sync ? ['保存同步', '同步'] : ['快速保存', '保存']);
    if (!rows.length) throw new Error(`页面上找不到「${label}」按钮（可能被弹窗挡住或侧栏折叠）`);
    await mouseClick(conn, rows[0].x, rows[0].y);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && requests.length === 0) {
      await sleep(250);
    }
    await sleep(600);
    return {
      ok: requests.length > 0,
      label,
      clicked: rows[0],
      requests,
      note: requests.length ? '已捕获保存请求' : `已点击「${label}」，但 ${timeoutMs}ms 内没看到保存请求`,
    };
  } finally {
    off();
    try {
      await conn.send('Network.disable');
    } catch {
      /* ignore */
    }
  }
}

/** 点「预览分享」并返回面板里出现的预览地址（二维码 img 的 uri 参数）。 */
export async function grabPreviewLink(conn, { timeoutMs = 20000 } = {}) {
  const rows = await findControls(conn, ['预览分享']);
  if (!rows.length) throw new Error('页面上找不到「预览分享」');
  await mouseClick(conn, rows[0].x, rows[0].y);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(800);
    const body = String.raw`
    const img = [...document.querySelectorAll('img')].find((im) => (im.src || '').includes('/tools/qrcode'));
    if (!img) return JSON.stringify({ ok: false });
    const m = /[?&]uri=([^&]+)/.exec(img.src || '');
    if (!m) return JSON.stringify({ ok: false, src: img.src.slice(0, 200) });
    let url = '';
    try { url = decodeURIComponent(m[1]); } catch (e) { url = m[1]; }
    return JSON.stringify({ ok: true, url, src: img.src.slice(0, 300) });`;
    const r = await evaluateJson(conn, `(() => { ${body} })()`);
    if (r?.ok) return r;
  }
  throw new Error('打开预览分享后没等到二维码地址（有效期约 1 小时，重开面板可刷新）');
}
