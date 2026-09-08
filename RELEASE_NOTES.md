## v1.2.57 — 改进 AI 参考选择、模型配置与多语言界面

### 中文

#### 桌面端与网页版

- 新增“AI 忽略删除线文字”选项，默认关闭。开启后，AI 参考、内联写作和章节摘要会跳过删除线文字，原始正文与格式继续保留。
- AI 参考面板按卷整理章节，支持整卷和逐章勾选、取消。改进章节与多章梗概重叠时的选择处理，取消全部参考后重新打开仍保留空选状态。
- 改进独立嵌入 API 配置：可明确选择是否复用聊天 Key，无需 Key 的嵌入服务可留空使用；切换供应商或快切模型时保留各自配置。
- 补齐 API 配置、模型列表、编辑器占位提示和内置设定分类的中、英、俄文案，保留用户自定义名称。
- 修复部分旧版浏览器中云同步失败的问题。
- 改进桌面安装包的运行资源校验与构建临时文件管理。
- 更新帮助页和多语言使用说明。

---

### English

#### Desktop and Web

- Added an optional **Exclude strikethrough text from AI** setting, off by default. When enabled, AI references, inline writing, and chapter summaries skip struck-through text while retaining the original manuscript and formatting.
- Organized chapter references by volume, with whole-volume and individual chapter selection. Improved selection when chapter references overlap multi-chapter synopses, and preserved an empty selection after reopening the app.
- Improved separate embedding API configuration: explicitly choose whether to reuse the chat key, leave it blank for services that require no key, and retain provider settings when switching providers or quick-switch models.
- Completed Chinese, English, and Russian labels for API configuration, model lists, editor placeholders, and built-in lore categories while preserving custom names.
- Fixed cloud sync failures in some older browsers.
- Improved desktop package resource validation and temporary build-file management.
- Updated in-app help and multilingual usage guidance.
