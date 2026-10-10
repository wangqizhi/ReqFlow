# ReqFlow Agent

本地 Codex 插件：按当前目录匹配 ReqFlow 项目，领取已提交批次中的执行中需求，实际完成后逐条转入待验证。人工验收保留在 ReqFlow。

要求：Node >= 22、支持 workspace get / version / complete 的 ReqFlow 桌面版。无 npm 依赖、无常驻服务。源码入口为 scripts/reqflow.mjs。

安装和配置详见仓库 docs/reqflow-codex-plugin.md。首次运行 setup 配置 ReqFlow.exe；工作目录需与 ReqFlow 项目的关联目录相同或处于其中。运行记录保存到用户 `.reqflow-codex/runs`，包含本地需求快照，请勿提交或分享这些文件。

技能 execute 需要用户在聊天中触发；安装并不代表后台轮询或自动启动任务。

CLI 完成接口尚不支持原子版本条件写入：桥接脚本在每次完成前核对快照、完成后检查状态，并报告部分成功；仍须避免 GUI / CLI / 多 Agent 并发修改同一需求。没有分布式领取锁、没有 exactly-once 保证。
