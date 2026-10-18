## v1.2.59 — 安全更新，适配各家新模型，新增 DeepSeek 联网搜索

### 中文

#### 桌面端与网页版

- **安全更新**：升级 Next.js、Electron、编辑器组件等依赖，修复多个已公开的安全漏洞，其中包括可被远程利用的严重漏洞。建议所有用户升级，Docker 与自部署用户请尽快更新。
- **适配各服务商的现行模型**：
  - 更新 DeepSeek、OpenAI、Claude、Gemini、智谱、通义千问、Kimi、豆包等服务商的预设模型，去掉已下线的型号。
  - 修复新一代 Claude 模型在开启思考强度、温度或 Top P 时请求被拒的问题。
  - 修复 Gemini 预设和默认模型已停服导致的报错；Gemini 3 / 4 改用新的思考设置。
  - 支持 DeepSeek 新模型名 `deepseek-flash`。`deepseek-chat`、`deepseek-reasoner` 已停用，请改用 `deepseek-flash` 或 `deepseek-v4-pro`。
  - 思考强度新增 XHigh 和 Max 两档（仅部分模型支持）。
- **服务商变动**：
  - 零一万物、GitHub Models 已停止服务，已从服务商列表移除。之前保存的配置会自动转为"自定义兼容端点"，地址和 Key 都会保留。
  - 腾讯混元已迁移到 TokenHub，需要在 TokenHub 控制台重新创建 API Key，接口地址也已更新。
- **联网搜索新增 DeepSeek 搜索**：已经配置了 DeepSeek 的话，可以直接用同一个 Key 联网搜索，不用再另外申请 Tavily 或 Exa。还可以让 AI 读取对话里贴出的网页，或在搜索后挑网页读全文。DeepSeek 搜索和读取网页自 2026 年 11 月 1 日起按次收费（每 1000 次成功请求 0.75 美元）。帮助页和 README 已加入使用说明。
- **英文和俄文界面**：修复切换语言后，斜杠菜单、导出窗口、拆分与合并提示、自动存档名称等处仍显示中文的问题；首次打开时自动创建的第一章也会按所选语言命名。
- 修复用鼠标在斜杠菜单里选择列表类命令后，接着输入的文字落到文档末尾的问题。
- Docker 部署在 API 配置里填写 HTTP 代理被拒时，提示会说明原因和开启方法；Docker 说明补充了代理地址的填写方式。

#### 安卓端

- 修复接入 DeepSeek 时，回答里混入思考过程、整段回答又重复一遍的问题。开启了"使用 Responses API"的服务商都会受影响，包括 OpenAI。
- "思考"选"默认"时不再替你关闭 DeepSeek 的思考；"关 / 低 / 中 / 高"会按 DeepSeek 的档位生效。
- 支持 DeepSeek 新模型名 `deepseek-flash`。
- 联网搜索可以另外指定一个"搜索用的模型"：当前模型不能联网时，先由它查资料，再由当前模型回答。
- AI 对话相关的报错提示会跟随界面语言显示。

#### 紧急修复

- 修复桌面版"局域网同步"创建的分享链接在手机上打不开的问题。分享链接的端口改为 3001 左右，请直接复制界面上显示的链接。第一次创建分享时，如果 Windows 弹出防火墙提示，请允许 Author 使用专用网络。
- 修复桌面版多处"复制"按钮点了没反应的问题，包括局域网分享链接、章节概要"复制全部"、设定条目编号、朗读报错和 QQ 群号。
- 桌面版创建局域网分享后不再单独显示分享码，请使用完整链接。只填分享码却找不到时，会提示改用完整链接。

---

### English

#### Desktop and Web

- **Security update**: upgraded Next.js, Electron, the editor components, and other dependencies to fix several publicly disclosed vulnerabilities, including critical ones that could be exploited remotely. Everyone should update; Docker and self-hosted deployments should update as soon as possible.
- **Support for current models from each provider**:
  - Updated the preset models for DeepSeek, OpenAI, Claude, Gemini, ZhipuAI, Qwen, Kimi, Doubao, and other providers, and removed retired models.
  - Fixed requests to the latest Claude models being rejected when thinking effort, temperature, or Top P was enabled.
  - Fixed errors caused by retired Gemini presets and default models; Gemini 3 / 4 now use the new thinking settings.
  - Added support for DeepSeek's new model name `deepseek-flash`. `deepseek-chat` and `deepseek-reasoner` have been retired; use `deepseek-flash` or `deepseek-v4-pro` instead.
  - Added XHigh and Max thinking levels (supported by some models only).
- **Provider changes**:
  - 01.AI (Yi) and GitHub Models have shut down and were removed from the provider list. Saved configurations are converted to "Custom compatible endpoint" automatically, keeping the URL and key.
  - Tencent Hunyuan has moved to TokenHub. Create a new API key in the TokenHub console; the API URL has been updated.
- **DeepSeek web search**: if DeepSeek is already set up, web search can use the same key, with no need to sign up for Tavily or Exa. The AI can also read web pages you paste into the chat, or pick pages from the search results to read in full. DeepSeek search and page reading are billed per request from Nov 1, 2026 ($0.75 per 1,000 successful requests). The in-app help and README now cover how to use it.
- **English and Russian interface**: fixed Chinese text still showing after switching languages in the slash command menu, export dialog, split and merge notices, auto snapshot names, and more. The first chapter created on first launch is now named in the selected language.
- Fixed text typed right after picking a list command from the slash menu with the mouse landing at the end of the document.
- When a Docker deployment rejects an HTTP proxy set in API settings, the message now explains why and how to enable it; the Docker guide now explains how to fill in the proxy address.

#### Android

- Fixed DeepSeek replies mixing in the thinking process and repeating the whole answer. This affected every provider with "Use Responses API" turned on, including OpenAI.
- With thinking set to "Default", DeepSeek's thinking is no longer turned off; "Off / Low / Medium / High" now map to DeepSeek's levels.
- Added support for DeepSeek's new model name `deepseek-flash`.
- Web search can use a separate search model: when the current model can't search the web, the search model looks things up first and the current model answers.
- AI chat error messages now follow the interface language.

#### Hotfix

- Fixed LAN share links created by the desktop app not opening on phones. Share links now use a port around 3001, so copy the link shown in the app. If Windows Firewall prompts you the first time you create a share, allow Author on private networks.
- Fixed several Copy buttons doing nothing in the desktop app, including the LAN share link, copying all chapter synopses, settings item IDs, read-aloud error reports, and the QQ group number.
- The desktop app no longer shows a separate share code for LAN shares; use the full link instead. Entering only a share code that can't be found now asks you to paste the full link.
