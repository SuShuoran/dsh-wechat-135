/**
 * template.js — 135 模板的「解析 → 清空」，在页面 DOM 里跑。
 *
 * 模板本质是一棵极深的内联样式 HTML（几百个 <section>），135 的 DIY 头图/标题条
 * 还是 `data-role="absolute-layout"` 的 SVG 布局。想"只保留框架"，必须在真实 DOM 上做：
 * 只有浏览器才知道每段文字的计算样式、每张图的实际渲染尺寸。
 *
 * 两个动作：
 *   analyzeTemplate —— 给出一份「解剖报告」：块结构、文字叶子（字号/颜色/行距）、
 *                      图片清单（含"装饰 vs 实拍"的初判），供 agent 决定怎么清、怎么填。
 *   cleanTemplate   —— 按图片索引清掉实拍图（换成占位块），文字清空或换成槽位占位符，
 *                      返回清空后的 HTML 与统计。**不改编辑器，调用方自己决定要不要写回。**
 *
 * 图片分类只在页面里做初判（域名/尺寸/格式），最终由 agent 看缩略图确认——
 * 135 素材库里大量"装饰图"和实拍照片长得一样，纯靠 URL 猜会误删。
 */
import { evaluateJson } from './cdp.js';

/**
 * 编辑器正文根元素的表达式（不依赖别的片段，单独塞进页面就能跑）。
 * 优先 `#ueditor_1`，退而求其次选"文字最多"的可访问 iframe。
 */
export const EDITOR_ROOT_EXPR = `(() => {
  const byId = document.getElementById('ueditor_1');
  const usable = (f) => { try { const d = f && f.contentDocument; return !!(d && d.body); } catch (e) { return false; } };
  if (usable(byId)) return byId.contentDocument.body;
  let best = null;
  let bestLen = -1;
  for (const f of document.querySelectorAll('iframe')) {
    if (!usable(f)) continue;
    const n = (f.contentDocument.body.innerText || '').length;
    if (n > bestLen) { bestLen = n; best = f; }
  }
  return best ? best.contentDocument.body : null;
})()`;

/**
 * 沙箱页里文章根元素的表达式：优先 `section.article135`（135 的文章外层），
 * 退而求其次取第一个元素子节点。**不要用 #wx135-sandbox 本身**——那只是外壳 div，
 * 用它会把整篇文章当成 1 个块。
 */
export const SANDBOX_ARTICLE_ROOT = `(() => {
  const box = document.getElementById('wx135-sandbox');
  if (!box) return null;
  return box.querySelector('section.article135') || box.firstElementChild || box;
})()`;

