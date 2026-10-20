# ReqFlow Agent（OpenCode 版）

OpenCode 插件：按当前目录匹配 ReqFlow 项目，领取有效排期（draft 或 submitted）中标识为 AI 执行的需求，不要求先提交，实际完成后逐条转入待验证。人工验收保留在 ReqFlow。

要求：Node >= 22、支持 `workspace get` / `version` / `complete` / `execution claim` 的 ReqFlow 桌面版（已验证 2.9.2）。无 npm 依赖、无常驻服务。插件入口为 `index.ts`，桥接入口为 `scripts/reqflow.mjs`。

## 安装

插件是一个标准的 OpenCode 插件包，入口 `index.ts` 同时提供 OpenCode 1.x 的 `server()` 与 OpenCode 2.x 的 `setup()`，不引入 SDK 依赖，任意目录都可直接加载。

在项目 `opencode.json(c)`（或全局 `~/.config/opencode/opencode.json(c)`）中登记：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // OpenCode 1.x 用 "plugin"，OpenCode 2.x 用 "plugins"
  "plugin": ["E:/project/reqFlow/plugins/reqflow-agent-opencode"],
  "plugins": ["E:/project/reqFlow/plugins/reqflow-agent-opencode"]
}
```

两个键写同一个路径没有副作用：每个 OpenCode 只读取自己那一个。也可以把整个目录复制到 `~/.config/opencode/plugins/reqflow-agent-opencode/`（OpenCode 2.x 会自动发现包目录；OpenCode 1.x 需要用上面的 `plugin` 键指向它）。

安装后重启 OpenCode 服务（`opencode service restart`）或重开会话。

技能（可选）：OpenCode 2.x 由插件直接注册 `reqflow-execute`、`reqflow-setup`；OpenCode 1.x 需要把 `skills/execute/SKILL.md` 复制到 `~/.config/opencode/skills/reqflow-execute/SKILL.md`，把 `skills/setup/SKILL.md` 复制到 `~/.config/opencode/skills/reqflow-setup/SKILL.md`。不复制技能也能使用，`reqflow_read` / `reqflow_complete` 工具与系统提示路由始终可用。

首次使用先配置本机 ReqFlow：

```powershell
node scripts/reqflow.mjs configure --exe "E:\Program Files\reqflow\ReqFlow.exe"
# 如有必要增加 --data-dir "实际数据目录"
```

也支持 `REQFLOW_EXE`、`REQFLOW_DATA_DIR`、`REQFLOW_PLUGIN_CONFIG`。默认配置为 `~/.reqflow-opencode/config.json`；运行快照在 `~/.reqflow-opencode/runs/`，可能含私有需求，不要提交或分享。

## 使用

- `/reqflow-execute`：按当前工作目录匹配项目，领取有效已提交需求并开始实现。
- 自然语言「读取/分析/执行 ReqFlow 需求」：模型可调用 `reqflow_read`；只有明确授权执行才使用 `execute=true` 领取并实现。
- `reqflow_read`：默认只读（`execute=false`），返回 `requirements`、`runFile`、`executionCwd` 和 `skipped`，不锁定任务。
- `reqflow_complete`：仅在用户授权执行、实际完成并检查需求后调用，逐条提供 `id`、`summary`、`validation`。
- 当前目录未匹配项目时 `reqflow_read` 返回 `selectionRequired` 和项目列表，必须由用户明确选择 `projectId` 后重试。

目标项目必须绑定真实存在的本地目录。选择不会更改 ReqFlow 绑定，也不会更改 OpenCode 会话工作目录。返回 `executionCwd`，工作流要求使用目标绝对文件路径，并先读取目标项目适用说明。

保留 Codex/ZCode/Pi/Claude Code/DSH 桥接的有效批次过滤、版本/签名核对、部分成功停止及幂等回写。仅实际完成需求转待验证，不执行 verify/archive，不直接修改 `workspace.json`。

## 与其它宿主版本的差异

OpenCode 版本优先使用 `opencode` 作为 AI 执行客户端标识，GUI 的执行中页面和数据看板显示 `OpenCode`。如果运行中的 ReqFlow 还是加入该标识之前的版本，桥接脚本会自动回退到 `pi`，保证领取和回写仍可工作；配置目录（`~/.reqflow-opencode`）、运行记录和完成备注（`[ReqFlow OpenCode run ...]`）始终标记为 OpenCode。

ReqFlow 内置插件发布目录已提供 `opencode` 宿主：插件启动前用 `plugin version --host opencode` 比对版本，版本落后时读取 `plugin bundle`、校验 SHA256 与清单后更新**当前正在使用的插件目录**（`~/.config/opencode/plugins/reqflow-agent-opencode` 或项目的 `.opencode/plugins/reqflow-agent-opencode`），更新后需重启 OpenCode 服务。插件不在 OpenCode 插件目录中时（例如直接指向仓库路径）不做自动更新，改为提示手动更新，不会安装第二份副本导致工具重复注册。
