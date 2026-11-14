/**
 * finish.js — 收尾：快速保存 + 预览链接 + 预览二维码 PNG。
 *
 * 135 的二维码由它自己的 `/tools/qrcode?uri=...` 生成，只有打开「预览分享」面板后才有这个 img。
 * 我们在页面里把这个 img fetch 成 base64（同日源、带 cookie），落盘成 PNG 给用户扫。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluateJson } from './cdp.js';
import { grabPreviewLink, saveDraft } from './editor.js';

/** 把预览面板里的二维码图片取成 PNG 落盘，返回 { path, bytes }。 */
export async function downloadPreviewQr(conn, { src, outPath } = {}) {
  if (!src) throw new Error('没有二维码图片地址');
  const absolute = src.startsWith('http') ? src : `https://www.135editor.com${src.startsWith('/') ? '' : '/'}${src}`;
  const r = await evaluateJson(conn, `(async () => {
    try {
      const res = await fetch(${JSON.stringify(absolute)}, { credentials: 'include' });
      const buf = await res.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return JSON.stringify({ ok: true, status: res.status, base64: btoa(binary), bytes: bytes.length });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message || e) });
    }
  })()`, { timeoutMs: 60000 });
  if (!r?.ok) throw new Error(r?.error || '下载二维码失败');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(r.base64, 'base64'));
  return { path: outPath, bytes: r.bytes, status: r.status };
}

/**
 * 收尾：快速保存 → 打开预览分享拿地址 → 下载二维码。
 * @returns {{ saved, previewUrl, qrcode: {src, path} }}
 */
export async function finishArticle(conn, { sync = false, qrPath } = {}) {
  const saved = await saveDraft(conn, { sync });
  const preview = await grabPreviewLink(conn);
  let qr = null;
  if (qrPath) {
    try {
      const file = await downloadPreviewQr(conn, { src: preview.src, outPath: qrPath });
      qr = { ...file, src: preview.src };
    } catch (e) {
      qr = { error: String(e?.message || e), src: preview.src || '' };
    }
  }
  return { saved, previewUrl: preview.url, qr };
}
