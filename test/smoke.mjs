/**
 * smoke.mjs — 插件冒烟测试（不需要装进 DSH）。
 *
 * 覆盖：
 *   1. 8 个工具的定义形状（name / parameters / output / execute）
 *   2. `apply(ctx)` 的真实注册链路（用 fake-dsh-tools 替身 + 假 ctx）
 *   3. `wx135_status` / `wx135_read` 在真实浏览器上的行为（浏览器没起会自动拉起）
 *   4. plugin-load.json 状态文件
 *
 * 运行：
 *   node plugins/dsh-wechat-135/test/smoke.mjs
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');

// apply() 的依赖解析：用替身替代 @deepseek-ai/dsh-tools
process.env.DSH_TOOLS_PATH = join(here, 'fake-dsh-tools.mjs');
// 状态/备份/产物写到临时目录，别污染 ~/.dsh
const dataDir = mkdtempSync(join(tmpdir(), 'wx135-smoke-'));
process.env.WX135_DATA_DIR = dataDir;

const { createTools } = await import(pathToFileURL(join(root, 'src/tools.js')).href);
const { apply } = await import(pathToFileURL(join(root, 'src/index.js')).href);

const EXPECTED = [
  'wx135_status',
  'wx135_read',
  'wx135_shot',
  'wx135_eval',
  'wx135_write',
  'wx135_template',
  'wx135_save',
  'wx135_preview',
  'wx135_upload',
  'wx135_compose',
  'wx135_finish',
];

const pass = (label) => console.log(`PASS  ${label}`);

// ── 1. 工具定义 ─────────────────────────────────────────────
const tools = createTools((spec) => spec);
assert.equal(tools.length, EXPECTED.length, '工具数量对不上');
assert.deepEqual(tools.map((t) => t.name), EXPECTED, '工具名对不上');
for (const t of tools) {
  assert.ok(t.description && t.description.length > 20, `${t.name} 缺 description`);
  assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
  assert.ok(t.parameters && typeof t.parameters === 'object', `${t.name} 缺 parameters`);
  assert.ok(t.output?.schema && typeof t.output.render === 'function', `${t.name} 缺 output`);
  assert.equal(t.parameters.type, undefined, `${t.name} 的 parameters 不该是完整 JSON Schema`);
}
pass(`工具定义 ${tools.length} 个：${tools.map((t) => t.name).join(', ')}`);

// ── 2. apply 注册链路 ───────────────────────────────────────
const registered = [];
const disposers = [];
const ctx = {
  tools: {
    register(def) {
      registered.push(def);
      const off = () => {};
      disposers.push(off);
      return off;
    },
  },
  logger: { info: () => {}, error: () => {} },
};
const dispose = await apply(ctx);
assert.equal(registered.length, EXPECTED.length, 'apply 注册的工具数量不对');
assert.equal(typeof dispose, 'function');
pass('apply(ctx) 注册链路 OK');

// ── 3. 状态文件 ─────────────────────────────────────────────
const statusFile = join(dataDir, 'plugin-load.json');
assert.ok(existsSync(statusFile), 'plugin-load.json 没写出来');
const status = JSON.parse(readFileSync(statusFile, 'utf8'));
assert.equal(status.ok, true);
assert.deepEqual(status.tools, EXPECTED);
pass(`plugin-load.json OK（${statusFile}）`);

// ── 4. 真浏览器：status / read ──────────────────────────────
const statusTool = tools.find((t) => t.name === 'wx135_status');
const statusResult = await statusTool.execute({ launch: true });
assert.ok(statusResult.data, 'status 没有 data');
assert.ok(statusResult.data.browser, 'status 没有 browser 字段');
console.log('\n--- wx135_status ---');
console.log(statusResult.text.slice(0, 1600));

const readTool = tools.find((t) => t.name === 'wx135_read');
const readResult = await readTool.execute({ save: true });
assert.ok(readResult.data?.state?.ok, 'wx135_read 没读到正文');
assert.ok(readResult.data.backupPath && existsSync(readResult.data.backupPath), '备份文件没落盘');
console.log('\n--- wx135_read ---');
console.log(readResult.text.slice(0, 800));

pass('真浏览器 status / read / 备份 OK');

console.log(`\n全部通过。临时数据目录：${dataDir}`);
process.exit(0);
