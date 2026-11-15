# dsh-wechat-135 — 在 135 编辑器里生产公众号推文

[![CI](https://github.com/SuShuoran/dsh-wechat-135/actions/workflows/ci.yml/badge.svg)](https://github.com/SuShuoran/dsh-wechat-135/actions/workflows/ci.yml)

> **本仓库面向西北农林科技大学理学院 融媒体部 / 同学内部共享**。
> 里面包含学院公众号「理学新苑」的固定尾部样式与四审署名，请不要外传或用于其他公众号。

给 DSH（DeepSeek Harness）用的插件（v0.3.0）：把「135 编辑器 + 微信公众号排版」这条链路变成
agent 可调用的工具。不依赖任何 npm 包，浏览器操作全部走本机 Chrome DevTools Protocol（CDP）。

> 为什么不是「135 编辑器插件」：135 的开放平台是让企业把 135 编辑器**嵌进自家系统**
> （企业插件 / 外部调用 / 用户互联），没有面向 135editor.com 页面的第三方插件入口。
> 所以本插件的形态是：**你/制作者照旧在 135 里选模板，agent 通过调试通道去读写它**。

## 给同学的安装 / 使用

需要：Windows + Node.js 20+ + [DSH](https://github.com/deepseek-ai)（或直接用仓库里的 CLI 脚本）。

1. **登录 135**：双击 `scripts/launch-debug-browser.cmd`，在打开的 Edge 窗口里扫码登录 135 账号。
   （这个窗口要一直开着；登录态存在独立 profile `%USERPROFILE%\.dsh\wechat-135\browser`，只登一次）
2. **装进 DSH**：把本目录放到工作区，然后用 `plugin_manager install_bundle`（target=本目录绝对路径）；
   重启 DSH 后 agent 就有 11 个 `wx135_*` 工具。
3. **不想装 DSH 也能用**：直接跑 CLI，例如
   `node bin/wx135.mjs status`、`node bin/wx135.mjs read --save`、`node bin/wx135.mjs analyze`。
4. 完整排版流程见 [WORKFLOW.md](./WORKFLOW.md)。

## 已实现的工具（11 个）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `wx135_status` | 检查浏览器调试端口、标签页、编辑器正文状态 | 端口没起会自动拉起专用 Edge（独立 profile，135 只登录一次） |
| `wx135_read` | 读正文摘要（字数/图片数/section 平衡/首尾文字），可落盘备份 | 改稿前先读一次 |
| `wx135_shot` | 把编辑器正文 / 页面 / 视口截成分屏 PNG | 430 宽 × 1400 高逐屏滚，避免长图截图失败 |
| `wx135_eval` | 在指定标签页执行 JS | 排查/取数用，**写正文请走 `wx135_write`** |
| `wx135_write` | 把本地 HTML 文件整体写入正文 | **先自动备份**，写完立即回读校验 |
| `wx135_template` | 模板解析 / 清空（analyze / clean） | 见下节 |
| `wx135_save` | 点「快速保存」/「保存同步」 | 监听网络请求确认保存真的发出去了 |
| `wx135_preview` | 打开「预览分享」取临时预览地址 + 二维码地址 | 约 1 小时有效 |
| `wx135_upload` | 本地图片上传到 135 图床 | 返回 bexp URL（带时效，尽快写回） |
| `wx135_compose` | **排版合成**：框架 + plan.json → 整篇 article.html | 自动传图、填文字、排图片、拼固定尾部；不写编辑器 |
| `wx135_finish` | 快速保存 + 预览链接 + **预览二维码 PNG** | 收尾一步到位 |

> 完整流程见 [WORKFLOW.md](./WORKFLOW.md)；plan.json 格式见那里第 3 节。

## 模板解析 / 清空怎么做的

1. **analyze**：在编辑器页面的真实 DOM 里解剖模板
   - 顶层块结构、section 开闭是否平衡、SVG / 绝对定位布局数量
   - 文字叶子清单 + 字号/颜色/行距画像（套版按这个画像还原文字样式）
   - **标题可编辑性**（≥20px 文字叶数量）：为 0 说明大标题是图片/图形，换标题得换图，
     这种模板不适合"一篇模板反复写不同标题"的工作流，会直接提示换模板
   - 图片清单：素材域名（`bcn.135editor.com` 装饰素材 / `bexp.135editor.com` 上传图 / mmbiz 图床）、
     原始尺寸、渲染尺寸、格式，并给一个「实拍候选」初判
   - **图片总览图**（`images-atlas.png`）：把所有图片渲染成带 `#序号` 的拼图。
     135 模板里的示例模特照和装饰图在同一个素材域名下，**必须目视确认**再决定删哪些。
2. **clean**：把正文 HTML 复制到**沙箱标签页**里清理（不碰编辑器）
   - 实拍图 → **不可见锚点**（compose 时填新图；视觉上等于删干净）
   - 文字 → 按字号换槽位占位符：`【大标题】`（≥22px）/`【小标题】`（≥17px）/`【正文】`
   - 模板自带的尾部（END/网络编辑/数小理…）→ 删掉，后面拼固定尾部
   - 装饰图、标题条、SVG 手工布局、section 骨架全部保留
   - 输出：`frame.html` + 槽位统计 + 逐屏截图，供 agent 目视检查
3. 清空结果满意后，用 `wx135_write` 把合成好的 `article.html` 写回编辑器（自动备份）。

## 排版规则（v0.3）

合成时按这些规则自动处理（详见 [WORKFLOW.md](./WORKFLOW.md) 第 3 节）：

- **正文**：14px / 行距 1.75 / 字距 2px / 首行缩进 2em；深色底自动换白字（可用 `plan.textColor` 覆盖）
- **标题**：内文大标题按模板槽位填；模板有"编号槽位"时 `sections[].label`（`PART.01`/`01`/`一、`）自动填
- **图片**：宽高比 ≥1.5（合影/全景）单张全宽；3 张竖图一行三张；其余两两一行；落单 92%
- **图注**：`images` 写成 `{ url, caption }`，图下自动加灰色小字（现场照片"谁在做什么"）
- **条目**：`sections[].items` 自动编号（通知/须知类）；`subsections` 支持"二级小标题 + 条目"
- **结构自适应**：模板分节不够时克隆最后一节，多了整段删除

三种常见体裁（活动预告 / 活动回顾 / 通知须知）的结构模板见 WORKFLOW.md。

## 数据目录

默认 `$DSH_HOME/wechat-135/`（Windows 即 `C:\Users\<你>\.dsh\wechat-135\`）：

```
browser/    专用浏览器 profile（135 登录态）
backups/    每次写编辑器前的正文备份（xxx_LATEST.html 是最新一份）
out/        截图、分析报告、清空后的 frame.html
```

环境变量覆盖：`WX135_CDP_HOST`（默认 `http://127.0.0.1:9333`）、`WX135_DATA_DIR`、
`WX135_PROFILE_DIR`、`WX135_BROWSER_PATH`。

## 本地开发 / 自测（不用装进 DSH）

```powershell
cd <本仓库目录>
node bin\wx135.mjs status
node bin\wx135.mjs read --save
node bin\wx135.mjs analyze
node bin\wx135.mjs shot --mode editor --max 6
node bin\wx135.mjs demo <某个模板.html> --out <输出目录>
```

`demo` 会把模板灌进沙箱页，跑「分析 → 清空 → 前后截图」，用来验证清空逻辑。

## 固定尾部（`assets/`）

- `footer-red.html`：红金延安风（从已发布的延安行文章提取）
- `footer-blue.html`：蓝白通用风（从编辑器草稿提取）
- 文案、权益小信箱/数小理树洞二维码、END、理学院、四审署名都在里面；
  只有「网络编辑」名单用 `{{NETWORK_EDITORS}}` 占位，合成时替换。
- 新增样式：从同类已发布文章里把尾部块（数小理文案 + 二维码 + END + 署名）提取出来，
  存成 `assets/footer-<名字>.html` 即可；`listFooterStyles()` 会自动发现。

## 135 编辑器的接口事实（踩坑记录）

- 正文在 UEditor iframe（`#ueditor_1`）里；`UE.getEditor('ueditor_1').setContent()` 返回成功但**什么都不写**，
  必须直接写 `iframe.contentDocument.body.innerHTML` 再派发 `input` 事件。
- 保存是 `POST /wx_msgs/save/<msgId>`；保存按钮常被 `.modal-backdrop` 遮挡，要先清遮罩再用**物理鼠标事件**点。
- 预览地址只在打开「预览分享」面板后生成：`img[src*="/tools/qrcode"]` 的 `uri=` 参数就是预览 URL。
- 多标签页很常见：**必须按内容特征选标签页**，写完回读校验。

## 安全红线

1. 写编辑器前必备份（`wx135_write` 已内置），改稿优先生成新文件再整段写。
2. 模板里的装饰图不能按 URL 猜——先看总览图。
3. 清空/套版默认在沙箱页做，**绝不直接改用户正在编辑的正文**。
4. 内容纪律：只用用户给的稿子和图片，不编造数字、电话、承诺。

## 安装进 DSH 之后怎么验证

- 新开一个会话/重启 DSH 后 agent 就有 11 个 `wx135_*` 工具（会话开场时工具表已定，旧会话看不到新工具是正常的）。
- 加载结果会写到 `~/.dsh/wechat-135/plugin-load.json`（`ok` + 工具名列表），出问题先看它。
- 改了插件源码后 dev 流程：`plugin_manager` 关掉再打开 bundle（不需要重启）；**替换已安装包**才需要重启。

## 自测

```powershell
cd <本仓库目录>
node test\smoke.mjs
```

覆盖：11 个工具定义形状 → `apply(ctx)` 真实注册链路（`test/fake-dsh-tools.mjs` 替身）→
`plugin-load.json` → 真浏览器上的 `wx135_status` / `wx135_read` / 备份落盘。

## v0.1 实测（2026-11-14）

- 环境：135 账号已登录；`wx135_status` 能识别标签页里的编辑器，并读到当前草稿的字数/图片数/section 平衡。
- 模板清空演示（开发期做过：拿一套带示例模特照的 135 模板，analyze 生成图片序号总览，
  人工挑出示例照片 → clean 后照片变占位、文字变【大标题】/【小标题】/【正文】槽位，
  section 保持平衡、装饰与 SVG 手工头图全部保留；截图未随仓库提供）。
- 图片自动分类保守策略已验证：`bcn.135editor.com` 的示例照片不会被自动删（会误删装饰），
  所以流程是「出总览图 → 人工/agent 确认 → 按 index 删」，`bexp.135editor.com`（上传图）与 mmbiz 图床会高置信度命中。

## v0.2 实测（2026-11-14 夜）

- `wx135_upload`：本地图上传 135 图床成功（解析 135 的 `postMessage` 包裹响应）。
- `wx135_finish`：快速保存（捕获 `POST /wx_msgs/save/<msgId>`）+ 预览分享链接 + 预览二维码 PNG 全通。
- `wx135_compose`：用编辑器里的模板清空成框架 + 一篇真实稿件文字 + 本地图片上传，合成结果：
  导语→分节→图片→结语→来源→固定尾部 顺序正确、section 平衡、图片按"全宽/两两一行"落位。
  已知限制：模板大标题若是图片（有些论坛模板就是）则换不了标题 → analyze 会给出 `titleLeaves` 提示换模板。

## 下一步（v0.3+）

- 用**真实模板 + 真实稿件**跑一遍全流程校准（槽位映射、图片节奏、尾部样式）。
- 模板档案：同一套模板复用「槽位标注」，第二次用就不用重新校准。
- 标题候选（3 个 `（）|（）`）由 agent 在对话里给；后续可加进 plan 校验。
- DSH 右侧「公众号」面板（Client 半侧，可选）：素材拖拽、进度、二维码预览。
- 把 `WORKFLOW.md` 固化成 skill，一次对话跑完整流程。

## 仓库结构

```
src/index.js         插件入口（注册工具 / 永不抛错的 apply）
src/tools.js         11 个工具的契约与实现
src/core/
  cdp.js             零依赖 CDP 客户端（Node 内置 WebSocket）
  browser.js         专用调试浏览器：探测 / 自动拉起 / 手动启动命令
  editor.js          135 正文读写（UEditor iframe 直写）、保存、预览二维码
  template.js        模板解剖 / 清空（槽位、照片锚点、trimFooter、标题可编辑性）
  compose.js         排版合成（模板框架 + plan.json → 整篇 HTML）
  capture.js         分屏截图（编辑器 / 普通页面）
  sandbox.js         沙箱标签页（清空/合成不碰编辑器）
  atlas.js           图片序号总览图（人工确认哪些是模板示例照片）
  footer.js          固定尾部加载（assets/footer-<style>.html）
  upload.js          本地图片 → 135 图床
  finish.js          快速保存 + 预览链接 + 二维码下载
  imagesize.js       图片头解析（PNG/JPEG/GIF/WEBP/BMP）
  paths.js           数据目录 / 浏览器路径解析
bin/wx135.mjs        本地 CLI（不装 DSH 也能用）
assets/footer-*.html 固定尾部（公众号专属素材，勿外传）
scripts/             一键启动调试浏览器
test/syntax.mjs      无浏览器静态自检
test/smoke.mjs       真浏览器端到端自检
```

## 许可证

MIT（见 [LICENSE](./LICENSE)）。内部共享：`assets/footer-*` 里的公众号二维码与四审署名
仅限「理学新苑」使用，请勿用于其他公众号或对外传播。

