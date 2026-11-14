/**
 * tools.js — 注册给 agent 的工具定义。
 *
 * 设计原则：
 *   1. **大块 HTML 走文件路径，不走参数**：让模型在工具参数里塞 50KB 的 HTML 既贵又容易截断，
 *      所以读/写/清空模板都落盘，工具只传路径。
 *   2. **写之前必读、必备份**：`wx135_write` 会先把编辑器当前正文备份到 backups/ 再写。
 *   3. 所有工具返回 `{ text, data }`：text 给人看/给模型看，data 是结构化结果（lossless JSON）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_HOST,
  captureScreenshot,
  clearViewport,
  connectTarget,
  listTargets,
  setViewport,
  sleep,
} from './core/cdp.js';
import { ensureBrowser, manualLaunchCommand } from './core/browser.js';
import { backupsDir, ensureDir, outDir, stamp } from './core/paths.js';
import {
  detectEditor,
  grabPreviewLink,
  isEditorUrl,
  listEditorTabs,
  readEditorHtml,
  saveDraft,
  writeEditorHtml,
} from './core/editor.js';
import {
  EDITOR_ROOT_EXPR,
  SANDBOX_ARTICLE_ROOT,
  analyzeTemplate,
  cleanTemplate,
} from './core/template.js';
import { captureEditorSlices, capturePageSlices } from './core/capture.js';
import { ensureSandboxTab, loadSandboxHtml } from './core/sandbox.js';
import { buildImageAtlas } from './core/atlas.js';
import { composeInSandbox } from './core/compose.js';
import { loadFooterHtml, listFooterStyles } from './core/footer.js';
import { uploadImage } from './core/upload.js';
import { finishArticle } from './core/finish.js';
import { imageSize } from './core/imagesize.js';

/** 宿主只接受无损 JSON；把 undefined / NaN / Infinity 都清掉。 */
export function toLosslessJson(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toLosslessJson);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = toLosslessJson(v);
  return out;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** 找（或按参数挑）一个 135 编辑器标签页，并连上。 */
async function connectEditor({ tab, launch = true } = {}) {
  const browser = await ensureBrowser({ launch });
  if (!browser.ok) {
    throw new Error(
      `浏览器调试端口没起来（${browser.error}）。让用户在自己的终端里执行：\n${browser.manualCommand || manualLaunchCommand()}`,
    );
  }
  const host = browser.host || DEFAULT_HOST;
  const targets = await listTargets(host);
  const editors = targets.filter((t) => isEditorUrl(t.url || ''));
  if (!editors.length) {
    const pages = targets.map((t) => `- ${t.title || '(无标题)'} | ${t.url.slice(0, 120)}`).join('\n');
    throw new Error(`没有找到 135 编辑器标签页。当前标签页：\n${pages || '(空)'}`);
  }
  let target = editors[0];
  if (tab) {
    const hit = editors.find((t) => (t.url || '').includes(tab) || (t.title || '').includes(tab));
    if (!hit) throw new Error(`没有标签页匹配 "${tab}"，现有：${editors.map((t) => t.title).join(' / ')}`);
    target = hit;
  }
  const conn = await connectTarget(target);
  return { host, targets, editors, target, conn };
}

function summarizeState(state) {
  if (!state?.ok) return '编辑器正文 iframe 没找到';
  const e = state.editor;
  return [
    `正文 ${e.textLen} 字 / ${e.htmlLen} 字符 HTML / ${e.imgs} 张图`,
    `section 开闭 ${e.sections[0]}/${e.sections[1]}${e.sections[0] === e.sections[1] ? '（平衡）' : '（不平衡！）'}`,
    `开头：${e.head || '(空)'}`,
    `结尾：${e.tail || '(空)'}`,
  ].join('\n');
}

/** 备份当前编辑器正文，返回落盘路径。 */
async function backupEditor(conn, { tag = 'editor' } = {}) {
  const read = await readEditorHtml(conn);
  if (!read?.ok) throw new Error(read?.error || '读正文失败');
  const dir = ensureDir(backupsDir());
  const ts = stamp();
  const file = join(dir, `${tag}_${ts}.html`);
  writeFileSync(file, read.html, 'utf8');
  writeFileSync(join(dir, `${tag}_LATEST.html`), read.html, 'utf8');
  return { file, html: read.html };
}

/** 工具公共输出包装。 */
function result(text, data = {}) {
  return { text, data: toLosslessJson(data) };
}

