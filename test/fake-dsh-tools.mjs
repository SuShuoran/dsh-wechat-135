/**
 * fake-dsh-tools.mjs — 本地测试用的 `@deepseek-ai/dsh-tools` 替身。
 * 只实现 `defineTool(spec) => spec`，够把插件注册链路跑通。
 */
export function defineTool(spec) {
  return spec;
}
