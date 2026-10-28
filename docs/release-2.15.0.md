# ReqFlow 2.15.0

## 主要更新

- 任务 Token 自动采集扩展到 Claude Code、Pi、ZCode 与 DeepSeek Harness，与 Codex 一样从本机精确会话读取领取后的实际用量，并按模型与思考等级汇总。
- Agent 通过 ReqFlow 插件执行，或在 ReqFlow 客户端中直接指派 CLI 执行，完成回写时都会采集用量。
- 采集只认会话 ID 精确匹配且会话目录属于当前项目的记录；缓存输入计入输入总量，同一回复的重复记录自动去重，找不到会话时仍显示未采集。
- 各 Agent 插件版本同步更新，完成回写时会把当前会话 ID 交给 ReqFlow。
