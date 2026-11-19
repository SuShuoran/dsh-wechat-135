/**
 * roles.mjs — 槽位语义判定（roles.js）的离线回归。
 *
 * 不需要浏览器、不需要 135：fixture 里存的是「模板形状」（字号/字重/底色/块结构），
 * 文字是占位示例。真实模板端到端请看 README 里的「角色判定校准」一节。
 *
 * 运行：node test/roles.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const { classifyEntries, applyStructuralRoles, summarizeRoles, ROLE_RULES_VERSION } =
  await import(pathToFileURL(join(root, 'src/core/roles.js')).href);

const pass = (label) => console.log(`PASS  ${label}`);

// ── 1. 单条规则 ─────────────────────────────────────────────
const one = (over) => {
  const entries = [{ id: 0, text: 'x', fontSize: 14, fontWeight: 400, textAlign: 'left', hasBgHighlight: false, blockIndex: 0, ...over }];
  return classifyEntries(entries)[0].role;
};
assert.equal(one({ text: '甲乙丙丁', fontSize: 32 }), 'title', '≥22px 应判大标题');
assert.equal(one({ text: 'SAMPLE TITLE', fontSize: 14 }), 'label', '纯英文应判编号/英文副标');
assert.equal(one({ text: '壹', fontSize: 16, hasBgHighlight: true }), 'label', '中文序号应判编号');
assert.equal(one({ text: '03', fontSize: 16 }), 'label', '阿拉伯序号应判编号');
assert.equal(one({ text: '分节标题', fontSize: 16, fontWeight: 700 }), 'subtitle', '16px 加粗短句应判分节标题');
assert.equal(one({ text: '一行居中的短标语', fontSize: 14, textAlign: 'center' }), 'subtitle', '居中短句应判分节标题');
assert.equal(one({ text: '这是一段很长的正文段落，长度超过三十个字，用来确认长文本不会被误判成标题。', fontSize: 16, fontWeight: 700 }), 'text', '长文本即使是 16px 加粗也应判正文');
assert.equal(one({ text: '荧光笔高亮短句', fontSize: 14, textAlign: 'center', hasBgHighlight: true }), 'decor', '高亮底短句应判装饰文字');
pass('单条规则：title / label / subtitle / decor / text');

// ── 2. 重复出现 → 装饰标语 ─────────────────────────────────
{
  const entries = ['示例装饰标语', '正文甲', '示例装饰标语', '正文乙', '示例装饰标语'].map((text, i) => ({
    id: i, text, fontSize: i % 2 ? 14 : 14, fontWeight: 400, textAlign: i % 2 ? 'justify' : 'center',
    hasBgHighlight: i % 2 === 0, blockIndex: i,
  }));
  const c = classifyEntries(entries);
  for (const i of [0, 2, 4]) assert.equal(c[i].role, 'decor', '重复 ≥2 次应判装饰');
  assert.equal(c[1].role, 'text');
  assert.equal(c[3].role, 'text');
}
pass('重复标语 → decor（本次「蓄力启航，奔赴新章」那类问题的根因）');

// ── 3. 结构修正：同块多个 subtitle → subhead ───────────────
{
  const entries = [
    { id: 0, text: '分节标题甲', fontSize: 16, fontWeight: 700, textAlign: 'left', blockIndex: 3 },
    { id: 1, text: '条目一', fontSize: 16, fontWeight: 700, textAlign: 'left', blockIndex: 5 },
    { id: 2, text: '条目二', fontSize: 16, fontWeight: 700, textAlign: 'left', blockIndex: 5 },
    { id: 3, text: '条目三', fontSize: 16, fontWeight: 700, textAlign: 'left', blockIndex: 5 },
  ];
  const c = applyStructuralRoles(entries, classifyEntries(entries));
  assert.equal(c[0].role, 'subtitle', '独占一块的标题应保留分节标题');
  for (const i of [1, 2, 3]) assert.equal(c[i].role, 'subhead', '同块成排的短标题应降级为小标题');
}
pass('结构修正：分节标题 vs 块内小标题');

// ── 4. 模板形状 fixture（模拟「秋季开学通知」这类模板） ─────
{
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures/tpl-notice.entries.json'), 'utf8'));
  const entries = fixture.entries;
  const classified = applyStructuralRoles(entries, classifyEntries(entries));
  const roleOf = (id) => classified.find((c) => c.id === id).role;
  const stats = summarizeRoles(classified);

  // 大标题两行
  assert.equal(roleOf(0), 'title');
  assert.equal(roleOf(1), 'title');
  // 头部：英文副标 + 栏目名
  assert.equal(roleOf(2), 'label');
  assert.equal(roleOf(3), 'subtitle');
  // 导语 = 正文
  assert.equal(roleOf(4), 'text');
  // 三个分节头：编号 / 标题 / 英文 / 装饰标语
  for (const [num, title, en, slogan] of [[5, 6, 7, 8], [13, 14, 15, 16], [22, 23, 24, 25]]) {
    assert.equal(roleOf(num), 'label', `第 ${title} 节编号`);
    assert.equal(roleOf(title), 'subtitle', `第 ${title} 节标题`);
    assert.equal(roleOf(en), 'label', `第 ${title} 节英文副标`);
    assert.equal(roleOf(slogan), 'decor', `第 ${title} 节装饰标语`);
  }
  // 卡内条目成排出现 → subhead（不是分节标题）
  for (const id of [9, 11, 12, 17, 18, 19, 20, 21, 26, 27, 28]) {
    assert.equal(roleOf(id), 'subhead', `条目 ${id} 应是小标题`);
  }
  // 统计口径
  assert.equal(stats.title, 2, '大标题应为 2');
  assert.equal(stats.decor, 3, '装饰标语应为 3');
  assert.equal(stats.subtitle, 4, '分节标题应为 4（含头部栏目名）');
  assert.ok(stats.subhead >= 10, `小标题应 ≥10，实际 ${stats.subhead}`);
  assert.equal(stats.label, 7, '编号/英文副标应为 7（头部 1 + 三节各 2）');
  assert.equal(stats.text, 2, '正文应为 2');

  // compose 找分节的口径：只数「正文之后」的 subtitle 块 → 应恰好 3 节
  const firstTextBlock = Math.min(...entries.filter((e, i) => classified[i].role === 'text').map((e) => e.blockIndex));
  const sectionHeadBlocks = [...new Set(
    entries.filter((e, i) => classified[i].role === 'subtitle' && e.blockIndex >= firstTextBlock).map((e) => e.blockIndex),
  )];
  assert.equal(sectionHeadBlocks.length, 3, 'compose 应识别出 3 个分节');
}
pass('模板形状 fixture：3 节 / 装饰 3 / 条目降级正确');

// ── 5. 空值与边界 ─────────────────────────────────────────
assert.deepEqual(classifyEntries([]), []);
assert.deepEqual(applyStructuralRoles([], []), []);
assert.equal(ROLE_RULES_VERSION >= 2, true);
pass('空输入与版本号');

console.log('\n全部通过（roles 离线回归，无需浏览器）。');
