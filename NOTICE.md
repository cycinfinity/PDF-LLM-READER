# NOTICE

## 参考项目与许可证边界

本项目的设计参考了 [Stirling PDF](https://github.com/Stirling-Tools/Stirling-PDF)
（分析版本 `v3.3.0-16-gd74543712c`，commit `d74543712c8214548b823859c8dba4cf2e52a875`）。

Stirling PDF 的许可证不是单一许可证，使用或借鉴前需要区分：

- 仓库根目录及其未被单独声明的大部分代码：**MIT**。
- `app/proprietary/`、`app/saas/`、`engine/`、
  `frontend/src/editor/{proprietary,desktop,saas,cloud}/`、`frontend/src/processor/`：
  **Stirling PDF User License**（生产使用需有效的商业许可证）。
- 上述目录之外的部分为 MIT；具体以参考项目仓库内各目录的 `LICENSE` 文件为准。

**本项目没有复制 Stirling PDF 的源码。** 仅借鉴以下架构与交互设计（这些属于通用工程实践）：

1. PDF 文本按页归属，使回答可以引用页码。
2. 结构化分块与片段重叠（chunk + overlap）的检索前处理。
3. grounded system prompt：只依据检索内容、要求标注来源、证据不足时返回 not_found。
4. 将「检索片段 + 页码」回传给前端，渲染为可点击的引用。
5. LLM 配置与密钥保存在服务端，不回传浏览器、不写入日志。

本项目的实现（React + pdf.js 前端、Node/Express 后端、词法检索、配置持久化）均为独立编写。
如未来需要直接复用 Stirling PDF 的某段代码，必须逐文件核对其所在目录的许可证并在此处补充来源与
许可证声明；`app/proprietary/`、`engine/` 等 User License 目录的代码不得直接复制。

## 本项目许可证

本项目代码以 MIT 许可证发布，完整文本见 [LICENSE](LICENSE)。

## 第三方依赖

| 依赖 | 许可证 |
| --- | --- |
| pdf.js / pdfjs-dist | Apache-2.0 |
| tesseract.js | Apache-2.0 |
| tesseract.js-core | Apache-2.0 |
| @tesseract.js-data/eng、@tesseract.js-data/chi_sim | Apache-2.0 |
| pdf-lib | MIT |
| @pdf-lib/fontkit | MIT |
| React / React DOM | MIT |
| Vite | MIT |
| Tailwind CSS | MIT |
| Express | MIT |
| Zod | MIT |
| lucide-react | ISC |
| dotenv | BSD-2-Clause |
| TypeScript | Apache-2.0 |
| Vitest | MIT |
| Playwright | Apache-2.0 |

完整许可证文本见 `node_modules/<package>/LICENSE`（安装依赖后可见）。
OCR 引擎与语言包以本地资产形式复制到 `public/ocr/`（由 `scripts/copy-assets.mjs` 在 postinstall
阶段完成），不在运行时访问外网。可选的中文字体 Noto Sans SC 采用 SIL Open Font License 1.1，
本仓库未附带该字体文件；仅在用户自行放入 `public/fonts/` 时才会用于中文文字层导出。

## 免责声明

本项目是本地学习/验证用 MVP，不提供任何担保。它会在本机保存用户填写的 LLM 配置；使用第三方
LLM 服务时，文档片段与问题会发送给该服务商，请自行评估数据敏感性与费用。
