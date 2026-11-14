# dsh-wechat-135 · 变更记录

## v0.2.0（2026-11-14 夜）— 排版工作流

用户拍板后（DSH 插件 / 排版工作流 / 文字+实拍全删只留装饰 / 固定尾部 / 署名只变网络编辑 /
素材走聊天 / 图片自动排 / 原稿不改字 / 快速保存+预览二维码），实现：

- 新增工具：`wx135_upload`（本地图→135 图床）、`wx135_compose`（框架+plan.json→整篇 HTML）、
  `wx135_finish`（快速保存+预览链接+二维码 PNG）。共 11 个工具。
- `wx135_template`：新增 `photoMode`（anchor=不可见锚点 / placeholder=演示占位）与
  `trimFooter`（删模板自带尾部）；analyze 增加「标题可编辑性」检查（titleLeaves）。
- `cleanTemplate` 返回槽位统计（大标题/小标题/正文/照片锚点）。
- 固定尾部：`assets/footer-red.html`（红金）、`assets/footer-blue.html`（蓝白），
  `{{NETWORK_EDITORS}}` 占位；二维码素材 `assets/footer/*.jpg`。
- `compose` 排版引擎 v0.2：标题/副标题/导语/分节/正文填充、正文 14px/1.75/2px/首行缩进、
  图片按宽高比全宽或两两一行、分节数量自动克隆/删除、来源行 + 固定尾部。
- 页面上下文改用「135 同源」思路验证过（图床/微信图热链在沙箱里可能不显示，最终以 135 预览为准）。
- 新增 `WORKFLOW.md`（agent 操作手册）与 `test/smoke.mjs`（11 工具注册 + 真浏览器读写 + 备份）。

### 实测

- upload：本地图 → `bexp.135editor.com/...?auth_key=...` 成功。
- finish：快速保存捕获 `POST /wx_msgs/save/<msgId>`；预览地址生成；预览二维码 PNG 落盘成功。
- compose：编辑器模板清空成框架 + 一篇真实稿件文字 + 本地图片 → 文本顺序、section 平衡、图片落位正确。

### 已知限制

- 模板大标题必须是**可编辑文字**；标题是图片的模板（如蓝白论坛模板）换不了标题 → analyze 会提示。
- 槽位映射是启发式的，需要用户真实模板校准。
- 沙箱预览里图床图片可能不显示（热链），最终验收以 135 预览页为准。
