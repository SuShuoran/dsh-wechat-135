#!/usr/bin/env node
/**
 * wx135.mjs — 本地开发/自测 CLI，**不需要把插件装进 DSH** 就能验证核心链路。
 *
 * 用法（在仓库根目录）：
 *   node plugins/dsh-wechat-135/bin/wx135.mjs status
 *   node plugins/dsh-wechat-135/bin/wx135.mjs pages
 *   node plugins/dsh-wechat-135/bin/wx135.mjs read [--save]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs shot [--mode editor|page|viewport] [--max 12]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs eval "<js>"
 *   node plugins/dsh-wechat-135/bin/wx135.mjs backup
 *   node plugins/dsh-wechat-135/bin/wx135.mjs write <html文件>
 *   node plugins/dsh-wechat-135/bin/wx135.mjs save [--sync]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs preview
 *   node plugins/dsh-wechat-135/bin/wx135.mjs analyze
 *   node plugins/dsh-wechat-135/bin/wx135.mjs clean [--photos 0,1,2] [--out DIR]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs upload <图片1> [图片2 ...]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs compose <frame.html> <plan.json> [--footer red|blue|none]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs finish [--sync]
 *   node plugins/dsh-wechat-135/bin/wx135.mjs demo <模板html> [--out DIR]
 *
 * TIPS:
 *   - 中文参数在 PowerShell 里会被编码破坏，尽量只传路径/英文；
 *   - 截图/报告都落到 $DSH_HOME/wechat-135/out 或 --out 指定目录，再用 read_image 看。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  captureScreenshot,
  clearViewport,
  connectTarget,
  evaluate,
  evaluateJson,
  listTargets,
  newTab,
  setViewport,
  sleep,
} from '../src/core/cdp.js';
import { DEFAULT_HOST } from '../src/core/cdp.js';
import { EDITOR_URL, ensureBrowser, manualLaunchCommand } from '../src/core/browser.js';
import { backupsDir, ensureDir, outDir, stamp } from '../src/core/paths.js';
import {
  detectEditor,
  grabPreviewLink,
  isEditorUrl,
  listEditorTabs,
  readEditorHtml,
  saveDraft,
  writeEditorHtml,
} from '../src/core/editor.js';
import { EDITOR_ROOT_EXPR, SANDBOX_ARTICLE_ROOT, analyzeTemplate, cleanTemplate } from '../src/core/template.js';
import { captureEditorSlices, capturePageSlices } from '../src/core/capture.js';
import { ensureSandboxTab, loadSandboxHtml } from '../src/core/sandbox.js';
import { composeInSandbox } from '../src/core/compose.js';
import { loadFooterHtml, listFooterStyles } from '../src/core/footer.js';
import { uploadImage } from '../src/core/upload.js';
import { finishArticle } from '../src/core/finish.js';
import { imageSize } from '../src/core/imagesize.js';
import { buildImageAtlas } from '../src/core/atlas.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positionals = [];
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--save') flags.save = true;
  else if (a === '--sync') flags.sync = true;
  else if (a === '--mode') flags.mode = argv[++i];
  else if (a === '--max') flags.max = Number(argv[++i]);
  else if (a === '--photos') flags.photos = argv[++i].split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
  else if (a === '--out') flags.out = argv[++i];
  else if (a === '--tab') flags.tab = argv[++i];
  else if (a === '--footer') flags.footer = argv[++i];
  else if (a === '--qr') flags.qr = argv[++i];
  else positionals.push(a);
}

const print = (label, value) => {
  console.log(`\n=== ${label} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

async function connectEditorCli() {
  const browser = await ensureBrowser({ launch: true });
  if (!browser.ok) {
    console.error('浏览器不可用：', browser.error);
    console.error('手动启动：', browser.manualCommand || manualLaunchCommand());
    process.exit(1);
  }
  const targets = await listTargets(browser.host);
  const editors = targets.filter((t) => isEditorUrl(t.url || ''));
  if (!editors.length) {
    console.error('没有 135 编辑器标签页；现有标签页：');
    for (const t of targets) console.error(` - ${t.title || '(无标题)'} | ${t.url.slice(0, 120)}`);
    process.exit(1);
  }
  const target = flags.tab
    ? editors.find((t) => (t.url || '').includes(flags.tab) || (t.title || '').includes(flags.tab))
    : editors[0];
  if (!target) {
    console.error('没有匹配的编辑器标签页');
    process.exit(1);
  }
  const conn = await connectTarget(target);
  return { browser, targets, target, conn };
}

async function backupCli(conn, tag = 'editor_cli') {
  const read = await readEditorHtml(conn);
  if (!read?.ok) throw new Error(read?.error || '读正文失败');
  const dir = ensureDir(backupsDir());
  const file = join(dir, `${tag}_${stamp()}.html`);
  writeFileSync(file, read.html, 'utf8');
  writeFileSync(join(dir, `${tag}_LATEST.html`), read.html, 'utf8');
  return file;
}

async function main() {
  if (!cmd || cmd === 'help') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }

  if (cmd === 'pages') {
    const browser = await ensureBrowser({ launch: true });
    if (!browser.ok) {
      console.error(browser.error, '\n手动启动：', browser.manualCommand);
      process.exit(1);
    }
    const targets = await listTargets(browser.host);
    for (const t of targets) console.log(`${t.id}\t${t.url}\t${t.title || ''}`);
    return;
  }

  if (cmd === 'status') {
    const browser = await ensureBrowser({ launch: true });
    print('browser', browser);
    if (!browser.ok) {
      console.error('手动启动：', browser.manualCommand);
      process.exit(1);
    }
    const targets = await listTargets(browser.host);
    const editors = listEditorTabs(targets);
    print('targets', targets.map((t) => ({ id: t.id, url: t.url.slice(0, 160), title: t.title })));
    print('editorTabs', editors);
    if (editors.length) {
      const conn = await connectTarget(targets.find((t) => t.id === editors[0].id));
      try {
        print('editorState', await detectEditor(conn));
      } finally {
        conn.close();
      }
    }
    return;
  }

  if (cmd === 'read') {
    const { conn, target } = await connectEditorCli();
    try {
      const state = await detectEditor(conn);
      print(`state: ${target.title}`, state);
      if (flags.save) print('backup', await backupCli(conn, 'editor_read'));
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'backup') {
    const { conn } = await connectEditorCli();
    try {
      print('backup', await backupCli(conn, 'editor_backup'));
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'shot') {
    const { conn, target } = await connectEditorCli();
    try {
      const mode = flags.mode || 'editor';
      const dir = ensureDir(join(outDir(), `cli-shot-${stamp()}`));
      let shots;
      if (mode === 'editor') shots = await captureEditorSlices(conn, { outDir: dir, maxSlices: flags.max || 12 });
      else if (mode === 'page') shots = await capturePageSlices(conn, { outDir: dir, maxSlices: flags.max || 12 });
      else {
        await setViewport(conn, { width: 430, height: 1400, mobile: true });
        const buffer = await captureScreenshot(conn, { format: 'png' });
        const file = join(dir, 'viewport.png');
        writeFileSync(file, buffer);
        shots = { files: [file] };
        await clearViewport(conn);
      }
      print(`shots: ${target.title}`, shots);
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'eval') {
    const { conn } = await connectEditorCli();
    try {
      const expression = positionals[0];
      if (!expression) throw new Error('eval 需要一段 JS 表达式');
      print('eval', await evaluateJson(conn, expression));
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'write') {
    const file = positionals[0];
    if (!file || !existsSync(file)) throw new Error(`文件不存在：${file}`);
    const html = readFileSync(resolve(file), 'utf8');
    const { conn } = await connectEditorCli();
    try {
      print('backup', await backupCli(conn, 'before_write'));
      const written = await writeEditorHtml(conn, html.replace(/<script\b[\s\S]*?<\/script>/gi, ''));
      print('written', written);
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'save') {
    const { conn } = await connectEditorCli();
    try {
      print('save', await saveDraft(conn, { sync: flags.sync === true }));
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'preview') {
    const { conn } = await connectEditorCli();
    try {
      print('preview', await grabPreviewLink(conn));
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'analyze') {
    const { conn, browser, targets } = await connectEditorCli();
    try {
      const report = await analyzeTemplate(conn, { root: EDITOR_ROOT_EXPR });
      if (!report?.ok) throw new Error(report?.error || '分析失败');
      const dir = ensureDir(flags.out || join(outDir(), `analyze-${stamp()}`));
      const file = join(dir, 'analyze.json');
      writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
      // 图片总览图
      let atlas = null;
      try {
        const sandboxTarget = await ensureSandboxTab(browser.host, targets);
        const sandbox = await connectTarget(sandboxTarget);
        try {
          atlas = await buildImageAtlas(sandbox, report.images, { outPath: join(dir, 'images-atlas.png') });
        } finally {
          sandbox.close();
        }
      } catch (e) {
        atlas = { error: String(e?.message || e) };
      }
      print('stats', report.stats);
      print('profile', report.profile);
      print('images', report.images.map((i) => ({ index: i.index, kind: i.kind, score: i.photoScore, size: `${i.w}x${i.h}`, host: i.host })));
      print('atlas', atlas?.path || atlas?.error || '(失败)');
      print('report', file);
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'clean') {
    const browser = await ensureBrowser({ launch: true });
    if (!browser.ok) throw new Error(browser.error || '浏览器不可用');
    const host = browser.host || DEFAULT_HOST;
    const targets = await listTargets(host);
    const editors = targets.filter((t) => isEditorUrl(t.url || ''));
    if (!editors.length) throw new Error('没有 135 编辑器标签页');
    const editorConn = await connectTarget(editors[0]);
    let html;
    try {
      const read = await readEditorHtml(editorConn);
      if (!read?.ok) throw new Error(read?.error || '读正文失败');
      html = read.html;
    } finally {
      editorConn.close();
    }
    const sandboxTarget = await ensureSandboxTab(host, targets);
    const sandbox = await connectTarget(sandboxTarget);
    try {
      await loadSandboxHtml(sandbox, html);
      const report = await analyzeTemplate(sandbox, { root: SANDBOX_ARTICLE_ROOT });
      const autoPhotos = report.images.filter((im) => im.kind === 'photo' || im.photoScore >= 3).map((im) => im.index);
      const photoIndices = flags.photos?.length ? flags.photos : autoPhotos;
      const cleaned = await cleanTemplate(sandbox, { root: SANDBOX_ARTICLE_ROOT, photoIndices, clearText: true, slotPlaceholders: true });
      const dir = ensureDir(flags.out || join(outDir(), `clean-${stamp()}`));
      const htmlPath = join(dir, 'frame.html');
      writeFileSync(htmlPath, cleaned.html, 'utf8');
      await loadSandboxHtml(sandbox, cleaned.html);
      const shots = await capturePageSlices(sandbox, { outDir: dir, maxSlices: 10, prefix: 'frame' });
      print('photos', photoIndices);
      print('stats', cleaned.stats);
      print('html', htmlPath);
      print('shots', shots.files);
      print('dir', dir);
    } finally {
      sandbox.close();
    }
    return;
  }

  if (cmd === 'demo') {
    const file = positionals[0];
    if (!file || !existsSync(file)) throw new Error(`模板文件不存在：${file}`);
    const html = readFileSync(resolve(file), 'utf8');
    const browser = await ensureBrowser({ launch: true });
    if (!browser.ok) throw new Error(browser.error || '浏览器不可用');
    const host = browser.host || DEFAULT_HOST;
    const targets = await listTargets(host);
    const sandboxTarget = await ensureSandboxTab(host, targets);
    const sandbox = await connectTarget(sandboxTarget);
    const name = file.replace(/\\/g, '/').split('/').pop().replace(/\.html?$/i, '');
    const dir = ensureDir(flags.out || join(outDir(), `demo-${name}-${stamp()}`));
    try {
      await loadSandboxHtml(sandbox, html);
      const before = await analyzeTemplate(sandbox, { root: SANDBOX_ARTICLE_ROOT });
      if (!before?.ok) throw new Error(before?.error || '分析失败');
      writeFileSync(join(dir, 'analyze.json'), JSON.stringify(before, null, 2), 'utf8');
      const beforeShots = await capturePageSlices(sandbox, { outDir: join(dir, 'before'), maxSlices: 10, prefix: 'before' });

      const autoPhotos = before.images.filter((im) => im.kind === 'photo' || im.photoScore >= 3).map((im) => im.index);
      const photoIndices = flags.photos?.length ? flags.photos : autoPhotos;
      const cleaned = await cleanTemplate(sandbox, { root: SANDBOX_ARTICLE_ROOT, photoIndices, clearText: true, slotPlaceholders: true });
      if (!cleaned?.ok) throw new Error(cleaned?.error || '清空失败');
      writeFileSync(join(dir, 'frame.html'), cleaned.html, 'utf8');
      await loadSandboxHtml(sandbox, cleaned.html);
      const afterShots = await capturePageSlices(sandbox, { outDir: join(dir, 'after'), maxSlices: 10, prefix: 'frame' });

      print('stats', before.stats);
      print('images', before.images.map((i) => ({ index: i.index, kind: i.kind, score: i.photoScore, size: `${i.w}x${i.h}`, host: i.host })));
      print('cleanStats', cleaned.stats);
      print('photoIndices', photoIndices);
      print('dir', dir);
      console.log('\nBEFORE:', beforeShots.files.join(', '));
      console.log('AFTER:', afterShots.files.join(', '));
    } finally {
      sandbox.close();
    }
    return;
  }

  if (cmd === 'upload') {
    const files = positionals;
    if (!files.length) throw new Error('upload 需要图片路径');
    const { conn } = await connectEditorCli();
    try {
      const results = [];
      for (const file of files) {
        const p = resolve(file);
        if (!existsSync(p)) { results.push({ file: p, ok: false, error: '文件不存在' }); continue; }
        const size = imageSize(p);
        const up = await uploadImage(conn, p);
        results.push({ ...up, width: size?.width || 0, height: size?.height || 0 });
      }
      print('upload', results);
    } finally {
      conn.close();
    }
    return;
  }

  if (cmd === 'compose') {
    const [frameFile, planFile] = positionals;
    if (!frameFile || !planFile) throw new Error('compose 需要 <frame.html> <plan.json>');
    const frameHtml = readFileSync(resolve(frameFile), 'utf8');
    const plan = JSON.parse(readFileSync(resolve(planFile), 'utf8'));
    const footerStyle = flags.footer || plan.footerStyle || 'blue';
    const footerHtml = loadFooterHtml(footerStyle);
    const browser = await ensureBrowser({ launch: true });
    if (!browser.ok) throw new Error(browser.error || '浏览器不可用');
    const host = browser.host || DEFAULT_HOST;
    const targets = await listTargets(host);
    // 1) 本地图片上传（需要编辑器页的登录态）
    const editorTarget = targets.find((t) => isEditorUrl(t.url || ''));
    if (!editorTarget) throw new Error('没有 135 编辑器标签页，无法上传图片');
    const editorConn = await connectTarget(editorTarget);
    const uploads = [];
    try {
      for (const sec of plan.sections || []) {
        const next = [];
        for (const item of sec.images || []) {
          const raw = typeof item === 'string' ? item : item?.url || '';
          if (!raw) continue;
          if (/^(https?|data):/i.test(raw)) { next.push(item); continue; }
          const p = resolve(raw);
          if (!existsSync(p)) throw new Error(`plan 里的图片不存在：${p}`);
          const size = imageSize(p);
          const up = await uploadImage(editorConn, p);
          uploads.push({ file: p, ok: up.ok, url: up.url, state: up.state, error: up.error });
          if (!up.ok) throw new Error(`上传失败：${p}（${up.state || up.body || 'unknown'}）`);
          next.push({ url: up.url, w: size?.width || 0, h: size?.height || 0 });
        }
        sec.images = next;
      }
    } finally {
      editorConn.close();
    }
    // 2) 沙箱合成 + 预览截图
    const sandboxTarget = await ensureSandboxTab(host, targets);
    const sandbox = await connectTarget(sandboxTarget);
    const dir = ensureDir(flags.out || join(outDir(), `compose-${stamp()}`));
    try {
      await loadSandboxHtml(sandbox, frameHtml);
      const composed = await composeInSandbox(sandbox, { frameHtml, plan, footerHtml });
      if (!composed?.ok) throw new Error(composed?.error || '合成失败');
      const articlePath = join(dir, 'article.html');
      writeFileSync(articlePath, composed.html, 'utf8');
      writeFileSync(join(dir, 'plan.used.json'), JSON.stringify(plan, null, 2), 'utf8');
      await loadSandboxHtml(sandbox, composed.html);
      const shots = await capturePageSlices(sandbox, { outDir: dir, maxSlices: 12, prefix: 'compose' });
      print('footer', footerStyle);
      print('uploads', uploads.map((u) => ({ ok: u.ok, url: u.url })));
      print('stats', composed.stats);
      print('debug', composed.debug);
      print('article', articlePath);
      print('shots', shots.files);
      print('dir', dir);
    } finally {
      sandbox.close();
    }
    return;
  }

  if (cmd === 'finish') {
    const { conn } = await connectEditorCli();
    try {
      const dir = ensureDir(join(outDir(), `finish-${stamp()}`));
      const qrPath = flags.qr ? resolve(flags.qr) : join(dir, 'preview-qr.png');
      const r = await finishArticle(conn, { sync: flags.sync === true, qrPath });
      print('finish', { saved: r.saved, previewUrl: r.previewUrl, qr: r.qr });
    } finally {
      conn.close();
    }
    return;
  }

  throw new Error(`未知命令：${cmd}（node wx135.mjs help 看用法）`);
}

main().catch((e) => {
  console.error('\n[wx135] 失败：', e?.stack || e?.message || e);
  process.exit(1);
});
