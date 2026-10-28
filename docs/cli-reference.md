# ReqFlow CLI 参考（Agent 对接指南）

> 本文档由 `src/core/cli-help.ts` 生成（`npm run build` 时自动更新），与 `ReqFlow.exe --cli help` 输出、应用内「帮助 · CLI 参考」页面同源一致。

## 用法

```sh
ReqFlow.exe --cli <command> [options]
```

所有命令输出单行 JSON：成功 `{"ok":true,...}`，失败 `{"ok":false,"error":"..."}`；退出码 0/1。

## 全局选项

| 选项 | 说明 |
| --- | --- |
| `--data-dir <path>` | 覆盖数据目录（安装版默认为安装时所选目录，未选过则 %APPDATA%/ReqFlow；便携版默认 exe 同级 data\；workspace.json 保存在该目录下） |
| `--pretty` | 以缩进格式输出 JSON，便于人工阅读（默认单行 JSON，便于程序解析） |
| `--out <file>` | 除 stdout 外，把输出同时写入指定文件（适合保存 Prompt 全文） |

## context

功能上下文、项目守则与数据目录。守则自动生成，后续需求 Prompt 自动引用。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `context list` | `` | 列出上下文及关联的 projectId / feature，含相关代码与源码路径。 |
| `context show` | `--id <上下文ID>` | 按 ID 读取上下文，返回正文、summaryFile、filesDir 与目录；使用与当前执行相同的数据目录。 |
| `context put` | `--title <标题> --file <Markdown文件> [--id <上下文ID>] [--code <代码摘录Markdown>] [--files <逗号分隔文件路径>] [--project <项目ID> --feature <功能名>] [--tags <逗号分隔标签>]` | 新增或更新上下文；也可用 --body 直接传正文。--files 从关联项目目录复制原始代码文件（最多60个，单文件2MB、总计8MB）。每条上下文使用独立的 ID 目录，summary.md 保存总结，files/ 保留代码原文件与相对路径；--code 兼容旧摘录并保存在元数据中。关联项目后自动生成守则，并同步目录与 Git。<br/>例：`ReqFlow.exe --cli context put --title "排期功能" --file feature.md --files "src/renderer/App.tsx,src/core/domain.ts" --project <id> --feature 排期` |
| `context settings` | `` | 查看上下文数据目录及 Git 可用状态。 |
| `context migrate` | `--dir <绝对路径>` | 迁移上下文到空目录并切换后续写入位置，原目录保留为恢复副本。 |

## 基础

帮助、版本与工作区整体读写。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `help` | `` | 显示 CLI 帮助（本参考的文本版）<br/>例：`ReqFlow.exe --cli help` |
| `version` | `` | 输出版本信息（应用版本 / 数据文件路径）<br/>例：`ReqFlow.exe --cli version` |
| `plugin version` | `--host <codex|zcode|pi|claude-code|opencode> [--plugin-version <x.y.z>]` | 查询当前 ReqFlow 内置的最新插件版本、SHA256 与更新状态<br/>例：`ReqFlow.exe --cli plugin version --host codex --plugin-version 0.2.1` |
| `plugin bundle` | `--host <codex|zcode|pi|claude-code|opencode>` | 读取当前 ReqFlow 内置插件文件及 SHA256，供插件启动前自动更新使用 |
| `execution claim` | `--project <id> --client <codex|zcode|pi|claude-code|dsh|opencode> --run <UUID> --claims <JSON数组>` | 事务领取 AI 排期任务；claims 每项包含 id/version/batchId/hash。返回成功领取项与跳过原因，执行中任务不会被覆盖 |
| `execution release` | `--project <id> --id <需求ID> [--run <UUID>] [--note <说明>]` | 显式释放已停止的 AI 任务，保留结束时间和用时；指定运行 ID 时仅允许释放自己的任务 |
| `workspace get` | `` | 读取完整工作区，返回 {version, state}；state.projects 为项目数组<br/>例：`ReqFlow.exe --cli workspace get` |
| `workspace export` | `[--out <file>]` | 导出完整工作区 JSON（等价于界面「导出全部数据」）<br/>例：`ReqFlow.exe --cli workspace export --out backup.json` |
| `workspace import` | `--file <path> [--replace]` | 导入界面或 export 导出的完整工作区 JSON；工作区已有数据时必须加 --replace 覆盖<br/>例：`ReqFlow.exe --cli workspace import --file backup.json --replace` |