/** 解析：`root` 是要分析的根元素表达式。 */
export async function analyzeTemplate(conn, { root = 'document.body' } = {}) {
  const body = String.raw`
  const root = __ROOT__;
  if (!root) return JSON.stringify({ ok: false, error: 'root not found' });
  const html = root.innerHTML || '';

  const classify = (im, i) => {
    const src = im.getAttribute('data-src') || im.getAttribute('src') || '';
    let host = '';
    try { host = new URL(src, location.href).host; } catch (e) { host = ''; }
    const w = im.naturalWidth || 0;
    const h = im.naturalHeight || 0;
    const r = im.getBoundingClientRect();
    const renderedW = Math.round(r.width);
    const renderedH = Math.round(r.height);
    const gif = /\.gif(\?|$)/i.test(src);
    let kind = 'unknown';
    if (host.includes('bcn.135editor.com')) kind = 'decor';
    else if (host.includes('bexp.135editor.com')) kind = 'photo';
    else if (host.includes('mmbiz.qpic.cn') || host.includes('mmecoa.qpic.cn')) kind = gif ? 'decor-maybe' : 'photo-maybe';
    // 尺寸启发：真实照片通常 ≥ 300px 长边、宽高比 1.1~2.4；小图/正方形多装饰
    const longSide = Math.max(w, h);
    const ratio = w && h ? (w / h) : 0;
    const big = longSide >= 300 && renderedW >= 120;
    const landscape = ratio >= 1.05 && ratio <= 2.8;
    const photoScore = (kind === 'photo' ? 2 : kind === 'photo-maybe' ? 1 : 0) + (big ? 1 : 0) + (landscape ? 1 : 0);
    return {
      index: i, src: src.slice(0, 300), host: host.slice(0, 60), kind,
      w, h, renderedW, renderedH, gif, big, landscape, photoScore,
      style: (im.getAttribute('style') || '').slice(0, 160),
    };
  };
  const images = [...root.querySelectorAll('img')].map(classify);

  // 顶层块：先剥掉"只有一个子元素"的包装层，否则 135 的模板永远只报 1 个块
  let topNode = root;
  for (let d = 0; d < 10; d += 1) {
    const kids = [...(topNode.children || [])];
    if (kids.length === 1 && /^section$/i.test(kids[0].tagName || '')) topNode = kids[0];
    else break;
  }
  const blocks = [];
  const direct = topNode.children || [];
  for (let i = 0; i < direct.length && i < 80; i += 1) {
    const el = direct[i];
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    blocks.push({
      index: i,
      tag: el.tagName.toLowerCase(),
      tplid: el.getAttribute('data-tplid') || '',
      dataRole: el.getAttribute('data-role') || '',
      textLen: text.length,
      text: text.slice(0, 100),
      imgs: el.querySelectorAll('img').length,
      svgCount: el.querySelectorAll('svg').length,
      sections: (el.innerHTML.match(/<section\b/gi) || []).length,
    });
  }

  const leaves = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.textContent || '').trim();
    if (!t) continue;
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'style' || tag === 'script') continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    leaves.push({
      tag,
      text: t.slice(0, 60),
      fontSize: parseFloat(cs.fontSize) || 0,
      color: cs.color,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textIndent: cs.textIndent,
      textAlign: cs.textAlign,
    });
    if (leaves.length >= 400) break;
  }

  const groups = new Map();
  for (const l of leaves) {
    const k = l.fontSize + '|' + l.color + '|' + l.fontWeight;
    const g = groups.get(k) || { key: k, count: 0, sample: l.text, lineHeight: l.lineHeight };
    g.count += 1;
    groups.set(k, g);
  }
  const profile = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 12);

  const open = (html.match(/<section\b/gi) || []).length;
  const close = (html.match(/<\/section>/gi) || []).length;
  return JSON.stringify({
    ok: true,
    stats: {
      htmlLen: html.length,
      textLen: (root.innerText || '').length,
      sections: [open, close],
      balanced: open === close,
      imgCount: images.length,
      blockCount: blocks.length,
      leafCount: leaves.length,
      svgCount: root.querySelectorAll('svg').length,
      absoluteLayouts: root.querySelectorAll('[data-role="absolute-layout"]').length,
      tplid: root.getAttribute('data-tplid') || '',
    },
    images,
    blocks,
    profile,
    leaves: leaves.slice(0, 120),
  });`;
  return evaluateJson(conn, `(() => {\n${body.replace('__ROOT__', () => root)}\n})()`);
}

/**
 * 清空：实拍图换占位块、文字清空（或换成槽位占位符），保留装饰与结构。
 * 返回 { ok, html, stats }，**不写回编辑器**。
 */
