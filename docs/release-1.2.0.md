# ReqFlow 1.2.0

本轮 6 条需求（REQ-032–REQ-037），按交付引导增加中版本号。

- 设置按钮增加线性图标。
- AI 配置独立保存于数据目录的 `ai-settings.json`；API Key 使用系统加密。远程备份完全移除 AI 配置，不再包含供应商、URL、格式、模型或密钥。已有本地配置继续可读，旧配置默认 OpenAI 格式。远程历史中的旧配置不会被删除；下次同步的新快照不包含 AI 配置。
- 设置中可选择 OpenAI / Anthropic 格式，并填写模型 ID。URL 可填写 `/v1` 基础地址或完整请求端点，分别使用 Chat Completions / Messages 协议。
- 浏览项目的待 Git 提交区移除「填入需求」与「AI 优化」按钮，提交框内部左侧增加魔术棒。根据待验证/归档且当前版本尚未提交的需求生成逐行文案：`feat:`、`bugfix:`、`update:`。AI 生成期间防止重复点击与提交，失败保留原文。无待提交需求时禁用。
- 新需求说明框支持 Ctrl+V 粘贴截图，自动展开图片区，沿用 12 张、单张 10MB 限制，参考图片随需求保存。

使用 AI 前需保存调用 URL、模型 ID 与 API Key。点击魔术棒会向所配置的服务发送待提交需求编号、类型、标题、正文、验收条件及当前文案，不发送附件与历史。请求限时 60 秒；服务错误、空结果和非标准文案会提示失败。

协议参考：[OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)。

验证：TypeScript、16 组领域冒烟、Electron CLI 端到端、真实 Git 备份回归、Electron UI 与本地 HTTP 服务集成检查。UI 检查涵盖截图持久化、12 张图片布局、协议切换、加密保存、两种协议请求、魔术棒加载状态及失败保留文案，截图位于 `out/review-1.2.0/`。

本地模拟服务用于检查协议与实际 IPC 链路；未使用真实服务商密钥进行联网调用。安装包：`release/ReqFlow-Setup-1.2.0.exe` 与 `release/ReqFlow-Portable-1.2.0.exe`。
