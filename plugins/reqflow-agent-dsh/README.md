# ReqFlow Agent（DeepSeek Harness 版）

DeepSeek Harness（DSH）本地插件：按当前目录匹配 ReqFlow 项目，领取有效排期（draft 或 submitted）中标识为 AI 执行的需求，不要求先提交，实际完成后逐条转入待验证。人工验收保留在 ReqFlow。

要求：Node >= 22、支持 `workspace get` / `version` / `complete` / `execution claim` 的 ReqFlow 桌面版（已验证 2.9.0）。无 npm 依赖、无常驻服务。桥接入口为 `scripts/reqflow.mjs`，插件入口为 `lib/index.js`。

## 安装

本仓库中的插件已按 DSH bundle 格式组织：

- `package.json`：`dsh.bundle.patch` 指向 `cordis.patch.yml`。
- `cordis.patch.yml`：向 profile 插入 `reqflow-agent-dsh` 一行。
- `lib/index.js`：注册 `reqflow_read`、`reqflow_complete` 工具，`/reqflow`、`/reqflow-doctor` 命令，以及 `reqflow-execute`、`reqflow-setup` 技能。
- `scripts/reqflow.mjs`：ReqFlow CLI 桥接，配置目录为 `~/.reqflow-dsh/`。

安装到 DSH profile（以 `desktop` 为例）：

1. 在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中加入本地路径：

   ```json
   "reqflow-agent-dsh": "file:E:/project/reqFlow/plugins/reqflow-agent-dsh"
   ```

2. 在 `dsh.profile.bundles` 末尾加入 `"reqflow-agent-dsh"`。
3. 在 profile 目录运行 pnpm 安装（使用 DSH 自带 pnpm）：

   ```powershell
   & "E:\Program Files\deepseekHarness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
     "E:\Program Files\deepseekHarness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" install --offline
   ```

4. 重启 DSH Web/Desktop，或在 Plugins 页面重新加载 profile，使新 bundle 生效。

首次使用运行 setup 技能或直接配置：

```powershell
node scripts/reqflow.mjs configure --exe "E:\Program Files\reqflow\ReqFlow.exe"
# 如有必要增加 --data-dir "实际数据目录"
```

也支持 `REQFLOW_EXE`、`REQFLOW_DATA_DIR`、`REQFLOW_PLUGIN_CONFIG`。默认配置为 `~/.reqflow-dsh/config.json`；运行快照在 `~/.reqflow-dsh/runs/`，可能含私有需求，不要提交或分享。

## 使用

- `/reqflow`：优先按当前工作目录匹配项目，领取有效已提交需求并开始实现。
- `/reqflow <projectId>`：指定项目。`/reqflow select` 查看项目列表。
- `/reqflow-doctor`：检查 CLI 与插件配置。
- 自然语言“读取/分析/执行 ReqFlow 需求”：模型可调用 `reqflow_read`；只有明确授权执行才使用 `execute=true` 领取并实现。
- 非交互或未匹配项目：`reqflow_read` 返回 `selectionRequired` 和项目列表，必须由用户明确选择 `projectId`。

目标项目必须绑定真实存在的本地目录。选择不会更改 ReqFlow 绑定，也不会更改 DSH 会话工作目录。返回 `executionCwd`，工作流要求使用目标绝对文件路径，并先读取目标项目适用说明。

保留 Codex/ZCode/Pi 桥接的有效批次过滤、版本/签名核对、部分成功停止及幂等回写。仅实际完成需求转待验证，不执行 verify/archive，不直接修改 `workspace.json`。旧 CLI 无原子条件写入，避免多个 Agent 同时处理相同需求。

## 与其它宿主版本的差异

DSH 版本优先使用 `dsh` 作为 AI 执行客户端标识，GUI 的执行中页面和数据看板显示 `DSH`。如果运行中的 ReqFlow 还是加入该标识之前的版本，桥接脚本会自动回退到 `pi`，保证领取和回写仍可工作；配置目录（`~/.reqflow-dsh`）、运行记录和完成备注（`[ReqFlow DSH run ...]`）始终标记为 DSH。

ReqFlow 内置插件发布目录目前没有 `dsh` 宿主，因此本插件**不启用自动更新**，也不会调用其它宿主的更新器。升级时替换本目录文件并重启 DSH 即可；配置和领取快照保留。

## 独占执行（ReqFlow 2.2.4+）

执行使用 `read` 原子领取；只读使用 `inspect`，返回 `runFile=null`，不锁定任务。领取记录包含 `runId`、`client`、`startedAt`；完成保留 `endedAt` 和 `durationMs`。其他客户端不能领取或完成。中断任务由用户确认释放，释放后旧凭据失效，不自动超时抢占。`reqflow_read` 默认只读，只有用户授权执行时 `execute=true`；`/reqflow` 为执行入口。