export async function cleanTemplate(conn, {
  root = 'document.body',
  photoIndices = [],
  clearText = true,
  slotPlaceholders = true,
  photoLabel = '【活动照片】',
  photoMode = 'anchor',
  trimFooter = false,
} = {}) {
  const opts = JSON.stringify({ photoIndices, clearText, slotPlaceholders, photoLabel, photoMode, trimFooter });
  const body = String.raw`
  const root = __ROOT__;
  if (!root) return JSON.stringify({ ok: false, error: 'root not found' });
  const opts = __OPTS__;
  const photoIdx = new Set(Array.isArray(opts.photoIndices) ? opts.photoIndices : []);
  const imgs = [...root.querySelectorAll('img')];

  // 1) 实拍图：anchor 模式放一个不可见的“照片插槽”（compose 时再填图）；
  //    placeholder 模式放灰色占位块（演示/人工检查框架用）
  let removedPhotos = 0;
  imgs.forEach((im, i) => {
    if (!photoIdx.has(i)) return;
    const r = im.getBoundingClientRect();
    const w = Math.max(120, Math.round(r.width) || 300);
    const h = Math.max(80, Math.round(r.height) || 200);
    let ph;
    if (opts.photoMode === 'anchor') {
      ph = document.createElement('section');
      ph.setAttribute('data-wx135-photo', String(i));
      ph.setAttribute('data-wx-w', String(w));
      ph.setAttribute('data-wx-h', String(h));
      ph.setAttribute('style', 'display:none !important;height:0;margin:0;padding:0;overflow:hidden;');
    } else {
      ph = document.createElement('section');
      ph.setAttribute('data-wx135-slot', 'photo');
      ph.setAttribute('style', 'box-sizing:border-box;width:100%;max-width:100%;min-height:' + h + 'px;margin:12px auto;background:#eef1f4;border:1px dashed #b9c2cc;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#8a94a3;font-size:12px;line-height:1.6;letter-spacing:1px;');
      ph.textContent = opts.photoLabel || '';
    }
    if (im.parentNode) im.parentNode.replaceChild(ph, im);
    removedPhotos += 1;
  });

  // 1.5) 可选：删掉模板自带的尾部（END/网络编辑/数小理/扫码关注…），后面统一插固定尾部。
  //      只处理最后 10 个顶层块，且要求文字很短，避免误删正文里的"理学院"。
  let trimmedTail = 0;
  if (opts.trimFooter) {
    let topNode = root;
    for (let d = 0; d < 8; d += 1) {
      const kids = [...topNode.children];
      if (kids.length === 1 && kids[0].tagName === 'SECTION') topNode = kids[0];
      else break;
    }
    const tailBlocks = [...topNode.children].slice(-10);
    const marker = /END|网络编辑|责任编辑|终\s*审|数小理|扫码关注|长按识别|往期推荐/;
    for (const b of tailBlocks) {
      const t = (b.textContent || '').replace(/\s+/g, '');
      if (!t) continue;
      if (t.length <= 240 && marker.test(t)) {
        b.remove();
        trimmedTail += 1;
      }
    }
  }

  // 2) 文字：清空 or 换槽位占位符
  let textCleared = 0;
  if (opts.clearText) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || '').trim();
      if (!t) continue;
      const el = node.parentElement;
      if (!el) continue;
      // 图片占位块里的「【活动照片】」不是模板文字，别被文字清理顺手改成【正文】
      if (el.closest && el.closest('[data-wx135-slot="photo"]')) continue;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'style' || tag === 'script') continue;
      if (seen.has(el)) {
        node.textContent = '';
        continue;
      }
      seen.add(el);
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize) || 14;
      if (opts.slotPlaceholders) {
        const label = fs >= 22 ? '【大标题】' : fs >= 17 ? '【小标题】' : '【正文】';
        node.textContent = label;
        el.setAttribute('data-wx135-slot', fs >= 22 ? 'title' : fs >= 17 ? 'subtitle' : 'text');
      } else {
        node.textContent = '';
      }
      textCleared += 1;
    }
  }

  const out = root.outerHTML;
  const open = (out.match(/<section\b/gi) || []).length;
  const close = (out.match(/<\/section>/gi) || []).length;
  const slots = [...root.querySelectorAll('[data-wx135-slot]')].map((el) => ({
    role: el.getAttribute('data-wx135-slot'),
    text: (el.textContent || '').trim().slice(0, 24),
  }));
  const photoAnchors = [...root.querySelectorAll('[data-wx135-photo]')].map((el) => ({
    idx: Number(el.getAttribute('data-wx135-photo') || 0),
    w: Number(el.getAttribute('data-wx-w') || 0),
    h: Number(el.getAttribute('data-wx-h') || 0),
  }));
  return JSON.stringify({
    ok: true,
    html: out,
    stats: {
      removedPhotos,
      textCleared,
      trimmedTail,
      htmlLen: out.length,
      textLen: (root.innerText || '').trim().length,
      imgs: root.querySelectorAll('img').length,
      sections: [open, close],
      balanced: open === close,
      slots: slots.length,
      photoAnchors: photoAnchors.length,
      titleSlots: slots.filter((s) => s.role === 'title').length,
      subtitleSlots: slots.filter((s) => s.role === 'subtitle').length,
      textSlots: slots.filter((s) => s.role === 'text').length,
    },
    slots,
    photoAnchors,
  });`;
  return evaluateJson(conn, `(() => {\n${body.replace('__ROOT__', () => root).replace('__OPTS__', () => opts)}\n})()`);
}

/**
 * 把一段 HTML 装进一个干净的页面里（不走 135，用于预览/演示/离线检查）。
 * 返回可执行表达式：在目标标签页里调用即可替换成新内容。
 */
export function buildSandboxHtml(templateHtml, { width = 375 } = {}) {
  const css = `
    html, body { margin: 0; padding: 0; background: #f5f6f8; }
    #wx135-sandbox {
      width: ${width}px; margin: 0 auto; background: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: 14px; line-height: 1.75; color: #333333;
      overflow-x: hidden;
    }
    #wx135-sandbox img { max-width: 100%; vertical-align: middle; }
    #wx135-sandbox p { margin: 0; padding: 0; }
    #wx135-sandbox section { box-sizing: border-box; }
  `;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="wx135-sandbox">${templateHtml}</div></body></html>`;
}
