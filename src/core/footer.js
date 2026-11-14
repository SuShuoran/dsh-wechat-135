/**
 * footer.js — 固定尾部（数小理/权益小信箱/数小理树洞 + END + 理学院 + 四审署名）。
 *
 * 尾部是「固定内容」：文案、二维码、END、理学院、责任编辑/审核/终审 都不变，
 * 只有「网络编辑」名单每篇不同（模板里用 `{{NETWORK_EDITORS}}` 占位）。
 *
 * 两套样式：
 *   - red：红金延安风（从已发布的延安行文章里提取）
 *   - blue：蓝白通用风（从编辑器里的校友论坛草稿里提取）
 * 通过 wx135_template analyze 的模板配色/风格自己判断，或直接指定。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ASSETS_DIR = fileURLToPath(new URL('../../assets', import.meta.url));

/** 列出可用的固定尾部样式名（red / blue / …）。 */
export function listFooterStyles() {
  try {
    return readdirSync(ASSETS_DIR)
      .map((f) => /^footer-(.+)\.html$/.exec(f))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch {
    return [];
  }
}

/** 读固定尾部 HTML（含 {{NETWORK_EDITORS}} 占位）。 */
export function loadFooterHtml(style = 'blue') {
  if (!style || style === 'none') return '';
  const file = join(ASSETS_DIR, `footer-${style}.html`);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    const styles = listFooterStyles();
    throw new Error(`没有固定尾部样式 "${style}"，可用：${styles.join(' / ') || '(无)'}`);
  }
}
