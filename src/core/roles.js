/**
 * roles.js — 模板文字槽位的「语义判定」。
 *
 * 为什么要有这一层：
 *   旧版 clean 只按字号打标签（≥22 大标题 / ≥17 小标题 / 其余正文），于是——
 *     - 16px 的分节标题全变成「正文」→ clean 报「小标题 0」→ compose 找不到分节，整套模板用不了；
 *     - 模板自带的装饰标语（如「蓄力启航，奔赴新章」，三节各一句）也被当成正文，
 *       一旦按段落顺序填内容，就会把业务文案塞进荧光笔高亮条里，视觉非常违和。
 *
 * 现在的判定是「多因子 + 结构」：
 *   1) 形状：字号/字重/对齐/是否坐在彩色底上（高亮条、色块）；
 *   2) 语义：纯英文/编号 → label（编号/英文副标）；
 *   3) 统计：同一句话在模板里出现 ≥2 次 → decor（装饰标语，不参与内容填充）；
 *   4) 结构：同一顶层块里出现 ≥2 个 subtitle → 它们是小标题(subhead)，不是分节标题。
 *
 * 设计约束：classifyEntries / applyStructuralRoles / summarizeRoles 会被 `toString()`
 * 注入浏览器沙箱执行，所以**必须是自包含函数**（不引用模块级常量、不调用彼此以外的东西）。
 */

/** 规则版本：判定逻辑变了就 +1，产物里的 roleRulesVersion 便于追溯。 */
export const ROLE_RULES_VERSION = 2;

/** 角色 → 中文名（给 agent / 报告用）。 */
export const ROLE_LABELS = {
  title: '大标题',
  subtitle: '分节标题',
  subhead: '小标题',
  label: '编号/英文副标',
  decor: '装饰文字',
  text: '正文',
};

/** 角色 → clean 时写入的占位符（decor 默认置空，避免高亮条里出现【正文】）。 */
export const SLOT_PLACEHOLDERS = {
  title: '【大标题】',
  subtitle: '【小标题】',
  subhead: '【小标题】',
  label: '【编号】',
  decor: '',
  text: '【正文】',
};

/** clean 时装饰文字的处置方式。 */
export const DECOR_POLICIES = ['empty', 'keep', 'remove'];

/**
 * 文字槽位分类器（纯函数，可离线单测）。
 *
 * @param {Array<{
 *   id: number|string, text: string, fontSize?: number, fontWeight?: number|string,
 *   textAlign?: string, hasBgHighlight?: boolean, blockIndex?: number, orderInBlock?: number
 * }>} entries
 * @returns {Array<{ id: number|string, role: string, reason: string }>}
 */
