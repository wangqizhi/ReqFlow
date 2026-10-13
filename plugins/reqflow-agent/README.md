# ReqFlow Agent

本地 Codex 插件：按当前目录匹配 ReqFlow 项目，领取有效排期（draft 或 submitted）中标识为 AI 执行的需求，不要求先提交，实际完成后逐条转入待验证。人工验收保留在 ReqFlow。

要求：Node >= 22、支持 workspace get / version / complete 的 ReqFlow 桌面版。无 npm 依赖、无常驻服务。源码入口为 scripts/reqflow.mjs。

安装和配置详见仓库 docs/reqflow-codex-plugin.md。首次运行 setup 配置 ReqFlow.exe；工作目录需与 ReqFlow 项目的关联目录相同或处于其中。运行记录保存到用户 `.reqflow-codex/runs`，包含本地需求快照，请勿提交或分享这些文件。

在已绑定项目目录的聊天中，仅 @ ReqFlow Agent 即默认触发 execute：读取 AI 排期需求、开始实现和验证，实际完成后转入待验证，无需再输入执行指令。明确要求仅查看、配置或更新插件时按该指令处理。安装并不代表后台轮询或自动启动聊天。

新版 CLI 在完成写入时校验批次、需求版本和 AI 执行标识；旧版桌面程序需先升级。桥接脚本在每次完成前核对快照、完成后检查状态，并报告部分成功；仍须避免 GUI / CLI / 多 Agent 并发修改同一需求。没有分布式领取锁、没有 exactly-once 保证。

执行方式字段 executor：ai（默认）、human、plugin:<id>、agent:<id>。插件只领取 ai；需求池中尚未排期的任务不领取。CLI item add/edit 支持 --executor，item list 支持按 --executor 筛选。

## 启动前版本协商（ReqFlow 2.2.3+）

read、doctor、projects（Pi）与 complete 在执行前使用 ReqFlow 内置的插件版本查询接口。仅在内置版本更新时下载离线更新包，校验 SHA256 与清单；失败时停止，不领取或回写需求。版本来自当前安装的 ReqFlow，升级 ReqFlow 即更新插件发布目录；不访问第三方下载地址、不降级插件。

Codex 使用 plugin marketplace / plugin add；ZCode 使用安装目录附带的 resources/glm/zcode.cjs 的 plugins 命令（非标准安装路径可配置 zcodeCli 或 REQFLOW_ZCODE_CLI）；保留插件和市场名称，仅独立本地市场可自动切换到已校验更新包，失败恢复原来源。Pi 更新本地 extensions/reqflow 源目录；包安装使用稳定的 ~/.reqflow-pi/plugin 路径以避免重复注册。更新后需重新加载宿主技能或 Pi 扩展注册；当前命令自动使用最新桥接脚本。保留用户独立配置与领取快照。

## 独占执行（ReqFlow 2.2.4+）

执行使用 read 原子领取；只读使用 inspect，返回 runFile=null，不锁定任务。用户限定范围时使用 --ids <id1,id2>。领取记录包含 runId、client、startedAt；完成保留 endedAt 和 durationMs。其他客户端不能领取或完成，GUI 执行中页展示当前任务与实时用时。中断任务由用户确认释放，释放后旧凭据失效，不自动超时抢占。Pi 的 reqflow_read 默认只读，只有用户授权执行时 execute=true；/reqflow 为执行入口。
