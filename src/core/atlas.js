/**
 * atlas.js — 把模板里的图片排成一张带序号的「总览图」。
 *
 * 为什么要它：135 模板里的示例照片和装饰图**同一个素材域名**（bcn.135editor.com），
 * 光看 URL / 尺寸不可能分清"这是模板自带的模特照、要删"还是"这是标题条装饰、要留"。
 * 所以让浏览器把图片全渲染成一张带 #序号的拼图，agent 看一眼就能挑出要删的 index。
 *
 * 纯浏览器渲染 + 一次截图，不依赖任何图像处理库。
 */
import { writeFileSync } from 'node:fs';
import { captureScreenshot, clearViewport, evaluate, setViewport, sleep } from './cdp.js';

/** 生成图片总览图，返回 PNG 路径。 */
export async function buildImageAtlas(conn, images, { outPath, cols = 6, cellH = 130, width = 1200 } = {}) {
  if (!outPath) throw new Error('outPath is required');
  const cells = (images || [])
    .map(
      (im) => (`
      <div class="cell">
        <div class="idx">#${im.index} &nbsp; ${im.w}x${im.h} &nbsp; ${im.kind}${im.photoScore ? ` &nbsp; score=${im.photoScore}` : ''}</div>
        <img src="${String(im.src || '').replace(/"/g, '&quot;')}" />
        <div class="meta">渲染 ${im.renderedW}x${im.renderedH}</div>
      </div>`),
    )
    .join('');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 14px; background: #ffffff; font-family: Consolas, "Microsoft YaHei", monospace; }
    .grid { display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr)); gap: 10px; }
    .cell { border: 1px solid #dddddd; border-radius: 4px; padding: 6px; background: #fafafa; min-width: 0; }
    .idx { font-size: 12px; color: #cc0000; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    img { width: 100%; height: ${cellH}px; object-fit: contain; background: #ffffff; display: block; }
    .meta { font-size: 11px; color: #888888; margin-top: 3px; }
  </style></head><body><div class="grid">${cells}</div></body></html>`;

  await evaluate(conn, `(() => { document.open(); document.write(${JSON.stringify(html)}); document.close(); return 'ok'; })()`);
  await sleep(2200);
  const pageHeight = Number(await evaluate(conn, 'document.documentElement.scrollHeight')) || 1600;
  try {
    await setViewport(conn, { width, height: Math.min(pageHeight + 60, 7900), mobile: false });
    await sleep(1200);
    const buffer = await captureScreenshot(conn, { format: 'png' });
    writeFileSync(outPath, buffer);
    return { path: outPath, width, height: Math.min(pageHeight + 60, 7900), count: (images || []).length };
  } finally {
    await clearViewport(conn).catch(() => {});
  }
}
