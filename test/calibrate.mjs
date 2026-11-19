/**
 * calibrate.mjs — 用本地保存的模板 HTML 校准「槽位角色判定」，全程不碰 135 编辑器。
 *
 * 用途：改了 src/core/roles.js 的判定规则后，拿一份真实模板 HTML 跑一遍，
 * 看 title/subtitle/subhead/label/decor/text 的拆分是否符合人工预期。
 *
 * 用法：
 *   node test/calibrate.mjs <template.html>            # 人看的报告
 *   node test/calibrate.mjs <template.html> --json     # 机器可读（CI/对比用）
 *   node test/calibrate.mjs <template.html> --clean    # 顺带跑一遍 clean，看占位符与平衡
 *
 * 模板 HTML 从哪来：wx135_read save=true 的备份、或 wx135_template clean 的 frame.html。
 * 需要的浏览器：和插件共用 9333 调试实例（没起会自动拉起），只用 about:blank 沙箱标签页。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const core = (name) => import(pathToFileURL(resolve(root, 'src', 'core', `${name}.js`)).href);

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node test/calibrate.mjs <template.html> [--json] [--clean]');
  process.exit(1);
}
const asJson = args.includes('--json');
const alsoClean = args.includes('--clean');
const alsoCompose = args.includes('--compose');

const { ensureBrowser } = await core('browser');
const { listTargets, connectTarget } = await core('cdp');
const { ensureSandboxTab, loadSandboxHtml } = await core('sandbox');
const { analyzeTemplate, cleanTemplate, SANDBOX_ARTICLE_ROOT } = await core('template');
const { ROLE_LABELS } = await core('roles');

const boot = await ensureBrowser({ launch: true });
if (!boot.ok) {
  console.error('浏览器不可用：', boot.error, boot.manualCommand || '');
  process.exit(2);
}
const host = boot.host;
const targets = await listTargets(host);
const sandboxTarget = await ensureSandboxTab(host, targets);
const conn = await connectTarget(sandboxTarget);
try {
  const html = readFileSync(resolve(file), 'utf8');
  await loadSandboxHtml(conn, html, { width: 375 });
  const report = await analyzeTemplate(conn, { root: SANDBOX_ARTICLE_ROOT });
  if (!report?.ok) throw new Error(report?.error || 'analyze 失败');
  const slots = report.predictedSlots || [];
  const byRole = {};
  for (const s of slots) (byRole[s.role] ||= []).push(s);

  const lines = [];
  lines.push(`模板：${file}`);
  lines.push(`rules v${report.roleRulesVersion} / 文字叶子 ${slots.length} / 顶层块 ${report.stats.blockCount}`);
  lines.push('');
  for (const role of ['title', 'subtitle', 'subhead', 'label', 'decor', 'text']) {
    const list = byRole[role] || [];
    lines.push(`【${ROLE_LABELS[role] || role}】${list.length} 处`);
    for (const s of list.slice(0, 12)) {
      lines.push(`  - ${String(s.text).replace(/\s+/g, ' ').slice(0, 40)}  （${s.fontSize}px/${s.fontWeight} ${s.textAlign}${s.hasBgHighlight ? ' 有底色' : ''} 块${s.blockIndex} · ${s.reason}）`);
    }
    if (list.length > 12) lines.push(`  … 另有 ${list.length - 12} 处`);
    lines.push('');
  }

  // compose 找分节的口径：正文之后、独占一块的 subtitle
  const firstTextBlock = Math.min(...slots.filter((s) => s.role === 'text').map((s) => s.blockIndex));
  const secBlocks = [...new Set(slots.filter((s) => s.role === 'subtitle' && s.blockIndex >= firstTextBlock).map((s) => s.blockIndex))];
  lines.push(`compose 预期分节数：${secBlocks.length}（块 ${secBlocks.join(', ')}）`);

  let cleaned = null;
  if (alsoClean) {
    cleaned = await cleanTemplate(conn, {
      root: SANDBOX_ARTICLE_ROOT,
      photoIndices: [],
      clearText: true,
      slotPlaceholders: true,
      photoMode: 'anchor',
      trimFooter: false,
      decorPolicy: 'empty',
    });
    const st = cleaned.stats;
    lines.push(`clean 自检：section ${st.sections[0]}-${st.sections[1]}${st.balanced ? ' 平衡' : ' 不平衡！'} / `
      + `占位符 ${st.textCleared}（装饰置空 ${st.decorEmptied}）/ 角色 `
      + Object.entries(st.roleStats).map(([k, v]) => `${k}:${v}`).join(' '));
  }

  // clean → compose 端到端：验证合成后不残留占位符、section 平衡、分节数对得上
  let composed = null;
  if (alsoCompose) {
    const frame = cleaned || await cleanTemplate(conn, {
      root: SANDBOX_ARTICLE_ROOT, photoIndices: [], clearText: true,
      slotPlaceholders: true, photoMode: 'anchor', trimFooter: false, decorPolicy: 'empty',
    });
    const { loadSandboxHtml: reload, ...rest } = { loadSandboxHtml };
    void rest;
    await reload(conn, frame.html, { width: 375 });
    const { composeInSandbox } = await core('compose');
    const plan = {
      title: ['示例大标题', '第二行标题'],
      lead: ['这是一段用于端到端校验的导语文字。'],
      sections: [
        { heading: '第一节标题', label: '01', paragraphs: ['第一节正文示例文字。'] },
        { heading: '第二节标题', paragraphs: ['第二节正文示例文字。'] },
        { heading: '第三节标题', paragraphs: ['第三节正文示例文字。'] },
      ],
      networkEditors: '测试 编辑',
      footerStyle: null,
    };
    composed = await composeInSandbox(conn, { frameHtml: frame.html, plan, footerHtml: '' });
    const out = composed.html || '';
    const leftover = out.match(/【[^】]{1,6}】/g) || [];
    const openN = (out.match(/<section\b/gi) || []).length;
    const closeN = (out.match(/<\/section>/gi) || []).length;
    lines.push(`compose 自检：section ${openN}-${closeN}${openN === closeN ? ' 平衡' : ' 不平衡！'} / `
      + `计划分节 3 → 模板分节 ${composed.debug?.sections} / 新增段 ${composed.stats?.paragraphsAdded} / `
      + `残留占位符 ${leftover.length}${leftover.length ? '：' + leftover.slice(0, 5).join('') : ''}`);
    if (leftover.length) process.exitCode = 1;
    if (openN !== closeN) process.exitCode = 1;
  }

  if (asJson) {
    console.log(JSON.stringify({
      file, roleRulesVersion: report.roleRulesVersion,
      counts: Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, v.length])),
      sectionBlocks: secBlocks,
      slots,
      clean: cleaned ? cleaned.stats : null,
      compose: composed ? { stats: composed.stats, debug: composed.debug?.sections } : null,
    }, null, 2));
  } else {
    console.log(lines.join('\n'));
  }
} finally {
  conn.close();
}