## 项目与引导词

项目是需求与批次的容器；引导词决定生成 Prompt 的项目级指令。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `project list` | `` | 项目列表，含 id、名称与各状态需求数量<br/>例：`ReqFlow.exe --cli project list` |
| `project create` | `--name <名称> [--description <背景>]` | 新建项目并返回其 id<br/>例：`ReqFlow.exe --cli project create --name "官网改版"` |
| `project delete` | `--project <id>` | 删除项目及其全部需求、批次与历史（不可恢复；至少保留一个项目，删除前建议 workspace export 备份）<br/>例：`ReqFlow.exe --cli project delete --project <id>` |
| `project show` | `--project <id>` | 项目详情：背景、引导词、默认交付引导、AI 验证默认值<br/>例：`ReqFlow.exe --cli project show --project <id>` |
| `guidance set` | `--project <id> --text <引导词> [--delivery <交付引导>]` | 更新项目引导词（guideVersion +1，旧版本进入历史）；旧批次快照会提示失效<br/>例：`ReqFlow.exe --cli guidance set --project <id> --text "遵循现有架构"` |

## 需求

需求状态流：待执行 ready → 执行中 in_progress → 待验证 pending_verification → 归档 archived。只有待执行需求可编辑。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `item add` | `--project <id> [--title <标题>] [--body <说明>] [--type feature|improvement|bug] [--priority P0|P1|P2] [--criteria <条件>] [--delivery <交付引导>] [--date YYYY-MM-DD] [--executor ai|human|plugin:<id>|agent:<id>]` | 新增需求（保存后即为待执行）。标题选填，留空时 Prompt 中仅显示需求编号；type/priority 缺省为 feature/P1；executor 缺省为 ai；criteria 用分号或换行分隔多条验收条件<br/>例：`ReqFlow.exe --cli item add --project <id> --title "登录限流" --type bug --priority P0 --criteria "连续失败5次锁定;解锁需管理员"` |
| `item list` | `[--project <id>] [--status <状态>] [--search <关键词>] [--executor <执行器>]` | 需求列表（默认排除已归档；不传 --project 时返回全部项目并附 projectId）<br/>例：`ReqFlow.exe --cli item list --status ready` |
| `item show` | `--project <id> --id <需求ID>` | 需求详情（含验收条件、版本、未解决问题）<br/>例：`ReqFlow.exe --cli item show --project <id> --id <需求ID>` |
| `item edit` | `--project <id> --id <需求ID> [--title/--body/--type/--priority/--criteria/--delivery/--date/--executor]` | 编辑待执行需求，只改传入的字段（未传字段保留原值）；每次编辑版本 +1<br/>例：`ReqFlow.exe --cli item edit --project <id> --id <需求ID> --priority P0` |
| `item history` | `--project <id> --id <需求ID>` | 需求的操作与验证历史<br/>例：`ReqFlow.exe --cli item history --project <id> --id <需求ID>` |

## Prompt 批次

从待执行或执行中需求生成快照批次：执行中的需求可与新增需求累积生成。生成 → 复制给 AI → 确认提交 → 实现完成 → 人工验证。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `generate` | `--project <id> --items <id1,id2,...>` | 按给定顺序从待执行或执行中需求生成 Prompt 批次（执行中需求可与新增需求累积生成，也可单独生成；状态 draft，含全文与 SHA-256）<br/>例：`ReqFlow.exe --cli generate --project <id> --items <id1>,<id2>` |
| `batch list` | `--project <id>` | 批次列表：编号、状态（未提交/已提交/已取消）、需求、哈希<br/>例：`ReqFlow.exe --cli batch list --project <id>` |
| `batch show` | `--project <id> --id <批次ID> [--out <file>]` | 批次详情，含 Prompt 全文（可直接 --out 保存为 .md 交给 AI）<br/>例：`ReqFlow.exe --cli batch show --project <id> --id <批次ID> --out prompt.md` |
| `submit` | `--project <id> --batch <批次ID>` | 确认已提交给 AI；批次内需求进入执行中（已执行中的需求保持执行中并记录新批次）<br/>例：`ReqFlow.exe --cli submit --project <id> --batch <批次ID>` |
| `cancel` | `--project <id> --batch <批次ID>` | 取消已提交批次；执行中需求退回待执行（若仍被其他已提交批次包含则保持执行中）<br/>例：`ReqFlow.exe --cli cancel --project <id> --batch <批次ID>` |

