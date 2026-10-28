## v1.2.60 — 放宽 AI 生成超时，修复 MiniMax 新模型和余额不足提示

### 中文

#### 桌面端与网页版

- **AI 生成的等待时间放宽到 5 分钟**：一次发送很多章节时，模型要先读完全部内容才开始输出，这段时间可能超过 2 分钟，以前会直接提示"生成超时"。现在改为连续 5 分钟没有任何输出才算超时；模型持续输出时，写多久都不会被打断。
- **MiniMax M3 系列**：
  - 使用 Anthropic 格式时，默认输出额度提高到 65536。MiniMax 的思考也计入输出额度，以前额度偏小，长篇任务容易只有思考、没有正文，提示"生成中断"。
  - 思考层级按 MiniMax 的要求发送。MiniMax-M3.1-Flash 无法关闭思考，选"关闭思考"时改用 Low，不再报错；MiniMax-M3 选"关闭思考"会真正关闭。
- **余额不足的提示统一**：各家服务商余额不足时，统一提示"API 账户余额不足，请充值后重试"，不再被误报成请求过于频繁、没有权限，或直接显示英文原文。设定面板里的"测试连接"同样适用。
- README 重写了「为什么做这个项目」一节，各语言版本同步更新。

#### 安卓端

- 本版没有功能改动，只更新版本号。

---

### English

#### Desktop and Web

- **AI generation now waits up to 5 minutes**: when many chapters are sent at once, the model has to read all of them before it starts writing, which can take more than 2 minutes and used to end with "Generation timed out". A generation now times out only after 5 minutes with no output at all; as long as the model keeps writing, it is never cut off.
- **MiniMax M3 series**:
  - With the Anthropic format, the default output limit is now 65536 tokens. MiniMax counts thinking toward this limit, and the old, smaller limit often left long tasks with thinking but no text, ending with "Generation was interrupted".
  - Reasoning effort is now sent the way MiniMax expects. MiniMax-M3.1-Flash cannot turn thinking off, so "Disable Thinking" now uses Low instead of failing; on MiniMax-M3, "Disable Thinking" really turns thinking off.
- **Consistent low-balance message**: when an account runs out of balance, every provider now shows "Insufficient account balance. Please top up and retry." instead of a rate-limit or permission error, or the provider's raw English text. "Test Connection" in settings does the same.
- Rewrote the "Why I Built This" section of the README, updated in every language.

#### Android

- No functional changes in this release; version number update only.
