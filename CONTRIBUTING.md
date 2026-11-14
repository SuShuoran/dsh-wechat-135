# 贡献 / 协作说明

本仓库用于理学院融媒体部内部协作：改排版规则、维护固定尾部、加新工具。

## 先跑一遍自检

```powershell
node test/syntax.mjs
```

不需要浏览器、不需要装 DSH。它会：检查所有模块能 import、11 个工具形状正确、
`apply(ctx)` 注册链路能跑通、`plugin-load.json` 能写出。

改了和浏览器交互的代码，再跑真浏览器端到端（需要先开调试浏览器）：

```powershell
node scripts/launch-debug-browser.cmd   # 或 scripts/launch-debug-browser.sh
node test/smoke.mjs
```

## 代码结构

- `src/tools.js`：工具契约 + 实现（新工具加在这里，并在 `test/syntax.mjs` 的 EXPECTED 里登记）
- `src/core/template.js`：模板解剖 / 清空（槽位、照片锚点、trimFooter）
- `src/core/compose.js`：排版合成（改排版规则主要看这里）
- `src/core/editor.js`：135 页面读写（UEditor iframe、保存、预览二维码）
- `WORKFLOW.md`：完整排版流程（改流程先改文档）

## 注意

- **不要提交本机信息**：本地路径、用户名、截图里的账号信息、token。运行时产物
  （截图/备份/浏览器 profile）默认写到 `~/.dsh/wechat-135/`，不在仓库里。
- `assets/footer-*` 里的公众号二维码与四审署名只用于「理学新苑」，不要挪去其他公众号。
- 改别人正在用的流程前先开分支 / 说一声；`main` 保持可运行（CI 会跑 `test/syntax.mjs`）。
