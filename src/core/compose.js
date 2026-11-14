/**
 * compose.js — 把「模板框架 + 内容方案」合成一篇推文的 HTML（在沙箱页里跑，不碰编辑器）。
 *
 * 输入：
 *   frameHtml   wx135_template clean 产出的框架（文字=【大标题】/【小标题】/【正文】槽位，
 *               实拍照片=不可见锚点）
 *   plan        {
 *                 title: ["大标题第一行", "第二行"],
 *                 subtitle: "——副标题（可空）",
 *                 lead: ["导语段落", ...],
 *                 sections: [{ heading, paragraphs:[...], images:[url | {url,w,h}] }, ...],
 *                 closing: "结尾段（可空）",
 *                 credits: { 文字来源, 图片来源 } | null,
 *                 networkEditors: "网络编辑名单",
 *                 footerStyle: "red" | "blue" | null
 *               }
 *   footerHtml  固定尾部 HTML（含 {{NETWORK_EDITORS}} 占位）
 *
 * 输出：合成后的整篇 HTML + 统计 + 调试信息。**不写编辑器**——写回走 wx135_write。
 *
 * 排版规则（v0.2）：
 *   - 正文 14px / 行距 1.75 / 字距 2px / 首行缩进 2em
 *   - 图片：宽高比 ≥1.5（全景/合照）全宽大图；其余两两一行；落单的最后一张 92% 宽
 *   - 模板分节不够时克隆最后一节整段；多了整段删除
 *   - 标题/小标题槽位可能在同一块里有多个（模板重复文本），整块一起填
 */
import { evaluateJson } from './cdp.js';

