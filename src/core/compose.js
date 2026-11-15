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
 *                 sections: [{
 *                   heading: "启动仪式",            // 分节标题
 *                   label: "PART.01",               // 可选：模板有"编号"槽位时填进去
 *                   paragraphs: ["…"],
 *                   items: ["条目 1", "条目 2"],     // 可选：编号列表（通知/须知类）
 *                   subsections: [{ heading: "离校前", items: ["…"] }],  // 可选：二级标题（复用模板标题样式）+ 条目
 *                   images: ["url" | { url }]
 *                 }],
 *                 closing: "结尾段（可空）",
 *                 credits: { 文字来源, 图片来源 } | null,
 *                 networkEditors: "网络编辑名单",
 *                 footerStyle: "red" | "blue" | null
 *               }
 *   footerHtml  固定尾部 HTML（含 {{NETWORK_EDITORS}} 占位）
 *
 * 输出：合成后的整篇 HTML + 统计 + 调试信息。**不写编辑器**——写回走 wx135_write。
 *
 * 排版规则（v0.3.1）：
 *   - 正文 14px / 行距 1.75 / 字距 2px / 首行缩进 2em
 *   - 图片：宽高比 ≥1.5（全景/合照）全宽大图；3 张竖图一行三张；其余两两一行；落单 92%
 *   - 二级标题：复用模板自带的分节标题样式（同字体/颜色/字重，字号约 0.78 倍，无缩进）
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
  /** 正文颜色：默认按背景自动选黑/白；plan.textColor 或 section.textColor 可强制指定（模板用绝对定位背景层时自动判断会失效）。 */
  let forcedColor = plan.textColor || null;
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
  /**
   * 正文字色：默认 #333；但如果所在容器是深色底（比如模板的深蓝卡片），
   * 再写黑字就看不见了 —— 往上找第一个有背景色的祖先，按亮度决定用白字。
   */
  const textColor = (el) => {
    let n = el;
    let depth = 0;
    while (n && n !== document.body && depth < 25) {
      const bg = getComputedStyle(n).backgroundColor || '';
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(bg);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
        const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
        if (lum < 0.55) return '#ffffff';
        return '#333333';
      }
      n = n.parentElement;
      depth += 1;
    }
    return '#333333';
  };
  const applyParaStyle = (el, color) => {
    el.style.fontSize = '14px';
    el.style.lineHeight = '1.75';
    el.style.letterSpacing = '2px';
    el.style.textIndent = '2em';
    el.style.color = color;
    el.style.textAlign = 'justify';
  };
  const styleParagraph = (el) => {
    if (!el) return;
    const color = forcedColor || textColor(el);
    applyParaStyle(el, color);
    const p = el.tagName === 'P' ? el : el.closest('p');
    if (p && p !== el) applyParaStyle(p, color);
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
  // 图片宽高：优先用 plan 里给的（本地图片上传时已带 w/h），没给的就按方图处理。
  // **不要在同一段 evaluate 里 await 图片加载**：沙箱可能是后台标签页，定时器被节流，
  // 图片请求再一卡，整个 evaluate 会挂到超时。排版不依赖浏览器加载，交给调用方给尺寸。
  const imgMeta = { ...givenMeta };
  const imgTag = (url, widthStyle) => '<img src="' + esc(url) + '" style="display:block;width:' + widthStyle + ';border-radius:6px;margin:0 auto;" />';
  /** 单张图。 */
  const onePhoto = (url, width) => '<section style="margin:12px 0;text-align:center;">' + imgTag(url, width) + '</section>';
  /** 一行并排多图。 */
  const photoRowHtml = (urls, gap = 8) => {
    const cells = urls.map((url) => '<section style="flex:1 1 0;min-width:0;">' + imgTag(url, '100%') + '</section>').join('');
    return '<section style="display:flex;gap:' + gap + 'px;align-items:flex-start;margin:12px 0;">' + cells + '</section>';
  };
  /**
   * 图片排版规则（来自范文 4–6 的观察）：
   *  - 宽高比 ≥1.5（合影/全景/横版照片）→ 单张全宽大图
   *  - 3 张竖图/方图 → 一行三张（小图并排）
   *  - 其余两两一行；落单的最后一张 92% 宽
   * @param {string[]} urls
   */
  const buildPhotoHtml = (urls) => {
    if (!urls || !urls.length) return '';
    const wide = [];
    const rest = [];
    for (const url of urls) {
      const m = imgMeta[url] || { w: 0, h: 0 };
      const ratio = m.w && m.h ? m.w / m.h : 1;
      if (ratio >= 1.5) wide.push(url); else rest.push(url);
    }
    const parts = [];
    for (const url of wide) parts.push(onePhoto(url, '100%'));
    const allPortraitish = rest.length && rest.every((url) => {
      const m = imgMeta[url] || { w: 0, h: 0 };
      return m.w && m.h ? m.w / m.h < 1.15 : true;
    });
    if (rest.length === 3 && allPortraitish) {
      parts.push(photoRowHtml(rest, 6));
    } else {
      for (let i = 0; i < rest.length; i += 2) {
        const pair = rest.slice(i, i + 2);
        if (pair.length === 2) parts.push(photoRowHtml(pair));
        else parts.push(onePhoto(pair[0], '92%'));
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
  /** 列表项/小标题的段落样式（通知类文章大量用：一、二、三 小节 + 1./2./3. 条目）。 */
  const stylePlain = (el, { bold = false } = {}) => {
    if (!el) return;
    const color = forcedColor || textColor(el);
    for (const target of [el, ...el.querySelectorAll('p,span,strong')]) {
      target.style.fontSize = '14px';
      target.style.lineHeight = '1.75';
      target.style.letterSpacing = '2px';
      target.style.color = color;
      target.style.textIndent = '0';
      target.style.textAlign = 'left';
      target.style.margin = '0 0 2px';
      if (bold) target.style.fontWeight = '600';
      else if (target.style.fontWeight === '600') target.style.fontWeight = '400';
    }
  };
  /** 自动编号：原文已经带 "1." / "（1）" / "•" 的就不重复加。 */
  const numberItem = (text, index) => {
    const raw = String(text == null ? '' : text).trim();
    if (/^(\d+[.、)）]|（\d+）|[一二三四五六七八九十]+[、.]|[-•·])/.test(raw)) return raw;
    return (index + 1) + '. ' + raw;
  };
  /**
   * 在 anchorEl 后插入若干段落。applyStyle(clone, holder) 决定每段怎么套样式：
   *  - 正文：沿用模板段落样式（14px/1.75/2px/首行缩进）
   *  - 条目：编号左对齐、无缩进
   *  - 二级标题：**复用模板自带的分节标题样式**（同字体/颜色/字重，字号约 0.78 倍，无缩进）
   */
  const createParagraphsAfter = (anchorEl, texts, applyStyle = null) => {
    const proto = protoParagraph();
    if (!proto || !anchorEl) return [];
    const made = [];
    let cursor = anchorEl;
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      const clone = proto.cloneNode(true);
      clone.querySelectorAll('[data-wx135-slot]').forEach((e) => e.removeAttribute('data-wx135-slot'));
      const holder = [...clone.querySelectorAll('p,span,strong')].find((h) => (h.textContent || '').trim()) || clone;
      holder.textContent = text;
      if (typeof applyStyle === 'function') {
        applyStyle(clone, holder);
      } else {
        styleParagraph(holder);
        styleParagraph(clone);
      }
      cursor.parentNode.insertBefore(clone, cursor.nextSibling);
      cursor = clone;
      made.push(clone);
      stats.paragraphsAdded += 1;
    }
    return made;
  };
  /** 条目样式（编号列表）。 */
  const applyListItem = (clone, holder) => {
    stylePlain(holder);
    stylePlain(clone);
  };

  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    const sec = planSections[i];
    const slotInfo = sectionSlots[i] || { heading: [], text: [] };
    forcedColor = (sec && sec.textColor) || plan.textColor || null;
    if (!sec) continue;
    // 先记录模板分节标题的样式（二级标题要"复用模板自带样式"就从这里派生）
    const headingEl = slotInfo.heading[0] ? slotInfo.heading[0].el : null;
    let headingStyle = null;
    if (headingEl) {
      const cs = getComputedStyle(headingEl);
      headingStyle = {
        fontSize: parseFloat(cs.fontSize) || 18,
        color: cs.color,
        fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
      };
    }
    const applySubhead = (clone, holder) => {
      const size = headingStyle ? Math.max(14, Math.round(headingStyle.fontSize * 0.78)) : 15;
      for (const target of [holder, clone]) {
        target.style.fontSize = size + 'px';
        target.style.lineHeight = '1.75';
        target.style.letterSpacing = headingStyle && headingStyle.letterSpacing !== 'normal' ? headingStyle.letterSpacing : '2px';
        target.style.color = forcedColor || (headingStyle ? headingStyle.color : textColor(target));
        target.style.fontWeight = headingStyle ? headingStyle.fontWeight : '600';
        target.style.textIndent = '0';
        target.style.textAlign = headingStyle ? headingStyle.textAlign : 'left';
        target.style.margin = '10px 0 4px';
      }
    };
    // 标题：模板可能把"编号 + 标题"拆成两个槽位（PART.01 / 启动仪式），也可能只是重复文本
    slotInfo.heading.forEach((slot, k) => {
      if (k === 0) setText(slot, sec.heading || '');
      else if (k === 1) {
        setText(slot, sec.label || '');
        if (sec.label && slot.el) {
          // 编号/栏目名比标题小一号，避免和主标题抢视觉
          slot.el.style.fontSize = '60%';
          slot.el.style.fontWeight = '400';
          slot.el.style.letterSpacing = '2px';
          slot.el.style.opacity = '0.82';
        }
      } else setText(slot, '');
    });
    let cursor = slotInfo.heading[0] ? slotInfo.heading[0].el : (blocks[range.start] || null);
    // 段落
    const paras = sec.paragraphs || [];
    if (slotInfo.text.length) {
      slotInfo.text.forEach((slot, k) => {
        if (k < paras.length) { setText(slot, paras[k]); styleParagraph(slot.el); cursor = slot.el; }
        else setText(slot, '');
      });
      if (paras.length > slotInfo.text.length) {
        const made = createParagraphsAfter(slotInfo.text[slotInfo.text.length - 1].el, paras.slice(slotInfo.text.length));
        if (made.length) cursor = made[made.length - 1];
      }
    } else if (paras.length) {
      // 这一块模板里没有正文槽位：在标题块后面新建段落
      const made = createParagraphsAfter(cursor, paras);
      if (made.length) cursor = made[made.length - 1];
    }
    // 条目（通知/须知类文章大量用：1. 2. 3.）
    if (Array.isArray(sec.items) && sec.items.length && cursor) {
      const made = createParagraphsAfter(cursor, sec.items.map(numberItem), applyListItem);
      if (made.length) cursor = made[made.length - 1];
    }
    // 子小节（"离校前 / 行前准备 / 途中守则" 这种）：复用模板自带的分节标题样式（缩小一号），下面跟条目
    for (const sub of sec.subsections || []) {
      if (!sub || !cursor) continue;
      if (sub.heading) {
        const made = createParagraphsAfter(cursor, [sub.heading], applySubhead);
        if (made.length) cursor = made[made.length - 1];
      }
      if (Array.isArray(sub.items) && sub.items.length) {
        const made = createParagraphsAfter(cursor, sub.items.map(numberItem), applyListItem);
        if (made.length) cursor = made[made.length - 1];
      }
    }
    // 图片：本节范围内的锚点优先
    const imgUrls = (sec.images || [])
      .map((x) => (typeof x === 'string' ? x : (x && x.url) || ''))
      .filter(Boolean);
    if (imgUrls.length) {
      const anchors = [...root.querySelectorAll('[data-wx135-photo]')].filter((a) => {
        const b = blockIndexOf(a, getBlocks());
        return b >= range.start && b <= range.end;
      });
      if (anchors.length) {
        anchors[0].insertAdjacentHTML('afterend', buildPhotoHtml(imgUrls));
        anchors.forEach((a) => a.remove());
        stats.anchorsUsed += 1;
      } else if (cursor) {
        cursor.insertAdjacentHTML('afterend', buildPhotoHtml(imgUrls));
      } else {
        blocks[range.start].insertAdjacentHTML('afterend', buildPhotoHtml(imgUrls));
      }
      stats.imagesPlaced += imgUrls.length;
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
