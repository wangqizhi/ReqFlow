# ReqFlow 2.13.7

## 主要更新

- 修复 OpenCode Go 测试连接返回 MissingSessionID / HTTP 400：访问官方 Go 接口时自动发送 `x-opencode-session`，兼容 `/inference/go/` 和旧 `/zen/go/` 地址。
- 同一供应商、模型、项目及请求用途在当前应用实例内复用随机会话标识，支持连接测试、需求生成、引导词优化与提交文案生成。
- AI API 请求自动发送包含应用版本的 `ReqFlow/<版本>` 客户端标识。

## 配置说明

OpenCode Go 的 OpenAI Chat Completions 格式使用 `https://opencode.ai/inference/go/openai/v1/chat/completions`（或其 `/openai/v1` 基地址）。当前 OpenAI 格式按 Chat Completions 发送请求，请勿填写 `/responses`。本次不修改已保存的供应商地址或密钥。
