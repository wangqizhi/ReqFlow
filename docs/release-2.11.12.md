# ReqFlow 2.11.12

## 主要更新

- 「提交验证」的指派新增 Claude Code 与 DeepSeek Harness：Claude Code 在项目目录以交互终端执行单条或合并需求；DeepSeek Harness 使用随附的 headless profile 执行一次任务并显示只读日志。
- 「插件 / MOD / AGENT → Local Agent」新增 Claude Code 与 DeepSeek Harness 卡片：可分别开启或关闭指派，并检测是否安装、当前版本与 npm 上是否有更新，支持一键安装或更新到最新版。
- Local Agent 的检测与更新摘要、页签角标、安装数量统计同时覆盖这两个 Agent。
- 版本比较支持 `0.2.1-rc.2` 这类预发布版本：与本机版本一致时显示已是最新，预发布之间不做不可靠的先后判断。
- 执行中页面、数据看板与释放提示统一把 `dsh` 显示为 DeepSeek Harness。

## 说明

- Claude Code 的标识为 `claude-code`（命令 `claude`，npm 包 `@anthropic-ai/claude-code`），DeepSeek Harness 的标识为 `dsh`（命令 `dsh`，npm 包 `@deepseek-ai/dsh`）。
- DeepSeek Harness 指派运行 `dsh --profile headless`，需要在该 profile 安装 `reqflow-agent-dsh` 插件并配置模型；终端只显示任务日志，不接收输入，完成状态以插件回写待验证为准。
- 安装与更新使用 `npm install -g <包>@latest`，需要本机 Node.js、npm 与相应安装权限。