## 执行与验收

对单条需求推进状态；验证未通过的原因会自动带入下一轮 Prompt。

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `complete` | `--project <id> --id <需求ID> [--link <链接>] [--note <完整报告>] [--summary <50字内完成说明>] [--batch <排期批次ID> --item-version <版本>] [--run <运行ID> [--usage <JSON数组> | --session <会话ID>]]` | 实现完成：执行中或有效排期 → 待验证；summary 显示在验证提示上方，省略时从 note 提取最多50字；带 batch/item-version 时原子核对 AI 执行标识及排期版本；带 run 未传 usage 时按领取客户端（Codex/Claude Code/Pi/ZCode/DeepSeek Harness）读取 --session 或继承会话变量对应的本机会话用量<br/>例：`ReqFlow.exe --cli complete --project <id> --id <需求ID> --summary "已完成布局调整，构建检查通过"` |
| `item completion-note` | `--project <id> --id <需求ID> --summary <50字内完成说明> [--item-version <版本>]` | 补写当前版本待验证需求的开发完成说明；空白、超过50字或非待验证状态均拒绝<br/>例：`ReqFlow.exe --cli item completion-note --project <id> --id <需求ID> --summary "已补齐CLI接口，生命周期检查通过"` |
| `revert` | `--project <id> --id <需求ID> [--note <原因>]` | 退回待执行：执行中 → 待执行（退回后可编辑，同批次其他需求不受影响）<br/>例：`ReqFlow.exe --cli revert --project <id> --id <需求ID>` |
| `verify` | `--project <id> --id <需求ID> --pass <true|false> [--note <原因>]` | 人工验证：通过 → 归档；未通过 → 退回待执行并记录原因<br/>例：`ReqFlow.exe --cli verify --project <id> --id <需求ID> --pass false --note "样式未生效"` |
| `regress` | `--project <id> --id <需求ID> [--note <回归原因>]` | 归档需求回归：退回待执行，原因带入下一轮 Prompt<br/>例：`ReqFlow.exe --cli regress --project <id> --id <需求ID> --note "线上复现"` |
| `archive` | `--project <id> --id <需求ID>` | 直接归档需求（保留历史）<br/>例：`ReqFlow.exe --cli archive --project <id> --id <需求ID>` |

## 说明

- 所有命令输出单行 JSON：成功 {"ok":true,...}，失败 {"ok":false,"error":"原因"}；退出码成功 0、失败 1，便于脚本与 Agent 判断。
- Windows 图形界面程序的输出在「直接双击 / 部分终端直接运行」时可能不显示；用管道或重定向一定能拿到：ReqFlow.exe --cli help | more，或 ... > out.json。子进程（spawn/execFile）管道读取始终有效。
- CLI 与图形界面共用同一份 workspace.json。界面按所触及项目的 revision 比对，同项目变化提示冲突，其他项目变化可安全重读合并；全局操作仍比对工作区版本。CLI 冲突自动重读重试，文件提交使用短时跨进程锁。
- 常用 id 获取顺序：project list → item list / batch list。需求 id、批次 id 均为 UUID。
- 典型 Agent 对接流程：project list → item add（若干条）→ item list 取 id → generate → batch show 取 Prompt 全文发给模型 → submit → （模型完成后）complete → verify。

## 典型 Agent 工作流

```text
project list
→ item add（若干条）→ item list 取需求 id
→ generate --items id1,id2 → batch show 取 Prompt 全文交给模型
→ submit →（模型实现完成后）complete
→ verify --pass true|false（未通过原因自动带入下一轮 Prompt）
```
