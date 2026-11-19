# ReqFlow Agent（Antigravity 版）

Google Antigravity 本地插件：按当前工作区目录匹配 ReqFlow 项目，领取有效排期（`draft` 或 `submitted`）中标识为 AI 执行的需求，不要求先提交，实际完成后逐条转入待验证。人工验收保留在 ReqFlow。

要求：Node >= 22、支持 `workspace get` / `version` / `complete` / `execution claim` 的 ReqFlow 桌面版。无 npm 依赖、无常驻外部服务。桥接入口为 `scripts/reqflow.mjs`，MCP 服务入口为 `scripts/mcp-server.mjs`。

## 结构

本仓库中的插件按 Antigravity 原生插件格式组织：

- `plugin.json`：Antigravity 插件清单。
- `mcp_config.json`：声明内置 stdio MCP 服务（`reqflow_read`、`reqflow_complete`、`reqflow_projects`、`reqflow_doctor`）。
- `rules/AGENTS.md`：插件激活时自动加载的 ReqFlow 路由与执行规则。
- `skills/reqflow-execute/SKILL.md`、`skills/reqflow-setup/SKILL.md`：执行与配置技能。
- `scripts/reqflow.mjs`：ReqFlow CLI 桥接，配置目录为 `~/.reqflow-antigravity/`。
- `scripts/mcp-server.mjs`：零依赖 Node.js stdio MCP 服务端。

## 安装

使用 Antigravity CLI 校验并安装到本地全局插件目录（`~/.gemini/config/plugins/reqflow-agent-antigravity`）：

```powershell
agy plugin validate E:\project\reqFlow\plugins\reqflow-agent-antigravity --strict
agy plugin install E:\project\reqFlow\plugins\reqflow-agent-antigravity
agy plugin list
```

若 Antigravity 正在运行时 Windows 上 `agy plugin install` 遇到临时目录重命名权限占用，可直接将插件目录复制到 `~/.gemini/config/plugins/reqflow-agent-antigravity` 后用 `agy plugin list` 确认已启用。

重启或开启新的 Antigravity 会话后生效。

首次使用可自动发现本机 `ReqFlow.exe`，也可运行 `reqflow-setup` 技能或直接配置：

```powershell
node scripts/reqflow.mjs configure --exe "E:\Program Files\reqflow\ReqFlow.exe"
# 如有必要增加 --data-dir "实际数据目录"
```

也支持环境变量 `REQFLOW_EXE`、`REQFLOW_DATA_DIR`、`REQFLOW_PLUGIN_CONFIG`。默认配置为 `~/.reqflow-antigravity/config.json`；运行快照在 `~/.reqflow-antigravity/runs/`，可能含私有需求，不要提交或分享。

## 使用

- 自然语言「读取 / 分析 ReqFlow 需求」：模型调用 `reqflow_read`（`execute=false`），只读查看，不锁定任务。
- 自然语言「执行 ReqFlow 需求」：模型立即调用 `reqflow_read`（`execute=true`）领取独占任务，实现并验证后对实际完成条目调用 `reqflow_complete`。
- 自然语言「检查 ReqFlow 配置」：模型调用 `reqflow_doctor` 检查 CLI 与插件配置。
- 未匹配项目：`reqflow_read` 返回 `selectionRequired` 和项目列表，必须由用户明确选择 `projectId`。

目标项目必须绑定真实存在的本地目录。选择不会更改 ReqFlow 绑定，也不会更改 Antigravity 会话工作目录。返回 `executionCwd`，工作流要求使用目标绝对文件路径，并先读取目标项目适用说明。

## 与其它宿主版本的差异

Antigravity 版本优先使用 `antigravity` 作为 AI 执行客户端标识，GUI 的执行中页面和数据看板显示 `Antigravity`。如果运行中的 ReqFlow 还是加入该标识之前的版本，桥接脚本会自动回退到 `pi`，保证领取和回写仍可工作；配置目录（`~/.reqflow-antigravity`）、运行记录和完成备注（`[ReqFlow Antigravity run ...]`）始终标记为 Antigravity。

ReqFlow 内置插件发布目录目前没有 `antigravity` 宿主，因此本插件**不启用自动更新**，也不会调用其它宿主的更新器。升级时重新运行 `agy plugin install` 即可；`~/.reqflow-antigravity/` 下的配置和领取快照保留。

## 独占执行

执行使用 `read` 原子领取；只读使用 `inspect`，返回 `runFile=null`，不锁定任务。领取记录包含 `runId`、`client`、`startedAt`；完成保留 `endedAt` 和 `durationMs`。其他客户端不能领取或完成。中断任务由用户确认释放，释放后旧凭据失效，不自动超时抢占。
