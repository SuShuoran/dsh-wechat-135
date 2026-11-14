/**
 * upload.js — 把本地图片传到 135 图床。
 *
 * 为什么在页面里 fetch：图床接口要 135 的登录态 cookie，宿主进程直接 fetch 拿不到；
 * 而在 135 编辑器页里 fetch 是同日源 + 带 cookie 的。
 *
 * 注意：返回的 `bexp.135editor.com/...?auth_key=...` 是带时效的，
 * **要立刻写进文章**（或尽快保存），放太久会 403。
 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { evaluateJson } from './cdp.js';

const ENDPOINT = 'https://www.135editor.com/uploadfiles/ueditor?action=uploadimage';
const MAX_BYTES = 10 * 1024 * 1024;

function mimeOf(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/jpeg';
}

/** 上传单张图片，返回 { ok, url, error }。 */
export async function uploadImage(conn, filePath) {
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`);
  if (stat.size > MAX_BYTES) throw new Error(`图片太大（${(stat.size / 1024 / 1024).toFixed(1)}MB > 10MB）：${filePath}`);
  const buf = readFileSync(filePath);
  const base64 = buf.toString('base64');
  const mime = mimeOf(filePath);
  const name = basename(filePath);
  const expr = String.raw`(async () => {
    const b64 = ${JSON.stringify(base64)};
    const blob = await (await fetch('data:${mime};base64,' + b64)).blob();
    const file = new File([blob], ${JSON.stringify(name)}, { type: '${mime}' });
    const fd = new FormData();
    fd.append('cate_id', '0');
    fd.append('referer', 'https://www.135editor.com/beautify_editor.html');
    fd.append('appkey', 'undefined');
    fd.append('returnType', 'postmsg');
    fd.append('upload', file);
    const res = await fetch(${JSON.stringify(ENDPOINT)}, { method: 'POST', body: fd, credentials: 'include' });
    const text = await res.text();
    const safeJson = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };
    // 135 的 returnType=postmsg 会返回 <script>window.parent.parent.postMessage('{json}','*');</script>
    let data = safeJson(text);
    if (!data) {
      const m = /postMessage\(\s*'([\s\S]*?)'\s*,/.exec(text);
      if (m) data = safeJson(m[1]);
    }
    const url = data && (data.url || (data.data && data.data.url) || data.original || '') || '';
    const state = data && (data.state || (data.data && data.data.state) || '') || '';
    const id = data && (data.id || '') || '';
    return JSON.stringify({ ok: !!url, status: res.status, state, url, id, body: text.slice(0, 400) });
  })()`;
  const r = await evaluateJson(conn, expr, { timeoutMs: 120000 });
  return { file: filePath, bytes: stat.size, ...r };
}

/** 顺序上传多张（135 的接口并发容易触发验证码，串行更稳）。 */
export async function uploadImages(conn, files = []) {
  const results = [];
  for (const file of files) {
    try {
      results.push(await uploadImage(conn, file));
    } catch (e) {
      results.push({ file, ok: false, error: String(e?.message || e) });
    }
  }
  return results;
}