export function classifyEntries(entries) {
  const norm = (t) => String(t || '')
    .replace(/[\s\u3000·,，。、;；:：\-—_~～|｜/\\()（）【】\[\]"'“”‘’!！?？.]+/g, '');
  const counts = new Map();
  for (const e of entries || []) {
    const k = norm(e && e.text);
    if (k && k.length <= 40) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [];
  for (const e of entries || []) {
    const t = String((e && e.text) || '').trim();
    const len = [...t].length;
    const fs = Number(e && e.fontSize) || 14;
    const fwRaw = e && e.fontWeight;
    const fw = fwRaw === 'bold' ? 700 : Number(fwRaw) || 400;
    const bold = fw >= 600;
    const align = String((e && e.textAlign) || '').toLowerCase();
    const k = norm(t);
    const repeat = k ? counts.get(k) || 0 : 0;
    const englishOnly = /^[A-Za-z0-9\s&.\-—·:!?'"()/|+]+$/.test(t) && /[A-Za-z]/.test(t);
    const numberish = /^(壹|贰|叁|肆|伍|陆|柒|捌|玖|拾|一|二|三|四|五|六|七|八|九|十)$/.test(t)
      || /^\d{1,2}[.、]?$/.test(t)
      || /^(PART|PART\.|NO\.?|P)\s*\d+/i.test(t);
    let role;
    let reason;
    if (englishOnly) { role = 'label'; reason = 'english'; }
    else if (numberish) { role = 'label'; reason = 'number'; }
    else if (repeat >= 2 && len <= 24) { role = 'decor'; reason = 'repeat'; }
    else if (fs >= 22) { role = 'title'; reason = 'big'; }
    else if (bold && fs >= 15 && len <= 30) { role = 'subtitle'; reason = 'bold-short'; }
    else if (e && e.hasBgHighlight && len <= 20) { role = 'decor'; reason = 'highlight'; }
    else if (align === 'center' && fs >= 14 && len <= 24 && !/[。！？；]$/.test(t)) { role = 'subtitle'; reason = 'centered-short'; }
    else { role = 'text'; reason = 'body'; }
    out.push({ id: e && e.id, role, reason });
  }
  return out;
}

/**
 * 结构修正：同一顶层块里 ≥2 个 subtitle → 降级为 subhead（小标题/条目标题）。
 * 分节标题在每个块里通常只有一个；同一块里成排出现的加粗短句是条目名。
 *
 * @param {Array<{blockIndex?: number}>} entries
 * @param {Array<{id:number|string, role:string, reason:string}>} classified
 */
export function applyStructuralRoles(entries, classified) {
  const byId = new Map();
  for (const e of entries || []) byId.set(e && e.id, e);
  const perBlock = new Map();
  for (const c of classified || []) {
    const e = byId.get(c.id) || {};
    if (c.role !== 'subtitle') continue;
    const b = Number(e.blockIndex);
    if (!Number.isFinite(b) || b < 0) continue;
    perBlock.set(b, (perBlock.get(b) || 0) + 1);
  }
  return (classified || []).map((c) => {
    if (c.role !== 'subtitle') return c;
    const e = byId.get(c.id) || {};
    const b = Number(e.blockIndex);
    if (Number.isFinite(b) && (perBlock.get(b) || 0) >= 2) {
      return { ...c, role: 'subhead', reason: c.reason + '+same-block-many' };
    }
    return c;
  });
}

/** 统计各角色数量（供报告/断言用）。 */
export function summarizeRoles(classified) {
  const stats = { title: 0, subtitle: 0, subhead: 0, label: 0, decor: 0, text: 0 };
  for (const c of classified || []) {
    if (Object.prototype.hasOwnProperty.call(stats, c.role)) stats[c.role] += 1;
  }
  return stats;
}

/**
 * 浏览器端：采集「文字叶子 + 判定所需特征」的表达式模板。
 * 用法：COLLECT_ENTRIES_EXPR
 *   .replace('__ROOT__', '你的根元素表达式')
 *   .replace('__MARK__', 'false')   // true 时给元素打 data-wx135-e 标记（clean 用，方便回填）
 * 返回 JSON: [{ id, text, tag, fontSize, fontWeight, color, textAlign, hasBgHighlight,
 *              blockIndex, orderInBlock }]
 */
export const COLLECT_ENTRIES_EXPR = String.raw`(() => {
  const root = __ROOT__;
  if (!root) return JSON.stringify({ ok: false, error: 'root not found' });
  const mark = __MARK__;

  // 顶层块：先剥掉"只有一个 section 子元素"的包装层（和 analyze 的剥壳逻辑一致）
  let topNode = root;
  for (let d = 0; d < 10; d += 1) {
    const kids = [...(topNode.children || [])];
    if (kids.length === 1 && /^section$/i.test(kids[0].tagName || '')) topNode = kids[0];
    else break;
  }
  const topBlocks = [...(topNode.children || [])];
  const blockOf = (el) => {
    let n = el;
    for (let d = 0; d < 80; d += 1) {
      if (!n || !n.parentElement) return -1;
      if (n.parentElement === topNode) break;
      n = n.parentElement;
    }
    return topBlocks.indexOf(n);
  };

  // 是否坐在"有底色"的容器里（高亮条 / 色块）。白底、浅到接近白的页面底色不算。
  const bgInfo = (el) => {
    let n = el;
    for (let d = 0; d < 14 && n && n !== document.body; d += 1) {
      const cs = getComputedStyle(n);
      const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(cs.backgroundColor || '');
      if (m) {
        const a = m[4] === undefined ? 1 : Number(m[4]);
        const r = Number(m[1]); const g = Number(m[2]); const b = Number(m[3]);
        if (a > 0.3) {
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
          const sat = mx ? (mx - mn) / mx : 0;
          if (lum < 0.9 || sat > 0.5) return true;
        }
      }
      n = n.parentElement;
    }
    return false;
  };

  const entries = [];
  const orderInBlock = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const t = (node.textContent || '').trim();
    if (!t) continue;
    const el = node.parentElement;
    if (!el) continue;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'style' || tag === 'script') continue;
    if (el.closest && el.closest('[data-wx135-slot="photo"]')) continue;
    if (seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const b = blockOf(el);
    const ord = (orderInBlock.get(b) || 0) + 1;
    orderInBlock.set(b, ord);
    if (mark) el.setAttribute('data-wx135-e', String(entries.length));
    entries.push({
      id: entries.length,
      text: t,
      tag,
      fontSize: parseFloat(cs.fontSize) || 0,
      fontWeight: cs.fontWeight === 'bold' ? 700 : (parseInt(cs.fontWeight, 10) || 400),
      color: cs.color || '',
      textAlign: cs.textAlign || '',
      hasBgHighlight: bgInfo(el),
      blockIndex: b,
      orderInBlock: ord,
    });
    if (entries.length >= 400) break;
  }
  return JSON.stringify({ ok: true, count: entries.length, entries });
})()`;

/** 把纯函数拼进浏览器执行串的前置声明（toString 注入，避免打包依赖）。 */
export function classifierPrelude() {
  return [
    classifyEntries.toString(),
    applyStructuralRoles.toString(),
  ].join('\n');
}