export function createTools(defineTool) {
  const tools = [];

  // ─────────────────────────────────────────────────────────── status
  tools.push(
    defineTool({
      name: 'wx135_status',
      description:
        '检查「135 编辑器 / 微信公众号排版」这条工作链是否就绪：浏览器调试端口、标签页、编辑器正文状态。'
        + '第一次用、或怀疑浏览器退出了，先调它。默认会在端口没起时自动拉起一个专用 Edge 实例'
        + '（独立用户目录，135 账号只需登录一次）；拉不起来会返回手动启动命令。',
      parameters: {
        launch: { type: 'boolean', description: '端口没监听时是否自动启动浏览器，默认 true。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const launch = args.launch !== false;
        const browser = await ensureBrowser({ launch });
        const targets = browser.ok ? await listTargets(browser.host) : [];
        const editors = listEditorTabs(targets);
        const details = [];
        for (const e of editors) {
          const target = targets.find((t) => t.id === e.id);
          try {
            const conn = await connectTarget(target);
            try {
              const state = await detectEditor(conn);
              details.push({ ...e, state });
            } finally {
              conn.close();
            }
          } catch (err) {
            details.push({ ...e, error: String(err?.message || err) });
          }
        }
        const lines = [];
        lines.push(`浏览器：${browser.ok ? `已连接 ${browser.host}（${browser.browser || 'unknown'}）` : `不可用：${browser.error}`}`);
        if (browser.started) lines.push('（本次由插件自动拉起）');
        if (!browser.ok && browser.manualCommand) {
          lines.push('');
          lines.push('手动启动命令：');
          lines.push(browser.manualCommand);
        }
        lines.push(`标签页：${targets.length} 个，其中 135 编辑器 ${editors.length} 个`);
        for (const d of details) {
          lines.push('');
          lines.push(`▸ ${d.title || '(无标题)'}`);
          lines.push(`  ${d.state?.ok ? summarizeState(d.state).replace(/\n/g, '\n  ') : d.error || '正文不可读'}`);
        }
        return result(lines.join('\n'), {
          browser,
          tabs: targets.map((t) => ({ id: t.id, url: t.url.slice(0, 200), title: t.title || '' })),
          editors: details,
        });
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── read
  tools.push(
    defineTool({
      name: 'wx135_read',
      description: '读 135 编辑器当前正文的摘要（字数、图片数、section 平衡、首尾文字）；'
        + 'save=true 时把完整 HTML 备份到 backups/ 并返回路径。改稿前先读一次是规矩。',
      parameters: {
        tab: { type: 'string', description: '按 URL 或标题子串选编辑器标签页；不传用第一个。' },
        save: { type: 'boolean', description: '是否把完整正文 HTML 备份落盘，默认 false。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const { conn, target } = await connectEditor({ tab: args.tab });
        try {
          const state = await detectEditor(conn);
          let backupPath = null;
          if (args.save) {
            const b = await backupEditor(conn, { tag: 'editor' });
            backupPath = b.file;
          }
          const text = `▸ ${target.title || '(无标题)'}\n${summarizeState(state)}`
            + (backupPath ? `\n备份：${backupPath}` : '');
          return result(text, { tab: { id: target.id, url: target.url, title: target.title }, state, backupPath });
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── shot
  tools.push(
    defineTool({
      name: 'wx135_shot',
      description:
        '把 135 编辑器正文（或任意页面）按手机宽度截成分屏 PNG，返回文件路径，用 read_image 查看。'
        + 'mode=editor（默认，截编辑器里的正文，隐藏 135 的界面）、page（普通页面滚动截图）、'
        + 'viewport（只截当前视口）。',
      parameters: {
        tab: { type: 'string', description: '编辑器标签页子串（mode=editor 时生效）。' },
        mode: { type: 'string', description: 'editor | page | viewport，默认 editor。' },
        maxSlices: { type: 'integer', description: '最多截几屏，默认 12。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const mode = args.mode || 'editor';
        const maxSlices = Math.max(1, Math.min(30, args.maxSlices || 12));
        const browser = await ensureBrowser({ launch: true });
        if (!browser.ok) throw new Error(browser.error || '浏览器不可用');
        const host = browser.host || DEFAULT_HOST;
        const targets = await listTargets(host);
        let target = null;
        if (mode === 'editor') {
          const editors = targets.filter((t) => isEditorUrl(t.url || ''));
          target = args.tab
            ? editors.find((t) => (t.url || '').includes(args.tab) || (t.title || '').includes(args.tab))
            : editors[0];
          if (!target) throw new Error('没有匹配的 135 编辑器标签页');
        } else {
          target = args.tab
            ? targets.find((t) => (t.url || '').includes(args.tab) || (t.title || '').includes(args.tab))
            : targets[0];
          if (!target) throw new Error('没有可截图的标签页');
        }
        const conn = await connectTarget(target);
        try {
          const dir = ensureDir(join(outDir(), `shot-${stamp()}`));
          let shots;
          if (mode === 'editor') {
            shots = await captureEditorSlices(conn, { outDir: dir, maxSlices, prefix: 'editor' });
          } else if (mode === 'page') {
            shots = await capturePageSlices(conn, { outDir: dir, maxSlices, prefix: 'page' });
          } else {
            await setViewport(conn, { width: 430, height: 1400, mobile: true });
            await sleep(500);
            const buffer = await captureScreenshot(conn, { format: 'png' });
            const file = join(dir, 'viewport-00.png');
            writeFileSync(file, buffer);
            shots = { files: [file], contentHeight: 0, width: 430, sliceH: 1400 };
            await clearViewport(conn);
          }
          const text = `已截图 ${shots.files.length} 张（内容高 ${shots.contentHeight}px，宽 ${shots.width}）：\n`
            + shots.files.map((f) => `- ${f}`).join('\n');
          return result(text, { tab: { id: target.id, title: target.title }, ...shots });
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── eval
  tools.push(
    defineTool({
      name: 'wx135_eval',
      description:
        '在指定标签页里执行一段 JS 并返回结果（排查/取数用，属于高级工具）。'
        + '注意：能读 DOM 就能改 DOM，非必要不要用它写东西；写正文请走 wx135_write（会先备份）。',
      parameters: {
        tab: { type: 'string', description: '按 URL 或标题子串选标签页；不传用第一个。' },
        expression: { type: 'string', required: true, description: '要执行的 JS 表达式，返回值需可 JSON 序列化。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        if (!args.expression) throw new Error('expression 必填');
        const browser = await ensureBrowser({ launch: true });
        if (!browser.ok) throw new Error(browser.error || '浏览器不可用');
        const host = browser.host || DEFAULT_HOST;
        const targets = await listTargets(host);
        const target = args.tab
          ? targets.find((t) => (t.url || '').includes(args.tab) || (t.title || '').includes(args.tab))
          : targets[0];
        if (!target) throw new Error('没有匹配的标签页');
        const conn = await connectTarget(target);
        try {
          const value = await evaluateJson(conn, args.expression);
          return result(textOf(value).slice(0, 6000), { tab: target.url, value });
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── write
  tools.push(
    defineTool({
      name: 'wx135_write',
      description:
        '把本地 HTML 文件整体写入 135 编辑器正文。**会先把当前正文备份到 backups/**，写完立即回读校验'
        + '（字数/图片数/section 平衡/首尾文字）。用于"清空模板"、"整篇套版"这类整段替换。',
      parameters: {
        file: { type: 'string', required: true, description: '要写入的 HTML 文件绝对/相对路径。' },
        tab: { type: 'string', description: '编辑器标签页子串；不传用第一个。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        if (!args.file) throw new Error('file 必填');
        if (!existsSync(args.file)) throw new Error(`文件不存在：${args.file}`);
        const html = readFileSync(args.file, 'utf8');
        if (!html.trim()) throw new Error('文件是空的');
        const { conn, target } = await connectEditor({ tab: args.tab });
        try {
          const backup = await backupEditor(conn, { tag: 'before_write' });
          const clean = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
          const written = await writeEditorHtml(conn, clean);
          if (!written?.ok) throw new Error(written?.error || '写入失败');
          const after = written.after;
          const lines = [
            `已写入：${target.title || '(无标题)'}`,
            `备份：${backup.file}`,
            `写入后：${after.textLen} 字 / ${after.htmlLen} 字符 / ${after.imgs} 张图 / section ${after.sections[0]}-${after.sections[1]}${after.sections[0] === after.sections[1] ? '（平衡）' : '（不平衡！）'}`,
            `开头：${after.head}`,
            `结尾：${after.tail}`,
          ];
          return result(lines.join('\n'), { tab: target.url, backupPath: backup.file, before: written.before, after });
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── template
  tools.push(
    defineTool({
      name: 'wx135_template',
      description:
        '135 模板解析与清空。action=analyze：返回模板解剖报告（块结构、文字字号/颜色画像、图片清单'
        + '与「装饰 vs 实拍」初判），报告落盘供后续使用；action=clean：把当前模板复制到沙箱页，'
        + '清掉实拍图（默认换成不可见锚点，compose 时填新图）和文字（换成【大标题】/【小标题】/【正文】槽位），'
        + '**不写回编辑器**，返回清空后的 frames HTML、槽位统计与截图。photoIndices 不传时自动按初判删除。',
      parameters: {
        action: { type: 'string', description: 'analyze | clean，默认 analyze。' },
        tab: { type: 'string', description: '编辑器标签页子串；不传用第一个。' },
        photoIndices: {
          type: 'array',
          items: { type: 'integer' },
          description: 'action=clean 时要删掉的图片下标（来自 analyze 的 images[].index）。',
        },
        slotPlaceholders: { type: 'boolean', description: 'action=clean 时文字是否换成【大标题】/【正文】占位，默认 true。' },
        photoMode: { type: 'string', description: 'action=clean 时照片处理：anchor=不可见锚点（工作流默认，compose 填图）/ placeholder=灰色占位块（演示用）。' },
        trimFooter: { type: 'boolean', description: 'action=clean 时是否删掉模板自带的尾部（END/网络编辑/数小理…），工作流默认 true。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const action = args.action || 'analyze';
        const { conn, target, host, targets } = await connectEditor({ tab: args.tab });
        try {
          if (action === 'analyze') {
            const report = await analyzeTemplate(conn, { root: EDITOR_ROOT_EXPR });
            if (!report?.ok) throw new Error(report?.error || '分析失败');
            const dir = ensureDir(join(outDir(), `template-${stamp()}`));
            const reportPath = join(dir, 'analyze.json');
            writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
            const st = report.stats;
            // 图片总览图：让 agent 目视区分「模板自带示例照片」和「装饰素材」
            let atlas = null;
            try {
              const sandboxTarget = await ensureSandboxTab(host, targets);
              const sandboxConn = await connectTarget(sandboxTarget);
              try {
                atlas = await buildImageAtlas(sandboxConn, report.images, { outPath: join(dir, 'images-atlas.png') });
              } finally {
                sandboxConn.close();
              }
            } catch (e) {
              atlas = { error: String(e?.message || e) };
            }
            const photos = report.images.filter((im) => im.kind === 'photo' || im.photoScore >= 3);
            const titleLeaves = (report.leaves || []).filter((l) => (l.fontSize || 0) >= 20).length;
            const lines = [
              `模板：tplid=${st.tplid || '(未知)'} / ${st.htmlLen} 字符 / ${st.imgCount} 图 / ${st.blockCount} 个顶层块`,
              `section ${st.sections[0]}-${st.sections[1]}${st.balanced ? '（平衡）' : '（不平衡！）'} / SVG ${st.svgCount} 个 / 绝对定位布局 ${st.absoluteLayouts} 个`,
              `文字叶子 ${st.leafCount} 个，字号画像：`,
              ...report.profile.slice(0, 6).map((p) => `  - ${p.count} 处 ${p.key.replaceAll('|', ' / ')} 例：${p.sample}`),
              `标题可编辑性：${titleLeaves} 个 ≥20px 文字叶${titleLeaves ? '（有文字大标题，换标题没问题）' : '（⚠️ 大标题可能是图片/图形，换标题需要换图，建议换一个标题可编辑的模板）'}`,
              `图片初判：自动实拍候选 ${photos.length} 张 / 装饰 ${report.images.filter((i) => i.kind.startsWith('decor')).length} 张`,
              `图片总览（带 #序号，先看它再决定删哪些）：${atlas?.path || atlas?.error || '(生成失败)'}`,
              `完整报告：${reportPath}`,
              '下一步：看总览图挑出「模板自带示例照片」的 #序号，调 wx135_template action=clean photoIndices=[...]。',
            ];
            return result(lines.join('\n'), {
              tab: target.url,
              reportPath,
              atlasPath: atlas?.path || null,
              stats: st,
              profile: report.profile,
              titleLeaves,
              photoCandidates: photos.map((p) => p.index),
            });
          }

          // clean：读编辑器 HTML -> 沙箱页 -> 清理 -> 落盘 + 截图
          const read = await readEditorHtml(conn);
          if (!read?.ok) throw new Error(read?.error || '读正文失败');
          const sandboxTarget = await ensureSandboxTab(host, targets);
          const sandboxConn = await connectTarget(sandboxTarget);
          try {
            await loadSandboxHtml(sandboxConn, read.html);
            const before = await analyzeTemplate(sandboxConn, { root: SANDBOX_ARTICLE_ROOT });
            if (!before?.ok) throw new Error(before?.error || '沙箱分析失败');
            const autoPhotos = before.images
              .filter((im) => im.kind === 'photo' || im.photoScore >= 3)
              .map((im) => im.index);
            const photoIndices = Array.isArray(args.photoIndices) && args.photoIndices.length
              ? args.photoIndices
              : autoPhotos;
            const cleaned = await cleanTemplate(sandboxConn, {
              root: SANDBOX_ARTICLE_ROOT,
              photoIndices,
              clearText: true,
              slotPlaceholders: args.slotPlaceholders !== false,
              photoMode: args.photoMode || 'anchor',
              trimFooter: args.trimFooter !== false,
            });
            if (!cleaned?.ok) throw new Error(cleaned?.error || '清空失败');
            const dir = ensureDir(join(outDir(), `clean-${stamp()}`));
            const htmlPath = join(dir, 'frame.html');
            writeFileSync(htmlPath, cleaned.html, 'utf8');
            // 重新按清空后的内容渲染，截分屏图
            await loadSandboxHtml(sandboxConn, cleaned.html);
            const shots = await capturePageSlices(sandboxConn, { outDir: dir, maxSlices: 10, prefix: 'frame' });
            const lines = [
              `清空完成（未写回编辑器）：${target.title || '(无标题)'}`,
              `删除实拍图 ${cleaned.stats.removedPhotos} 张（${(args.photoMode || 'anchor') === 'anchor' ? '换成不可见锚点' : '换成占位块'}）；文字槽 ${cleaned.stats.textCleared} 处；剩余 ${cleaned.stats.imgs} 图`,
              `槽位：大标题 ${cleaned.stats.titleSlots} / 小标题 ${cleaned.stats.subtitleSlots} / 正文 ${cleaned.stats.textSlots} / 照片锚点 ${cleaned.stats.photoAnchors}`,
              `section ${cleaned.stats.sections[0]}-${cleaned.stats.sections[1]}${cleaned.stats.balanced ? '（平衡）' : '（不平衡！）'}`,
              `框架 HTML：${htmlPath}`,
              `截图：`,
              ...shots.files.map((f) => `- ${f}`),
              '',
              '下一步：wx135_compose（frame=这个 frame.html + plan.json）合成整篇。',
            ];
            return result(lines.join('\n'), {
              tab: target.url, htmlPath, shots: shots.files, stats: cleaned.stats, photoIndices,
            });
          } finally {
            sandboxConn.close();
          }
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── save
  tools.push(
    defineTool({
      name: 'wx135_save',
      description:
        '点 135 编辑器的「快速保存」（sync=false）或「保存同步」（sync=true），并监听网络请求确认保存真的发出去了。'
        + '保存同步会弹出"同步完成/请勿关闭弹窗"提示，通常由用户最后确认，不要随手调用。',
      parameters: {
        sync: { type: 'boolean', description: 'true=保存同步（推到公众号草稿），默认 false=快速保存。' },
        tab: { type: 'string', description: '编辑器标签页子串；不传用第一个。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const { conn, target } = await connectEditor({ tab: args.tab });
        try {
          const saved = await saveDraft(conn, { sync: args.sync === true });
          const text = saved.ok
            ? `已${saved.label}：${target.title || '(无标题)'}\n请求：${saved.requests.map((r) => r.method + ' ' + r.url).join('\n')}`
            : `${saved.label}未确认：${saved.note}`;
          return result(text, { tab: target.url, ...saved });
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── preview
  tools.push(
    defineTool({
      name: 'wx135_preview',
      description:
        '点开「预览分享」，取出临时预览地址（有效期约 1 小时）和二维码地址。要给别人手机扫码的，'
        + '拿到链接后通常还要生成二维码图片（后续版本内置），或直接 wx135_shot mode=page 截预览页。',
      parameters: {
        tab: { type: 'string', description: '编辑器标签页子串；不传用第一个。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const { conn, target } = await connectEditor({ tab: args.tab });
        try {
          const preview = await grabPreviewLink(conn);
          return result(
            `预览地址（约 1 小时有效）：\n${preview.url}\n二维码图：${preview.src || '(未取到)'}`,
            { tab: target.url, ...preview },
          );
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── upload
  tools.push(
    defineTool({
      name: 'wx135_upload',
      description:
        '把本地图片上传到 135 图床，返回可直接写进文章的图片 URL（bexp.135editor.com，带时效，尽快使用）。'
        + '排版合成（wx135_compose）会自动调用它，一般不需要单独调；要单独传图/换图时用。',
      parameters: {
        files: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: '本地图片路径列表（png/jpg/gif/webp，单张 ≤10MB）。',
        },
        tab: { type: 'string', description: '在哪个编辑器标签页里上传（默认第一个）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const files = Array.isArray(args.files) ? args.files : [];
        if (!files.length) throw new Error('files 不能为空');
        const { conn } = await connectEditor({ tab: args.tab });
        try {
          const results = [];
          for (const file of files) {
            if (!existsSync(file)) { results.push({ file, ok: false, error: '文件不存在' }); continue; }
            const size = imageSize(file);
            const up = await uploadImage(conn, file);
            results.push({ ...up, width: size?.width || 0, height: size?.height || 0 });
          }
          const okList = results.filter((r) => r.ok);
          const lines = [
            `上传 ${results.length} 张，成功 ${okList.length} 张：`,
            ...results.map((r) => (r.ok
              ? `- ${r.file} (${r.width}x${r.height}) -> ${r.url}`
              : `- ${r.file} 失败：${r.error || r.state || r.body || 'unknown'}`)),
          ];
          return result(lines.join('\n'), { results });
        } finally {
          conn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── compose
  tools.push(
    defineTool({
      name: 'wx135_compose',
      description:
        '排版合成（工作流核心）：把 wx135_template clean 产出的框架 HTML + 内容方案 plan.json 合成为整篇推文。'
        + '会自动上传 plan 里的本地图片到 135 图床、填标题/导语/分节标题/正文、按规则排图片（全景/合照全宽、'
        + '其余两两一行）、加文字/图片来源、拼固定尾部。**不写编辑器**——产物 article.html 再用 wx135_write 写回。'
        + 'plan.json 字段：title[]、subtitle、lead[]、sections[{heading,paragraphs[],images[]}]、'
        + 'closing、credits{文字来源,图片来源}、networkEditors、footerStyle。',
      parameters: {
        frame: { type: 'string', required: true, description: '框架 HTML 路径（clean 的 frame.html）。' },
        plan: { type: 'string', required: true, description: '内容方案 plan.json 路径。' },
        footerStyle: { type: 'string', description: `固定尾部样式：${listFooterStyles().join(' / ') || 'blue'} / none；默认取 plan.footerStyle，否则 blue。` },
        outDir: { type: 'string', description: '输出目录；默认 ~/.dsh/wechat-135/out/compose-<时间>。' },
        preview: { type: 'boolean', description: '是否渲染沙箱预览截图，默认 true。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        if (!args.frame || !existsSync(args.frame)) throw new Error(`frame 不存在：${args.frame}`);
        if (!args.plan || !existsSync(args.plan)) throw new Error(`plan 不存在：${args.plan}`);
        const frameHtml = readFileSync(args.frame, 'utf8');
        const plan = JSON.parse(readFileSync(args.plan, 'utf8'));
        const footerStyle = args.footerStyle || plan.footerStyle || 'blue';
        const footerHtml = loadFooterHtml(footerStyle);
        const dir = ensureDir(args.outDir || join(outDir(), `compose-${stamp()}`));

        // 1) 本地图片上传到 135 图床
        const { conn: editorConn, host, targets } = await connectEditor({});
        const uploads = [];
        try {
          for (const sec of plan.sections || []) {
            const next = [];
            for (const item of sec.images || []) {
              const raw = typeof item === 'string' ? item : (item && item.url) || '';
              if (!raw) continue;
              if (/^(https?|data):/i.test(raw)) { next.push(item); continue; }
              if (!existsSync(raw)) throw new Error(`plan 里的图片不存在：${raw}`);
              const size = imageSize(raw);
              const up = await uploadImage(editorConn, raw);
              uploads.push({ file: raw, ok: up.ok, url: up.url, state: up.state, error: up.error });
              if (!up.ok) throw new Error(`上传失败：${raw}（${up.state || up.body || 'unknown'}）`);
              next.push({ url: up.url, w: size?.width || 0, h: size?.height || 0 });
            }
            sec.images = next;
          }
        } finally {
          editorConn.close();
        }

        // 2) 沙箱里合成
        const sandboxTarget = await ensureSandboxTab(host, targets);
        const sandboxConn = await connectTarget(sandboxTarget);
        try {
          await loadSandboxHtml(sandboxConn, frameHtml);
          const composed = await composeInSandbox(sandboxConn, { frameHtml, plan, footerHtml });
          if (!composed?.ok) throw new Error(composed?.error || '合成失败');
          const articlePath = join(dir, 'article.html');
          writeFileSync(articlePath, composed.html, 'utf8');
          writeFileSync(join(dir, 'plan.used.json'), JSON.stringify(plan, null, 2), 'utf8');
          let shots = [];
          if (args.preview !== false) {
            await loadSandboxHtml(sandboxConn, composed.html);
            const captured = await capturePageSlices(sandboxConn, { outDir: dir, maxSlices: 12, prefix: 'compose' });
            shots = captured.files;
          }
          const st = composed.stats;
          const lines = [
            `合成完成：${st.sections[0]} section（${st.balanced ? '平衡' : '不平衡！'}）/ ${st.images} 图 / ${st.textLen} 字`,
            `新增分节 ${st.addedSections}、删多余分节 ${st.removedSections}、补段落 ${st.paragraphsAdded}、放图 ${st.imagesPlaced}`,
            `上传图片 ${uploads.filter((u) => u.ok).length}/${uploads.length} 张`,
            `固定尾部：${footerStyle}${footerStyle === 'none' ? '' : '（含四审署名，网络编辑已替换）'}`,
            `文章 HTML：${articlePath}`,
            `方案（含图床 URL）：${join(dir, 'plan.used.json')}`,
            shots.length ? '预览截图（沙箱渲染，图片可能因热链不显示，最终以 135 预览为准）：' : '',
            ...shots.map((f) => `- ${f}`),
            '',
            '下一步：wx135_write 写回编辑器 → wx135_finish 保存 + 预览二维码。',
          ].filter(Boolean);
          return result(lines.join('\n'), {
            articlePath, planPath: join(dir, 'plan.used.json'), shots, stats: st, uploads, footerStyle,
          });
        } finally {
          sandboxConn.close();
        }
      },
    }),
  );

  // ─────────────────────────────────────────────────────────── finish
  tools.push(
    defineTool({
      name: 'wx135_finish',
      description:
        '收尾：快速保存当前草稿 → 打开「预览分享」取预览地址 → 把预览二维码下载成 PNG。'
        + '返回二维码图片路径（直接发给用户手机扫）。默认只快速保存，sync=true 才是保存同步到公众号。',
      parameters: {
        tab: { type: 'string', description: '编辑器标签页子串；不传用第一个。' },
        sync: { type: 'boolean', description: 'true=保存同步（推到公众号草稿），默认 false 只快速保存。' },
        qrPath: { type: 'string', description: '二维码 PNG 保存路径；默认 ~/.dsh/wechat-135/out/finish-<时间>/preview-qr.png。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            data: { type: 'json' },
          },
        },
        render(_args, value) {
          return [{ type: 'text', text: value.text }];
        },
      },
      async execute(args = {}) {
        const { conn, target } = await connectEditor({ tab: args.tab });
        try {
          const dir = ensureDir(join(outDir(), `finish-${stamp()}`));
          const qrPath = args.qrPath || join(dir, 'preview-qr.png');
          const r = await finishArticle(conn, { sync: args.sync === true, qrPath });
          const lines = [
            `保存：${r.saved.ok ? `已${r.saved.label}` : `未确认（${r.saved.note}）`}`,
            `预览地址（约 1 小时有效）：\n${r.previewUrl}`,
            r.qr?.path ? `预览二维码 PNG：${r.qr.path}（${r.qr.bytes} 字节）` : `二维码：${r.qr?.error || '未生成'}`,
            `编辑器：${target.title || '(无标题)'}`,
          ];
          return result(lines.join('\n'), { tab: target.url, ...r, qrPath });
        } finally {
          conn.close();
        }
      },
    }),
  );

  return tools;
}
