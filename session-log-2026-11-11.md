# 会话整理：PDF + LLM 阅读器（demos/pdf-llm-reader）

> 整理范围：2026-11-09 15:38 — 2026-11-11 19:26（Asia/Shanghai）。
> 收录口径：聊天框内用户手动发出的 13 条文字提示词，按时间顺序编号；另把 1 条「目标模式」objective（自动续跑，不是聊天框手动输入）作为第 3 轮单列，故共 **14 轮**。界面选择、审批策略切换、计划模式切换不计为提示词，见附录。
> 忠实性：提示词原文来自会话记录。为避免把真实 API Key 写入仓库文件，第 4 轮消息中的 `sk-...` 已脱敏为 `sk-...（已脱敏）`，其余未改写；工作成果只记录已发生的实现、验证与证据，不补写未做内容。

## 目录

- [第 1 轮](#第-1-轮)
- [第 2 轮](#第-2-轮)
- [第 3 轮](#第-3-轮)
- [第 4 轮](#第-4-轮)
- [第 5 轮](#第-5-轮)
- [第 6 轮](#第-6-轮)
- [第 7 轮](#第-7-轮)
- [第 8 轮](#第-8-轮)
- [第 9 轮](#第-9-轮)
- [第 10 轮](#第-10-轮)
- [第 11 轮](#第-11-轮)
- [第 12 轮](#第-12-轮)
- [第 13 轮](#第-13-轮)
- [第 14 轮](#第-14-轮)
- [附录 A：界面选择与自动目标轮](#附录-a界面选择与自动目标轮)
- [附录 B：结论修正与演进](#附录-b结论修正与演进)

## 第 1 轮

### 为 PDF + LLM 阅读器 prompt 生成工作计划

**我的提示词**

```text
为以下prompt生成工作计划
"""
@/Users/Zhuanz/stirling-pdf/ 参考附件1 stirling-pdf这个开源项目的实现方式，为我搭建一个 PDF 阅读器，核心能力是内置可自定义的 LLM 问答。

先做分析：阅读 附件1 的源码，梳理其项目结构、技术栈、PDF 解析与渲染方式、构建与运行流程，并简要说明哪些设计可以沿用到新项目。

需要实现的功能：
- 基础阅读：打开本地 PDF，以及翻页、缩放等基本阅读能力。
- LLM 问答：针对当前打开的 PDF 提问并得到回答，回答必须基于文档内容；同时说明文本提取、上下文截断或分块的具体策略。
- 可自定义：模型与服务商、API Key / Base URL、提示词（system prompt）可在界面中配置并持久化保存。

约束：
- 把 附件1 当作学习对象，不要照搬；只借鉴架构与关键实现；若直接复用代码，需注明来源与许可证。
- 技术栈优先沿用 附件1；若要更换，先说明理由。
- 项目创建在 <项目目录> 下，LLM 通过 <LLM 服务与接口形式> 接入；密钥不要硬编码。
- 如果运行形态未指定，先给出「本地 Web 应用」与「桌面应用」两种方案的简短对比，由我选择，不要自行决定。

交付：可运行的完整代码MVP，以及 README（安装、配置、启动步骤，与 附件1 的异同说明），按 README 能一次跑通。
"""
```

**工作成果**

- 通读附件 1 `/Users/Zhuanz/stirling-pdf/`（v3.3.0-16-gd74543712c），梳理 monorepo（React 19 + Vite 7 + EmbedPDF/pdfjs 前端、Java Spring Boot 后端、Python engine、Taskfile/Tauri 构建）与 PDF 解析/渲染链路，并核对许可证边界：根目录 MIT，`app/proprietary/`、`app/saas/`、`engine/`、前端 `proprietary/desktop/saas/cloud` 等为独立许可证，不能直接复制。
- 通过界面确认两项选型：运行形态为「本地 Web 应用」，LLM 接入为「OpenAI 兼容接口」（`/v1/chat/completions`，Base URL 可配）。
- 在对话中交付完整工作计划：目标与验收标准、附件 1 可借鉴/不复制的设计、系统架构与 API、文本提取与 1000/150 分块 + 词法检索策略、grounded prompt 与 `[p.N]` 引用、设置持久化与密钥安全、里程碑 M0–M5、盲点与回退方案。
- 说明：本轮只提交计划，未创建 `plans/` 文档或 `demos/pdf-llm-reader/` 产品代码（实现从下一轮开始）。

## 第 2 轮

### 按计划实现 PDF + LLM 阅读器 MVP，并用 V4-relativity.pdf 验证

**我的提示词**

```text
@/Users/Zhuanz/Documents/Physics/V4-relativity.pdf执行既定计划，把 PDF + LLM 阅读器 MVP 从计划推进到可运行的实现，不要再产出一份新计划：代码落在 `demos/pdf-llm-reader/`，按 `plans/pdf-llm-reader/01-path.md` 的里程碑逐项完成，并用附件 1（V4-relativity.pdf）作为测试 PDF 实际运行验证。

按已确认的选型执行，不要重新选型：采用本地 Web 应用；React + Vite + TypeScript + pdfjs-dist 客户端渲染；在 Node 22+ 下执行 `npm install && npm run dev` 即可在 http://localhost:5173 打开；LLM 通过 OpenAI 兼容接口接入，模型、服务商、Base URL、API Key、system prompt 均可在界面配置并持久化，API Key 回显为掩码；密钥不硬编码、不写入日志，`.env` 与 `data/` 已 gitignore。只借鉴参考项目的页归属分块、页码证据、grounded system prompt 与 not_found 处理，不复制其代码（`proprietary/`、`engine/` 为独立许可证）；README 写明与参考项目的异同、许可证与致谢。OCR、向量库、多文档库、聊天记录持久化、桌面打包在 MVP 范围内不做。

用 V4-relativity.pdf 验收，并逐项给出证据（命令、输出、未通过的原因）：

- 打开后渲染第 1 页，翻页、页码跳转、50%–200% 缩放、适应宽度均可用；
- 就文档内事实提问，答案包含只存在于文档中的信息并带可点击的 `[p.N]`；问文档外内容时回答「未在文档中找到相关内容」；
- 修改服务商/Base URL/模型/API Key/system prompt 后刷新页面仍然生效；
- `npm test`、`npm run typecheck`、`npm run build`、`npm start` 全部通过；`grep -R "sk-"` 无命中；
- 按 README 在干净环境一次跑通。

需要真实 API Key 才能跑通时，向我索取，不要伪造调用结果；某项未通过就写清原因与下一步，不要用计划或伪代码代替实现。
```

**工作成果**

- 在 `demos/pdf-llm-reader/` 从零搭建并跑通 MVP：React/Vite/TypeScript/pdfjs-dist 前端 + Node 22/Express 后端；本地 PDF 打开与渲染、上一页/下一页、页码跳转、50%–200% 缩放、适应宽度。
- 实现文本提取、1000 字符/150 overlap 分块、TF-IDF 词法检索、grounded system prompt、`[p.N]` 引用与文档外 `not_found`；设置界面可配置服务商/模型/Base URL/API Key/system prompt，保存到 `DATA_DIR/settings.json`（0600），API Key 只回传掩码。
- 验收测试用 V4-relativity.pdf 时发现它是 286 页纯图片扫描件、无文字层（`numPages:286, nonEmpty:0, totalChars:0`），只能验证阅读；问答链路改用本机 mock OpenAI 兼容服务 + 现场生成的 3 页文字 PDF 验证，未伪造真实调用。
- 补齐单测、E2E（设置持久化、扫描件阅读、文字 PDF 问答/引用/not_found）、`npm run typecheck`、`npm run build`、生产启动与 README/NOTICE/MIT LICENSE；密钥样式扫描无命中。
- 真实服务商调用因环境无 API Key 未执行；多轮目标模式中保持 active、后按政策标记 blocked 并向用户索取 Key。

## 第 3 轮

### 目标模式：自动 OCR、文本 PDF 转换、方向键翻页、双指捏合

**我的提示词**

```text
在 `demos/pdf-llm-reader/` 的现有实现上直接新增并实测以下四个功能，不要另出一份计划：\n\n- 自动 OCR 扫描件文字，可以使用光标编辑：打开没有文字层的 PDF 时自动识别当前页，识别出的文本可选中、可点击定位光标、可编辑和复制；翻页返回后，编辑内容仍然保留；如果持久化方式还没确定，就说明当前的行为。\n- 将整个 PDF 转换成文本 PDF 格式：提供「只转换准确度高的页面」和「全部强制转换」两种模式，导出带文字层的 PDF；高准确度阈值 `<置信度阈值>` 以及判定与默认值，请说明依据。\n- 键盘左右箭头切换页面：焦点在输入框、聊天框或页码框时不触发，避免与文字编辑冲突。\n- 双指操控放大 PDF 页面，不影响 LLM 侧栏：缩放只作用于 PDF 页面区域，侧栏的字号和布局保持不动。\n\n沿用已确认的选型（本地 Web 应用、React + Vite + TypeScript + pdfjs-dist、Node 22+ 下 `npm install && npm run dev`、OpenAI 兼容接口），不新增 JDK/Python/Docker/Rust 运行时依赖；密钥不硬编码、不写入日志。原 MVP 把 OCR 列为不做，本次由这些新增功能覆盖该边界。\n\n验收：用 附件 1（V4-relativity.pdf）实际运行；逐项给出命令、输出与截图，回归 `npm test`、`npm run typecheck`、`npm run build` 均通过；OCR 后该扫描件应能正常问答并带可点击的 `[p.N]`，文档外问题仍答「未在文档中找到相关内容」。需要真实 API Key 才能验证真实调用时向我索取，不要伪造结果；未通过项写清原因与下一步。
```

> 注：目标模式 objective 在会话记录中以 `\n` 转义换行保存，以上为原样；语义上对应分段提示词。

**工作成果**

- 说明：该 objective 由目标模式自动续跑（Round 1/256–8/256，内容相同），不是聊天框手动输入；按时间插在本轮。
- 修复 pdfjs 6 扫描件渲染：本地化 `wasm/cmaps/standard_fonts` 并在 `getDocument` 传 `wasmUrl` 等参数后，V4 第 1 页 CONTENTS 正常显示。
- 实现扫描件自动 OCR 与可编辑文本：tesseract.js 浏览器 worker + 本地 eng/chi_sim 资产；无文字层 PDF 自动识别当前页，文本可选中/编辑/复制，翻页后编辑保留；编辑经 700ms 防抖 `PATCH /api/documents/:id/pages` 同步索引，刷新后不保留（README 已写明）。
- 实现整本转文本 PDF：high（仅高准确度页）/ all（全部强制）两种模式；默认阈值 80，判定为「平均行置信度 ≥ 80 且有效字符 ≥ 20 且低置信行(<60)占比 ≤ 30%」；V4 第 31–40 页 high 写入 6/10、all 写入 10/10，整本分批 high 合并后 117/286 页、194,191 字符（`artifacts/V4-text.pdf`）。
- 实现方向键翻页（焦点在输入框/聊天框/页码框/OCR 编辑框/设置与导出弹窗时不触发）与双指捏合缩放（仅 PDF 画布区域，侧栏字号布局不变）；回归 E2E 4 passed (24.7s)、单测 75、typecheck/build、`verify:prod` 均通过。

## 第 4 轮

### 提供 DeepSeek Key，选便宜模型做真实服务商验收

**我的提示词**

```text
deepseek api :sk-...（已脱敏） 模型名你来选便宜的 开始测试
```

**工作成果**

- 选择 DeepSeek 官方标准对话模型 `deepseek-chat`（非 reasoning 模型，成本更低，足够完成文档问答验收）。
- 通过环境变量运行 `npm run verify:real`（Key 不写入仓库/README/日志；本轮消息中的 Key 在本文档中已脱敏）：连通性测试 1186ms；V4 第 1 页自动 OCR 644 字符；文档内问题回答列出 CONTENTS 各章并逐项带 `[p.1]`，点击引用跳到第 1 页；文档外问题回答「未在文档中找到相关内容」。
- 证据：`artifacts/verify-real/real-llm-verification.json`（passed=true，不含 Key）、`docs/screenshots/real-llm-deepseek-answer.png`、`real-llm-deepseek-citation-click.png`、`real-llm-deepseek-not-found.png`。
- README 验收表把「真实服务商调用」从待提供 Key 更新为通过（2026-11-10）；`npm test` 75、typecheck、build 回归通过。

## 第 5 轮

### 现有 Web 应用打包桌面端需重写哪些逻辑、成本是否合适

**我的提示词**

```text
基于现有 `demos/pdf-llm-reader/` 实现来回答（React + Vite + TypeScript + pdfjs-dist 前端、Node 22+ 本地服务与 `npm install && npm run dev`、OpenAI 兼容接口、pdf.js WASM 与 OCR worker / eng.traineddata 由服务端托管、文档与设置存在本地 `DATA_DIR` / `data/settings.json`）：如果把这个 Web 应用打包成桌面应用，需要重写或改造哪些逻辑？成本上合不合适？

要求简短（一屏以内），每条给出具体改造做法，不要泛泛而谈：

- 本地 Node 服务：HTTP API、静态资产托管、端口占用与进程生命周期
- 文件与持久化：`DATA_DIR`、上传的 PDF、页面编辑同步（`PATCH /api/documents/:id/pages`）、设置存储
- 密钥与网络：LLM 调用如何避免密钥落进渲染进程或日志，以及跨域与 loopback 问题的处理
- pdf.js 与 OCR：worker、WASM、语言包在打包后的加载路径
- 交互层：方向键翻页、双指缩放、文字层编辑与导出文本 PDF，哪些需要重写
- 构建分发：打包方案（Electron 与 Tauri 各给适用场景与取舍）、包体积、自动更新、代码签名

最后给出成本判断：粗估工作量（人日区间）、一次性投入与长期维护成本、什么情况值得迁移、什么情况建议继续用本地 Web 应用。不确定的数字标明为估算并说明依据。不要写代码，不要改仓库文件。
```

**工作成果**

- 结论：Electron 路线主要是「改造 + 打包」，Tauri 路线需额外处理 Node 依赖；按现有代码桌面化一次性约 10–15 人日，是否值得取决于是否需要离线安装包与自动更新。
- 逐项给出改造做法：Express 放 Electron main/子进程并动态端口、单实例与退出清理；`DATA_DIR` 改 userData 且文档索引需从内存 Map 落 SQLite/JSON；Key 继续由主进程/本地服务持有并处理 CORS 或自定义协议；pdfjs WASM 与 OCR worker/语言包改用 asar 解包路径或继续本地 HTTP 托管；方向键/捏合/OCR 编辑/pdf-lib 导出可复用，下载改原生保存框。
- 给出 Electron（包约 180–250MB）与 Tauri（壳 10–20MB，带 Node sidecar 约 60–100MB）的适用场景、签名/自动更新成本与「什么情况值得迁移」判断。
- 本轮只做分析问答，未写代码、未改仓库文件。

## 第 6 轮

### 新增刷新保留 PDF、对话存档、可缩小侧边栏三项改动

**我的提示词**

```text
在现有 `demos/pdf-llm-reader/` 实现上再新增三个小改动并实测通过，直接改代码，不要另出一份计划。

1. **刷新保留已打开的 PDF**：页面刷新后自动恢复上次打开的 PDF，不要回到空状态；持久化沿用现有本地存储（`DATA_DIR` / 设置存储），并说明记录保存在哪里、如何失效或清除。
2. **AI 对话存档**：对话记录持久化保存，刷新或重启后仍可回看，并说明存储位置、格式与清理方式；存档范围按 <单文档单条会话 / 多文档多会话列表> 实现。
3. **可缩小式侧边栏**：光标移动到侧边栏边缘时变为伸缩标志，按住拖动即可拉伸或收缩；侧边栏顶部提供一个按钮用于关闭侧边栏，关闭后能重新打开。

约束：沿用已确认选型（React + Vite + TypeScript + pdfjs-dist 前端、Node 22+ 本地服务、`npm install && npm run dev`、OpenAI 兼容接口），不新增 JDK/Python/Docker/Rust 运行时依赖；密钥不硬编码、不写入日志。不得回退已完成的功能：OCR 文本编辑、high/all 两种文本 PDF 转换、方向键翻页（焦点在输入框/聊天框/页码框时不触发）、双指缩放仅作用于 PDF 区域且不改变问答栏字号与布局——侧边栏拖拽与开合后这些行为仍需正常。

验收：用 附件 1（V4-relativity.pdf）实际运行，逐项给出命令、输出与截图（存 `docs/screenshots/`），「刷新保留」需有刷新前/后对比证据；回归 `npm test`、`npm run typecheck`、`npm run build` 全部通过；同步更新 README 与已知限制。未通过项写清原因与下一步。
```

**工作成果**

- 开始实现：后端新增 `server/persistence.ts`（SessionStore/ChatStore）、`library/<docId>.pdf|json` 文档持久化与 `/api/session`、文档文件/页文本/chat 相关路由；前端加入恢复会话、对话存档与侧边栏拖拽/开合状态。
- 本轮用于推进实现与联调，未在轮末给出完整交付答复；下一轮用户要求继续完成并验收。

## 第 7 轮

### 继续完成三项改动并严格验收

**我的提示词**

```text
继续推进本会话中 `demos/pdf-llm-reader/` 的三个新增改动：直接在现有实现上改代码并实测通过，不要另出一份计划。动手前先检查当前工作区、工具结果和会话状态，以实际代码与可运行结果为准，不要假设此前的叙述仍然成立。

三项改动：

1. **刷新保留已打开的 PDF**：页面刷新后自动恢复上次打开的 PDF，不要回到空状态；持久化沿用现有本地存储（`DATA_DIR` / 设置存储），并说明记录保存在哪里、如何失效或清除。
2. **AI 对话存档**：对话记录持久化保存，刷新或重启后仍可回看，并说明存储位置、格式与清理方式；存档范围按 <单文档单条会话 / 多文档多会话列表> 实现。
3. **可缩小式侧边栏**：光标移动到侧边栏边缘时变为伸缩标志，按住拖动即可拉伸或收缩；侧边栏顶部提供一个按钮用于关闭侧边栏，关闭后能重新打开。

约束：沿用已确认选型（React + Vite + TypeScript + pdfjs-dist 前端、Node 22+ 本地服务、`npm install && npm run dev`、OpenAI 兼容接口），不新增 JDK/Python/Docker/Rust 运行时依赖；密钥不硬编码、不写入日志。不得回退已完成的功能：OCR 文本编辑、high/all 两种文本 PDF 转换、方向键翻页（焦点在输入框/聊天框/页码框时不触发）、双指缩放仅作用于 PDF 区域且不改变问答栏字号与布局——侧边栏拖拽与开合后这些行为仍需正常。

验收：用 附件 1（V4-relativity.pdf）实际运行，逐项给出命令、输出与截图（存 `docs/screenshots/`），「刷新保留」需有刷新前/后对比证据；回归 `npm test`、`npm run typecheck`、`npm run build` 全部通过；同步更新 README 与已知限制。未通过项写清原因与下一步。需要真实 API Key 才能验证的项向我索取，不要伪造结果；收尾前汇总证据，声称完成前核对三项改动与全部回归项均已闭环。
```

**工作成果**

- 完成三项改动并交付：刷新后恢复上次 PDF、页码、缩放与 OCR 编辑文本；对话存档到 `DATA_DIR/chats/<docId>.json`（单文档单会话），可清空；侧边栏左边缘拖拽调宽（300–760px，`col-resize`）并可关闭/重新打开，宽度与开合状态存 localStorage。
- 验证：`npm test` 9 files / 84 tests、typecheck、build（dist-server 57.5KB）、`npx playwright test` 5 passed (41.5s)、`npm run verify:prod`；另做服务重启持久化实测（session/library/chat 均恢复）。
- 证据：`docs/screenshots/v4-restore-before.png`、`v4-restore-after.png`、`sidebar-resized.png` 等；README 与已知限制更新，源码密钥扫描无命中。

## 第 8 轮

### 环境变量应该写入哪个目录

**我的提示词**

```text
环境变量应该写入哪个目录？简短说明
```

**工作成果**

- 答复：写在项目根目录 `demos/pdf-llm-reader/.env`（或优先级更高的 `.env.local`），不写进 `data/`；加载顺序 `.env` → `.env.local`，后者覆盖前者。
- 支持变量：`HOST`、`PORT`、`DATA_DIR`、`LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY`；三个 `LLM_*` 会覆盖界面保存的配置，`DATA_DIR` 决定 `settings.json`、`library/`、`chats/` 的落盘位置。
- 说明也可只在界面「设置」配置，Key 会存入 `data/settings.json`（0600，不回传浏览器）。

## 第 9 轮

### 对话存档升级为多会话历史；转文字 PDF 文字层对齐

**我的提示词**

```text
在现有 `demos/pdf-llm-reader/` 实现上直接改代码并实测通过，不要另出计划。保留原有的「刷新保留侧边栏聊天记录」，并在该功能基础上新增以下两项：

1. **对话存档升级为多会话历史**
   - 刷新页面后自动开启一条新对话，旧对话自动归档，不再续写原会话。
   - 侧边栏增加二级菜单，可展开并打开任意一条历史对话记录回看。
   - 支持删除历史记录：删除后菜单列表与本地持久化存档同步清除。
   - 说明存档位置、格式（沿用 `DATA_DIR`）与清理方式。

2. **转文字 PDF 的文字层对齐**
   - 转文字 PDF 时，生成的不可见文字层需与原 PDF 可见文字的位置、行距、换行对齐，使选中、复制、搜索的框选范围与原文字重合。
   - 给出对齐证据：同一页原 PDF 与文字层的叠加对比截图或坐标核对结果。

约束：沿用已确认选型（React + Vite + TypeScript + pdfjs-dist 前端、Node 22+ 本地服务、`npm install && npm run dev`、OpenAI 兼容接口），不新增 JDK/Python/Docker/Rust 运行时依赖；密钥不硬编码、不写入日志。不得回退已完成功能：OCR 文本编辑、high/all 两种文本 PDF 转换、方向键翻页（焦点在输入框/聊天框/页码框/OCR 编辑框/设置与导出弹窗时不触发）、双指缩放仅作用于 PDF 区域且不改变问答栏字号与布局、侧边栏拖拽与开合。

验收：用 附件 1（V4-relativity.pdf）实际运行，逐项给出命令、输出与截图（存 `docs/screenshots/`），其中「刷新自动开启新对话 + 旧对话存档」需有刷新前/后对比证据；回归 `npm test`、`npm run typecheck`、`npm run build` 全部通过；同步更新 README 与已知限制。未通过项写清原因与下一步；需要真实 API Key 才能验证的项向我索取，不要伪造结果。
```

**工作成果**

- 多会话历史：存档改为 `DATA_DIR/chats/<docId>/<chatId>.json`（含 id/docId/title/messages/createdAt/updatedAt，标题取首条用户消息前 40 字，权限 0600）；刷新后自动开新对话、旧对话归档；侧边栏二级菜单可列出/打开历史、删除单条并同步删磁盘文件；新增 `/api/documents/:id/chats` 与 `/chats/:chatId` 接口。
- 文字层对齐：从 Tesseract `line.words[]` 取词级 bbox，逐词绘制 `opacity:0` 不可见文字，按词框映射 x/y、字号拟合行高、宽度约束、Helvetica descent 0.207 校正 baseline，词间补空格保证复制连续。
- 对齐证据：V4 第 1 页 107 个文字项，100/107 框内含墨、框内墨迹中位覆盖率 27.8%、质心平均偏移 1.56px；叠加统计 JSON 记录 `textBoxInkRatio` 0.6279、`pageInkRatio` 0.0193；叠加图 `docs/screenshots/text-layer-align-v4-p1-overlay.png`，坐标数据 `artifacts/verify/text-layer-alignment.json`。
- 回归：E2E 5 passed、单测 86、typecheck/build 通过；截图（`chat-history-list/view/deleted.png` 等）与 README/已知限制更新。

## 第 10 轮

### 解释侧边栏 LLM 问答中的「分层抽样」设计

**我的提示词**

```text
读取 `demos/pdf-llm-reader/` 侧边栏 LLM 问答功能的实际代码，向我解释其中「分层抽样」的设计逻辑。请以当前代码和实际运行结果为准，不要凭印象，也不要直接沿用此前对话中的叙述。如果代码里没有同名的实现，请指出真正对应的实现位置（文件和函数），并说明它与你所说的「分层抽样」有何差异；不要编造。

说明请覆盖以下几点：

1. 目的：在把文档内容送入 LLM 之前为什么要做抽样，不分层会带来什么问题（上下文长度、覆盖度、成本）。
2. 流程：从文档切分到最终成 prompt 的每一步，包括分层依据、每层取多少、如何排序和截断、相关参数与默认值。
3. 代码位置：涉及的文件、函数与关键常量，只简要引用关键几行，不要贴大段源码。
4. 取舍与局限：这种策略会漏掉什么、对回答质量和引用页码有什么影响、是否已写入 README 的已知限制。

输出时请用分点说明，并加一段整体流程描述，篇幅控制在一屏内能读完。
```

**工作成果**

- 按代码核实：项目中没有名为「分层抽样」的函数；UI 在 `src/components/ChatPanel.tsx:96` 把 `mode==='summary'` 显示为「分层抽样」。真正实现是 `server/retrieve.ts` 的 `selectSummaryChunks()`：首 2 块 + 尾 2 块固定，中段按块数等距抽样，受 contextChars 预算约束，最多 24 块。
- 解释触发条件（总结/全文类问题或无词面重叠回退）、完整链路（分块 1000/150 → 预算 → 模式判定 → 抽样/检索 → 拼 prompt → 引用回退）与参数默认值，并说明局限：首尾块先占预算，中段页可能漏；README 当时只写词法检索局限，未写该抽样偏差。
- 本轮只读代码与做实际运行说明，未改代码。
- 修正说明（后续轮次确认）：用户遇到的「分层抽样未命中」并非真实 UI 文案，而是页面问题被 `isSummaryQuestion()` 误判为 summary、抽样未含目标页导致 `notFound`；第 11 轮已通过页面意图识别修复。

## 第 11 轮

### 修复问某一页/某几页时拿不到对应页上下文的问题

**我的提示词**

```text
在 `demos/pdf-llm-reader/` 现有实现上直接改代码并实测通过，不要另出计划。目前有一个运行问题：根据附件截屏，当我询问某一页或某几页的具体内容时，LLM 没有拿到对应页的上下文，页面问答无法正确回答，反而显示「分层抽样未命中」。

请先按截屏复现，再以当前代码和实际运行结果为准，定位界面这个「分层抽样未命中」提示，以及页面问答链路的真实实现位置；不要凭印象，也不要直接沿用此前对话中的叙述。此前的结论可作线索：对应实现是 `server/retrieve.ts` 的 `selectSummaryChunks()`，它把首 2 块和尾 2 块固定选中，中段在 `[0, n-1]` 上等距抽样，而首尾常占满预算，导致中段页被漏掉；模式判定也在同文件，分块逻辑见 `server/chunk.ts`。定位清楚后，请识别我提问中的不同形式（例如单页、页码范围、章节或小节、页码加关键词等），并针对不同问法采用不同的上下文策略；对于带有页码的提问，优先走精确页检索，确保问到的页及其必要邻页一定进入上下文，同时在界面上说明本次使用的策略和选中的页。

约束：不新增 JDK、Python、Docker、Rust 等运行时依赖；密钥不硬编码、不写入日志；不得回退已完成功能（OCR 文本编辑、high/all 两种文本 PDF 转换、方向键翻页、双指缩放仅作用于 PDF 区域、侧边栏拖拽与开合、刷新后开新对话与多会话历史）。

验收：用 @"/Users/Zhuanz/Downloads/Looking for Alaska (John Green) (z-library.sk, 1lib.sk, z-lib.sk) (3).pdf" 实际运行，逐项给出命令、输出与截图（存 `docs/screenshots/`），至少覆盖单页、页码范围、总结三类问法；`npm test`、`npm run typecheck`、`npm run build`、`npx playwright test` 全部通过；同步更新 README 与已知限制。未通过项写清原因与下一步；需要真实 API Key 才能验证的项向我索取，不要伪造结果。先制定修改计划，不要动代码，不要做修改。
```

> 附件：该轮附带截图 `截屏2026-11-11 09.50.56.png`（Looking for Alaska 第 19 页与「未在文档中找到相关内容」对话）。

**工作成果**

- 先按用户要求进入 plan mode 只读复现并提交修改计划，计划获批后才改代码，未提前动代码。
- 根因：`isSummaryQuestion()` 先命中「讲了什么」，页面提问被当作总结问题；summary 抽样未包含第 18 页，模型按 grounding 规则返回 `notFound`。定位到 UI 的「分层抽样」只是 mode 展示，没有「未命中」字面文案。
- 新增 `server/pageIntent.ts`：解析单页、页码范围、页码列表（中英文 `第18页`/`第18-20页`/`pages 18-20`/`pp. 18, 19`/`p.18`）及章节（`第18章`/`Chapter 12`/`Section 2.3`/`§2.3`），页码优先；`server/retrieve.ts` 增加 `pages`/`chapter` 模式，在 full/summary 之前处理，目标页 + 前后各 1 邻页，最多 20 页/24,000 字符，超预算或越界给 note；`app.ts` 传 pageCount 并在 contextInfo 返回 requestedPages/requestedChapter/note；ChatPanel footer 显示「指定页/指定章节」、目标页/章节与截断说明。
- 验收：`npm test` 10 files / 109 tests、typecheck、build、`npx playwright test` 6 passed (41.0s)；真实 DeepSeek + 指定 `Looking for Alaska`（246 页）单页/范围/总结三问通过，证据 `artifacts/verify/page-intent-acceptance.json` 与 `docs/screenshots/page-intent-alaska-single/range/summary.png`；README/已知限制更新。

## 第 12 轮

### 向 README 加入如何停止进程的信息

**我的提示词**

```text
向README加入如何停止进程的信息。保持简短。
```

**工作成果**

- 在 `README.md`「常用命令」表下方加入两行：在运行 `npm run dev` / `npm start` 的终端按 `Ctrl+C`；残留进程用 `lsof -ti:5173,8787 | xargs kill`（macOS/Linux）。
- 随后停止了残留 dev server（SIGTERM，退出码 0），确认 5173/8787 端口空闲，并告知重启命令 `cd demos/pdf-llm-reader && npm run dev`。

## 第 13 轮

### 在问答输入框旁加 💪 增强提示词按钮

**我的提示词**

```text
在 `demos/pdf-llm-reader/` 现有实现上直接改代码并实测通过。

在侧边栏问答输入框旁加一个 💪（肱二头肌）符号按钮，代表「增强提示词」。用户点击这个按钮后，用当前模型（沿用已配置的 OpenAI 兼容接口与模型，密钥不硬编码、不写入日志）把用户正在输入的提问改写成更清晰、更具体的提示词，再把结果回填到输入框，由用户确认或编辑后自行发送；输入为空、请求处理中、调用失败都要有明确的界面反馈，调用失败时不得清空原输入。

约束：不新增 JDK、Python、Docker、Rust 等运行时依赖；不得回退已完成功能（OCR 文本编辑、high/all 两种文本 PDF 转换、方向键翻页、双指缩放仅作用于 PDF 区域、侧边栏拖拽与开合、刷新后开新对话与多会话历史、指定页和指定章节检索）。

验收：`npm test`、`npm run typecheck`、`npm run build`、`npx playwright test` 全部通过；给出实际运行命令、输出与截图（存 `docs/screenshots/`）；同步更新 README 与已知限制；未通过项写清原因与下一步，需要真实 API Key 才能验证的项向我索取，不要伪造结果。
```

**工作成果**

- 实现 `POST /api/enhance-prompt`（`server/enhancePrompt.ts` + `app.ts`）：复用当前 OpenAI 兼容配置与模型，把草稿改写为更清晰具体的提示词；`temperature 0.3`、`maxTokens` 上限 800、60s 超时，错误脱敏、空结果返回 502；请求只含草稿、文件名、当前页，不读文档正文。
- 前端在输入框旁新增 `💪 增强` 按钮与 `enhance-status` 状态：空输入提示、处理中禁用、成功回填且不自动发送、失败保留原输入并显示错误；`App.tsx` 传入文档名/当前页。
- 验证：`npm test` 11 files / 116 tests、typecheck、build（dist-server 80.3KB）、`npx playwright test` 7 passed (43.3s)；真实 DeepSeek 对「第18页讲了什么？」改写耗时约 1039ms 并回填，证据 `artifacts/verify/enhance-prompt-acceptance.json` 与 `docs/screenshots/enhance-prompt-deepseek.png`；README/已知限制更新。

## 第 14 轮

### 把本轮会话整理成 Markdown 文档

**我的提示词**

```text
把我们这轮会话整理打包成一份 Markdown 文档：逐轮收录我发出的全部提示词，以及你每次回复的简短工作成果。

- 顺序与范围：按对话时间顺序覆盖每一轮，包括「向README加入如何停止进程的信息」这类一句话指令，不得遗漏、合并或改写顺序。
- 每轮结构：先给轮次标题（如「第 N 轮」），下面分两块——「我的提示词」原样保留我的原文，含代码路径、命令、版本号、@文件引用，不改写、不精简；「工作成果」用 2–5 条要点概括你当轮的交付（改了什么、验证结果、证据或截图位置），不贴大段代码、不复述完整回复。
- 一致性：若某轮结论在后续被修正或推翻，以最终结论为准并简要标注修正点（例如「分层抽样未命中」实为 summary 模式展示加页面意图误判，后续已修复）。
- 忠实性：只整理对话中已发生的内容，不新增技术结论、不补写未做过的验证或数字。
- 输出：写入 <输出文件路径>（单个中文 Markdown 文件），完成后回报文件路径与收录的轮次数量。
```

**工作成果**

- 生成当前这份中文 Markdown 文档：按时间顺序收录 13 条聊天框手动提示词，并把 1 条目标模式 objective 作为第 3 轮单列，共 14 轮。
- 每轮包含「我的提示词」原文与 2–5 条「工作成果」；第 4 轮消息中的真实 API Key 已脱敏；文末附界面选择、自动目标轮与结论修正记录。
- 输出文件：`demos/pdf-llm-reader/docs/session-log-2026-11-11.md`。

## 附录 A：界面选择与自动目标轮

- **运行形态 / LLM 接口选择（2026-11-09，界面问答）**：运行形态选「本地 Web 应用（推荐）」；LLM 接入选「OpenAI 兼容（推荐）」。这两项决定后续所有实现。
- **目标轮 1（2026-11-09 21:48）**：目标模式 objective「完成预定计划 @/Users/Zhuanz/Documents/Physics/V4-relativity.pdf 以附件一作为测试PDF」，Round 1/256；9 秒后用户又发了第 2 轮的手动执行提示词，因此不重复计轮。
- **目标轮 2（2026-11-10 13:10–16:40）**：objective 为 OCR/文本 PDF/方向键/捏合四项功能，自动续跑 Round 1/256–8/256；相同 objective 不重复收录，已作为第 3 轮。期间因缺少真实 API Key，目标按政策标记 blocked 并再次向用户索取；用户随后提供 DeepSeek Key（第 4 轮）。
- **Key 提供方式选择（2026-11-10，界面问答）**：用户选择「稍后再提供 Key，保持目标 active」；之后确实在目标 blocked 状态下补发 Key。
- **计划模式（2026-11-11，第 11 轮前）**：用户要求「先制定修改计划，不要动代码」，会话进入 plan mode；计划经 `exit_plan_mode` 提交并获批后才开始实现。

## 附录 B：结论修正与演进

- **「分层抽样未命中」**：第 10 轮解释时的实际结论是——代码中没有该字面文案；UI 只是把 `mode==='summary'` 显示为「分层抽样」，`notFound` 是模型按 grounding 规则输出。第 11 轮进一步定位并修复了真正根因：页面提问被 `isSummaryQuestion()` 误判为 summary、抽样不含目标页；已通过 `pageIntent` + `pages/chapter` 模式修复，并以 Looking for Alaska PDF 实测单页/范围/总结三问通过。
- **V4-relativity.pdf 的定位变化**：第 2 轮实测为 286 页纯图片扫描件、无文字层，MVP 只能验证阅读；第 3 轮新增自动 OCR 与文本 PDF 转换后，V4 已可用于 OCR 问答、整本/分段转文字 PDF 与文字层对齐验证。
- **对话存档范围演进**：第 7 轮实现为单文档单会话 `DATA_DIR/chats/<docId>.json`；第 9 轮升级为多会话 `DATA_DIR/chats/<docId>/<chatId>.json`，刷新自动开新对话、历史可打开/删除。
- **文字层定位精度演进**：第 3 轮按 OCR 行框绘制不可见文字；第 9 轮改为按 Tesseract 词框逐词绘制并做 baseline/宽度拟合，给出叠加图与像素/质心统计。
- **真实服务商状态演进**：第 2–3 轮因无 Key 只能 mock/本机验证并标记缺口；第 4 轮用用户提供的 DeepSeek `deepseek-chat` 完成真实调用验收；后续页面意图修复与增强提示词也补了真实 DeepSeek 验证。

> 共收录 **14 轮**（13 条聊天框手动提示词 + 1 条目标模式 objective）。

