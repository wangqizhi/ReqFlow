# ReqFlow Agent（ZCode 版）

ZCode 本地插件：按当前目录匹配 ReqFlow 项目，领取已提交批次中的执行中需求，实际完成后逐条转入待验证。人工验收保留在 ReqFlow。与 `plugins/reqflow-agent/`（Codex 版）互相独立，配置分别保存在 `~/.reqflow-codex/` 与 `~/.reqflow-zcode/`。

要求：Node >= 22、支持 workspace get / version / complete 的 ReqFlow 桌面版。无 npm 依赖、无常驻服务。源码入口为 scripts/reqflow.mjs，桥接逻辑与 Codex 版一致，仅配置目录与回写备注前缀（`[ReqFlow ZCode run ...]`）不同。

安装：通过本地测试市场 `plugins/marketplace.json` 在 ZCode 插件市场中添加 `E:\project\reqFlow\plugins` 后安装。首次运行 setup 技能配置 ReqFlow.exe；工作目录需与 ReqFlow 项目的关联目录相同或处于其中。运行记录保存到用户 `.reqflow-zcode/runs`，包含本地需求快照，请勿提交或分享这些文件。

技能 execute 需要用户在聊天中触发；安装并不代表后台轮询或自动启动任务。

CLI 完成接口尚不支持原子版本条件写入：桥接脚本在每次完成前核对快照、完成后检查状态，并报告部分成功；仍须避免 GUI / CLI / 多 Agent 并发修改同一需求。没有分布式领取锁、没有 exactly-once 保证。
