/**
 * syntax.mjs — 无浏览器、无 DSH 的静态自检（CI / 同学改完代码先跑这个）：
 *   1. 所有模块能 import（语法/路径错误会直接炸）
 *   2. createTools 产出 11 个工具，且形状符合宿主约定
 *      （parameters 是「名→schema」映射，不是完整 JSON Schema；output.schema 才是）
 *   3. apply(ctx) 注册链路跑通（用 test/fake-dsh-tools.mjs 替身 + 假 ctx）
 *   4. plugin-load.json 状态文件正常写出
 *
 * 运行：node test/syntax.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const root = join(testDir, '..');

// 状态/备份/产物写到临时目录，别污染 ~/.dsh
process.env.WX135_DATA_DIR = mkdtempSync(join(tmpdir(), 'wx135-syntax-'));
process.env.DSH_TOOLS_PATH = join(testDir, 'fake-dsh-tools.mjs');

const importFrom = (rel) => import(pathToFileURL(join(root, rel)).href);

// 1) 所有模块能 import
const coreModules = [
  'cdp', 'browser', 'paths', 'editor', 'capture', 'template',
  'sandbox', 'atlas', 'compose', 'footer', 'upload', 'finish', 'imagesize',
];
for (const name of coreModules) {
  await importFrom(join('src', 'core', `${name}.js`));
  console.log(`PASS  import src/core/${name}.js`);
}
const toolsModule = await importFrom(join('src', 'tools.js'));
await importFrom(join('src', 'index.js'));
console.log('PASS  import src/tools.js, src/index.js');

// 2) 工具形状
const EXPECTED = [
  'wx135_status', 'wx135_read', 'wx135_shot', 'wx135_eval',
  'wx135_write', 'wx135_template', 'wx135_save', 'wx135_preview',
  'wx135_upload', 'wx135_compose', 'wx135_finish',
];
const tools = toolsModule.createTools((spec) => spec);
assert.equal(tools.length, EXPECTED.length, `工具数量应为 ${EXPECTED.length}`);
assert.deepEqual(tools.map((t) => t.name), EXPECTED);
for (const t of tools) {
  assert.ok(t.description && t.description.length > 20, `${t.name} 缺 description`);
  assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
  assert.ok(t.parameters && typeof t.parameters === 'object', `${t.name} 缺 parameters`);
  assert.equal(t.parameters.type, undefined, `${t.name} 的 parameters 不该是完整 JSON Schema`);
  assert.ok(t.output?.schema && typeof t.output.render === 'function', `${t.name} 缺 output`);
}
console.log(`PASS  ${tools.length} 个工具定义形状正确`);

// 3) apply 注册链路
const { apply } = await importFrom(join('src', 'index.js'));
const registered = [];
const ctx = {
  tools: { register: (def) => { registered.push(def); return () => {}; } },
  logger: { info: () => {}, error: () => {} },
};
const dispose = await apply(ctx);
assert.equal(registered.length, EXPECTED.length, 'apply 注册数量不对');
assert.equal(typeof dispose, 'function');
console.log('PASS  apply(ctx) 注册链路');

// 4) 状态文件
const statusFile = join(process.env.WX135_DATA_DIR, 'plugin-load.json');
assert.ok(existsSync(statusFile), 'plugin-load.json 没写出来');
const status = JSON.parse(readFileSync(statusFile, 'utf8'));
assert.equal(status.ok, true);
assert.deepEqual(status.tools, EXPECTED);
console.log('PASS  plugin-load.json');

console.log('\n全部通过（无浏览器静态自检）。真浏览器端到端：node test/smoke.mjs');