/** 合成用的页面 JS（在已加载 frameHtml 的沙箱页里执行）。 */
const FILL_BODY = String.raw`
(async () => {
  const plan = __PLAN__;
  const footerHtml = __FOOTER__;
  const box = document.getElementById('wx135-sandbox');
  if (!box) return JSON.stringify({ ok: false, error: 'sandbox not found' });

  // 0) 文章根：section.article135 或第一个元素；只有单子节点 SECTION 时才往下剥
  let root = box.querySelector('section.article135') || box.firstElementChild;
  if (!root) return JSON.stringify({ ok: false, error: 'frame root not found' });
  for (let d = 0; d < 6; d += 1) {
    const kids = [...root.children];
    if (kids.length === 1 && kids[0].tagName === 'SECTION' && root.tagName === 'SECTION' && !(root.textContent || '').trim()) root = kids[0];
    else break;
  }

  const stats = { addedSections: 0, removedSections: 0, paragraphsAdded: 0, imagesPlaced: 0, anchorsUsed: 0 };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** 当前根的直接子块。 */
  const getBlocks = () => [...root.children];
  const blockIndexOf = (el, blocks) => {
    let n = el;
    let guard = 0;
    while (n && n.parentElement !== root && guard < 80) { n = n.parentElement; guard += 1; }
    return n ? blocks.indexOf(n) : -1;
  };

  /** 收集外层槽位（嵌套的重复槽位只取最外层）。 */
  const collectSlots = () => {
    const blocks = getBlocks();
    const all = [...root.querySelectorAll('[data-wx135-slot]')]
      .filter((el) => el.getAttribute('data-wx135-slot') !== 'photo');
    const nested = new Set();
    for (const el of all) {
      let p = el.parentElement;
      while (p && p !== root) {
        if (p.hasAttribute && p.hasAttribute('data-wx135-slot')) { nested.add(el); break; }
        p = p.parentElement;
      }
    }
    return all
      .filter((el) => !nested.has(el))
      .map((el) => ({ el, role: el.getAttribute('data-wx135-slot'), block: blockIndexOf(el, blocks) }))
      .filter((s) => s.block >= 0);
  };

  let blocks = getBlocks();
  let slots = collectSlots();
  const titles = () => slots.filter((s) => s.role === 'title');
  const subs = () => slots.filter((s) => s.role === 'subtitle');
  const texts = () => slots.filter((s) => s.role === 'text');

  // 1) 头部分界：小标题块在第一个正文块之前的 = 内文副标题；之后的 = 分节标题
  const uniqBlocks = (list) => [...new Set(list.map((s) => s.block))].sort((a, b) => a - b);
  const firstTextBlock = texts().length ? Math.min(...uniqBlocks(texts())) : blocks.length;
  const subBlocks = uniqBlocks(subs());
  const sectionHeadBlocks = subBlocks.filter((b) => b >= firstTextBlock);
  const headerSubBlocks = subBlocks.filter((b) => b < firstTextBlock);
  const firstSectionBlock = sectionHeadBlocks.length ? Math.min(...sectionHeadBlocks) : blocks.length;
  const headerEnd = firstSectionBlock; // 头部区域 = [0, headerEnd)
  const tplSectionCount = sectionHeadBlocks.length;
  const planSections = plan.sections || [];
  const planCount = planSections.length;
  const debug = { headerEnd, headerSubBlocks: headerSubBlocks.length, tplSectionCount, planCount, blocks: blocks.length };

  // 2) 分节区域 [start, end]
  const rangesOf = (headBlocks) => headBlocks.map((b, i) => ({
    start: b,
    end: i + 1 < headBlocks.length ? headBlocks[i + 1] - 1 : blocks.length - 1,
  }));

  let ranges = rangesOf(sectionHeadBlocks);

  // 3) 分节数量对齐：多了整段删，少了克隆最后一节
  if (planCount < tplSectionCount && planCount >= 0) {
    for (let i = tplSectionCount - 1; i >= planCount; i -= 1) {
      const r = ranges[i];
      if (!r) continue;
      blocks.slice(r.start, r.end + 1).forEach((b) => b.remove());
      stats.removedSections += 1;
    }
    blocks = getBlocks();
    slots = collectSlots();
    const nb = [...new Set(slots.filter((s) => s.role === 'subtitle').map((s) => s.block))].sort((a, b) => a - b);
    ranges = rangesOf(nb);
  } else if (planCount > tplSectionCount && tplSectionCount > 0) {
    const last = ranges[ranges.length - 1];
    const proto = blocks.slice(last.start, last.end + 1);
    for (let i = tplSectionCount; i < planCount; i += 1) {
      for (const b of proto) root.appendChild(b.cloneNode(true));
      stats.addedSections += 1;
    }
    blocks = getBlocks();
    slots = collectSlots();
    const nb = [...new Set(slots.filter((s) => s.role === 'subtitle').map((s) => s.block))].sort((a, b) => a - b);
    ranges = rangesOf(nb);
  }

  // 4) 重新按区域归类槽位
  const inRange = (block, r) => r && block >= r.start && block <= r.end;
  const headerRegion = { start: 0, end: Math.max(0, headerEnd - 1) };
  const titleSlots = slots.filter((s) => s.role === 'title');
  const headerSubSlots = slots.filter((s) => s.role === 'subtitle' && inRange(s.block, headerRegion));
  const leadSlots = slots.filter((s) => s.role === 'text' && inRange(s.block, headerRegion));
  const sectionSlots = ranges.map((r) => ({
    heading: slots.filter((s) => s.role === 'subtitle' && inRange(s.block, r)),
    text: slots.filter((s) => s.role === 'text' && inRange(s.block, r)),
  }));

  // 5) 文字工具
  const setText = (slot, text) => { if (slot && slot.el) slot.el.textContent = text == null ? '' : String(text); };
  const styleParagraph = (el) => {
    if (!el) return;
    el.style.fontSize = '14px';
    el.style.lineHeight = '1.75';
    el.style.letterSpacing = '2px';
    el.style.textIndent = '2em';
    el.style.color = '#333333';
    el.style.textAlign = 'justify';
    const p = el.tagName === 'P' ? el : el.closest('p');
    if (p && p !== el) {
      p.style.fontSize = '14px';
      p.style.lineHeight = '1.75';
      p.style.letterSpacing = '2px';
      p.style.textIndent = '2em';
      p.style.textAlign = 'justify';
    }
  };
  const insertParagraphAfter = (anchorEl, text) => {
    if (!anchorEl) return null;
    const p = anchorEl.tagName === 'P' ? anchorEl : (anchorEl.closest('p') || anchorEl);
    const proto = p.cloneNode(true);
    proto.querySelectorAll('[data-wx135-slot]').forEach((e) => e.removeAttribute('data-wx135-slot'));
    const holder = [...proto.querySelectorAll('span,p,strong')].find((h) => (h.textContent || '').trim()) || proto;
    holder.textContent = text;
    styleParagraph(holder);
    styleParagraph(proto);
    p.parentNode.insertBefore(proto, p.nextSibling);
    stats.paragraphsAdded += 1;
    return proto;
  };

  // 6) 图片工具
  const urlOf = (x) => (typeof x === 'string' ? x : (x && x.url) || '');
  const givenMeta = {};
  for (const sec of planSections) {
    for (const x of sec.images || []) {
      if (x && typeof x === 'object' && x.url && x.w && x.h) givenMeta[x.url] = { w: x.w, h: x.h };
    }
  }
  const imgMeta = { ...givenMeta };
  await Promise.all((plan.allImages || []).map((url) => new Promise((resolve) => {
    if (imgMeta[url]) return resolve();
    const im = new Image();
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { imgMeta[url] = imgMeta[url] || { w: 0, h: 0 }; done(); }, 6000);
    im.onload = () => { imgMeta[url] = { w: im.naturalWidth, h: im.naturalHeight }; done(); };
    im.onerror = () => { imgMeta[url] = { w: 0, h: 0 }; done(); };
    im.src = url;
  })));
  const imgTag = (url, widthStyle) => '<img src="' + esc(url) + '" style="display:block;width:' + widthStyle + ';border-radius:6px;margin:0 auto;" />';
  const buildPhotoHtml = (urls) => {
    if (!urls || !urls.length) return '';
    const wide = [];
    const rest = [];
    for (const u of urls) {
      const m = imgMeta[u] || { w: 0, h: 0 };
      const ratio = m.w && m.h ? m.w / m.h : 1;
      if (ratio >= 1.5) wide.push(u); else rest.push(u);
    }
    const parts = [];
    for (const u of wide) parts.push('<section style="margin:12px 0;text-align:center;">' + imgTag(u, '100%') + '</section>');
    for (let i = 0; i < rest.length; i += 2) {
      const pair = rest.slice(i, i + 2);
      if (pair.length === 2) {
        const cells = pair.map((u) => '<section style="flex:1 1 0;min-width:0;">' + imgTag(u, '100%') + '</section>').join('');
        parts.push('<section style="display:flex;gap:8px;align-items:flex-start;margin:12px 0;">' + cells + '</section>');
      } else {
        parts.push('<section style="margin:12px 0;text-align:center;">' + imgTag(pair[0], '92%') + '</section>');
      }
    }
    return parts.join('');
  };

  // 7) 头部：标题 / 内文副标题 / 导语
  const planTitles = plan.title || [];
  titleSlots.forEach((slot, i) => setText(slot, planTitles[i] || ''));
  if (headerSubSlots.length) {
    headerSubSlots.forEach((slot, i) => setText(slot, i === 0 ? (plan.subtitle || '') : ''));
  }
  const planLead = plan.lead || [];
  leadSlots.forEach((slot, i) => {
    if (i < planLead.length) { setText(slot, planLead[i]); styleParagraph(slot.el); }
    else setText(slot, '');
  });
  // 导语多出来的段落：接在最后一个导语槽位后面
  if (planLead.length > leadSlots.length && leadSlots.length) {
    let cursor = leadSlots[leadSlots.length - 1].el;
    for (let i = leadSlots.length; i < planLead.length; i += 1) {
      const created = insertParagraphAfter(cursor, planLead[i]);
      if (created) cursor = created;
    }
  }

  // 8) 每一节
  const anyTextSlot = slots.find((s) => s.role === 'text') || leadSlots[0] || null;
  const protoParagraph = () => {
    if (!anyTextSlot) return null;
    const el = anyTextSlot.el;
    return el.tagName === 'P' ? el : (el.closest('p') || el);
  };
  const createParagraphsAfter = (anchorEl, texts) => {
    const proto = protoParagraph();
    if (!proto || !anchorEl) return [];
    const made = [];
    let cursor = anchorEl;
    for (const text of texts) {
      const clone = proto.cloneNode(true);
      clone.querySelectorAll('[data-wx135-slot]').forEach((e) => e.removeAttribute('data-wx135-slot'));
      const holder = [...clone.querySelectorAll('p,span,strong')].find((h) => (h.textContent || '').trim()) || clone;
      holder.textContent = text;
      styleParagraph(holder);
      styleParagraph(clone);
      cursor.parentNode.insertBefore(clone, cursor.nextSibling);
      cursor = clone;
      made.push(clone);
      stats.paragraphsAdded += 1;
    }
    return made;
  };

  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    const sec = planSections[i];
    const slotInfo = sectionSlots[i] || { heading: [], text: [] };
    if (!sec) continue;
    // 标题：同一块里模板可能把文字拆成多个槽位，只填第一个，其余清空（避免重复显示）
    slotInfo.heading.forEach((slot, k) => setText(slot, k === 0 ? sec.heading || '' : ''));
    // 段落
    const paras = sec.paragraphs || [];
    if (slotInfo.text.length) {
      slotInfo.text.forEach((slot, k) => {
        if (k < paras.length) { setText(slot, paras[k]); styleParagraph(slot.el); }
        else setText(slot, '');
      });
      if (paras.length > slotInfo.text.length) {
        createParagraphsAfter(slotInfo.text[slotInfo.text.length - 1].el, paras.slice(slotInfo.text.length));
      }
    } else if (paras.length) {
      // 这一块模板里没有正文槽位：在标题块后面新建段落
      const anchor = slotInfo.heading[0] ? slotInfo.heading[0].el : blocks[range.start];
      createParagraphsAfter(anchor, paras);
    }
    // 图片：本节范围内的锚点优先
    const urls = (sec.images || []).map(urlOf).filter(Boolean);
    if (urls.length) {
      const anchors = [...root.querySelectorAll('[data-wx135-photo]')].filter((a) => {
        const b = blockIndexOf(a, getBlocks());
        return b >= range.start && b <= range.end;
      });
      if (anchors.length) {
        anchors[0].insertAdjacentHTML('afterend', buildPhotoHtml(urls));
        anchors.forEach((a) => a.remove());
        stats.anchorsUsed += 1;
      } else {
        const lastText = slotInfo.text[slotInfo.text.length - 1];
        const anchorEl = lastText ? lastText.el : (slotInfo.heading[0] && slotInfo.heading[0].el);
        if (anchorEl) anchorEl.insertAdjacentHTML('afterend', buildPhotoHtml(urls));
        else blocks[range.start].insertAdjacentHTML('afterend', buildPhotoHtml(urls));
      }
      stats.imagesPlaced += urls.length;
    }
  }

  // 9) 结语 + 来源 + 固定尾部：结语插在最后一节末尾（不是最后一个槽位）
  if (plan.closing) {
    const lastRange = ranges[ranges.length - 1];
    const lastBlock = lastRange ? getBlocks()[lastRange.end] : null;
    if (lastBlock) createParagraphsAfter(lastBlock, [plan.closing]);
    else {
      const lastTextSlot = [...slots].reverse().find((s) => s.role === 'text' && s.el.isConnected);
      if (lastTextSlot) createParagraphsAfter(lastTextSlot.el, [plan.closing]);
    }
  }
  const creditsHtml = (plan.credits && (plan.credits['文字来源'] || plan.credits['图片来源']))
    ? '<section style="margin:18px 4px 6px;text-align:right;font-size:13px;line-height:1.8;color:#8a8a8a;letter-spacing:1px;">'
      + (plan.credits['文字来源'] ? '<p style="margin:0;">文字来源：' + esc(plan.credits['文字来源']) + '</p>' : '')
      + (plan.credits['图片来源'] ? '<p style="margin:0;">图片来源：' + esc(plan.credits['图片来源']) + '</p>' : '')
      + '</section>'
    : '';
  const footer = String(footerHtml || '').replace(/\{\{NETWORK_EDITORS\}\}/g, esc(plan.networkEditors || ''));
  root.insertAdjacentHTML('beforeend', creditsHtml + footer);

  // 10) 统计
  const out = root.outerHTML;
  const open = (out.match(/<section\b/gi) || []).length;
  const close = (out.match(/<\/section>/gi) || []).length;
  return JSON.stringify({
    ok: true,
    html: out,
    stats: {
      ...stats,
      sections: [open, close],
      balanced: open === close,
      htmlLen: out.length,
      images: root.querySelectorAll('img').length,
      textLen: (root.innerText || '').trim().length,
    },
    debug: { ...debug, slotCount: slots.length, titleSlots: titleSlots.length, headerSubSlots: headerSubSlots.length, leadSlots: leadSlots.length, sections: ranges.length,
      ranges: ranges.map((r) => [r.start, r.end]),
      perSection: sectionSlots.map((s) => ({ heading: s.heading.length, text: s.text.length })) },
  });
})()
`;

/**
 * 在沙箱页里把模板框架和内容方案合成。
 * 调用前：沙箱页必须已经 loadSandboxHtml(frameHtml)。
 */
export async function composeInSandbox(conn, { frameHtml, plan, footerHtml = '' } = {}) {
  if (!plan) throw new Error('plan is required');
  const allImages = [];
  for (const sec of plan.sections || []) {
    for (const x of sec.images || []) {
      const url = typeof x === 'string' ? x : (x && x.url) || '';
      if (url) allImages.push(url);
    }
  }
  const planWithImages = { ...plan, allImages };
  const expression = FILL_BODY
    .replace('__PLAN__', () => JSON.stringify(planWithImages))
    .replace('__FOOTER__', () => JSON.stringify(footerHtml));
  return evaluateJson(conn, expression, { timeoutMs: 120000 });
}
