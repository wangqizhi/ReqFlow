# ReqFlow Codex 插件

日期：2026-10-09。插件源码：`plugins/reqflow-agent/`，版本 0.2.0。

## 工作方式

Codex 在目标代码项目的聊天中执行插件技能：按当前 cwd 的 realpath 匹配 ReqFlow 的 Project.dir → 从有效排期（draft 或 submitted）领取 executor=ai 的 ready/in_progress 需求，无需点击提交 → 实现与检查 → 逐条 complete → pending_verification。不会代替用户 verify 或归档。

同名项目依目录区分；在项目子目录中调用时选择最长匹配根目录，同目录多项目报错。不同 worktree 必须在 ReqFlow 分别关联目录。没有目录绑定时请点击 ReqFlow 项目的“浏览项目”。

这是按用户请求运行的本地技能插件，安装不会后台轮询或主动启动 Codex 聊天。

## 安装

源码包含 root plugin.json、Codex 兼容 manifest、execute / setup 技能和零依赖 Node 桥接脚本。仓库 marketplace 位于 `.agents/plugins/marketplace.json`；插件打包 ZIP 位于 `out/reqflow-agent-0.2.0.zip`。

需要 Node >= 22；无需 npm install。当前 Codex CLI 0.153.0 支持：

```powershell
codex plugin marketplace add E:\project\reqFlow
codex plugin add reqflow-agent@reqflow-local
```

在其他机器上替换为实际源码根目录。也可在 Codex 插件目录中选择本地 marketplace 安装。ZIP 用于私有分发：解压后保留单一插件目录，放入本地 marketplace 的 plugins 下并声明 source.path，再安装。

采用官方本地插件包与 marketplace 格式，参见 [Package your plugin](https://developers.openai.com/plugins/build/plugins)。本次交付提供可安装源码和私有 ZIP，不上传账号或公开目录，也不改变用户已安装插件。

## 首次配置

安装后调用 setup 技能，或运行源码脚本：

```powershell
node E:\project\reqFlow\plugins\reqflow-agent\scripts\reqflow.mjs configure --exe "D:\Apps\ReqFlow\ReqFlow.exe"
node E:\project\reqFlow\plugins\reqflow-agent\scripts\reqflow.mjs doctor
```

路径仅为示例。自选数据目录添加 `--data-dir "D:\ReqFlowData"`。不覆盖时复用应用自身的目录解析，包括安装标记和便携版数据路径。检查 doctor 的 dataFile 与 ReqFlow 界面“帮助”中的路径一致。

开发版已有 dist 构建时可将 executable 指向 `node_modules/electron/dist/electron.exe`，configure 加 `--app <源码根目录>`；避免用该方式误读另一个空的开发工作区。

默认配置在用户 `.reqflow-codex/config.json`。环境变量 REQFLOW_EXE、REQFLOW_DATA_DIR、REQFLOW_PLUGIN_CONFIG 可覆盖；read 发现数据文件不存在时拒绝，不自动创建空工作区。run 快照保存在配置文件旁的 runs 目录，含需求内容，不要分享。

## 日常使用

在 ReqFlow 生成 Prompt 后，需求已进入“执行中”、批次为 submitted。在匹配目录的 Codex 聊天里说：

> 执行 ReqFlow 中当前项目已提交的需求，完成后转入待验证。

技能读取完整正文、验收条件、交付引导与批次 Prompt，执行当前范围。仅查看 / 分析请求不会触发实现或完成回写。未完成条目保留执行中；完成报告写入需求历史。ReqFlow 已打开时需要刷新以看到 CLI 回写。

可手动检查领取结果：

```powershell
node E:\project\reqFlow\plugins\reqflow-agent\scripts\reqflow.mjs read --cwd "E:\project\目标项目"
```

返回 runFile、本轮 requirements 和只作上下文参考的 batches。批次全文可能包含已经待验证或不在本轮范围的需求，执行范围以 requirements 为准。

完成时传入 JSON 报告文件：

```json
{"items":[{"id":"本轮需求ID","summary":"实现说明","validation":"检查命令及结果，或未运行原因"}]}
```

```powershell
node E:\project\reqFlow\plugins\reqflow-agent\scripts\reqflow.mjs complete --cwd "E:\project\目标项目" --run "<read返回的runFile>" --report "<报告JSON绝对路径>"
```

脚本拒绝未领取、重复 ID、工作目录变化、项目绑定变化、旧版本 / 新批次 / 项目设置变化。处理结果包含 outcomes 和 unprocessed，部分完成不会伪装成全量成功。已经由同一次 run 完成且当前记录一致的条目可安全重复查询。

## 技术边界

插件完全复用 ReqFlow 的 JSON CLI，使用 execFile 参数数组，不拼 shell 命令，不直接修改业务数据文件。生产应用代码保持不变。

现有 complete 没有条件版本参数；插件在写前核对完整快照、写后核对状态与历史，但仍有检查与写入之间的并发窗口。当前不提供多 Agent 原子领取锁，不保证 exactly-once。使用期间避免同时操作同一需求；错误后检查回执与 ReqFlow 当前状态，勿盲重试。后续可由 ReqFlow 新增原子领取 / 条件完成事务接口补齐。

若CLI写回成功但保存run回执失败，重试会报冲突而不是再次完成；用户可在需求历史里核对带 run ID 的记录。

## 验证

运行 `node scripts/plugin-e2e.mjs`：临时构建主进程，使用真实 Electron CLI 和独立临时 workspace，覆盖中文路径、同名 / 重复 / 嵌套目录、状态筛选、正文读取、部分完成、重试、同版本新批次、需求编辑和引导词变更。测试不操作真实用户需求。

还需安装后在新聊天验证技能被宿主发现和实际调用；CLI 集成通过不代表已在当前聊天热加载。本文不声称已验证模型实际实现需求。

## 0.2.0 执行方式

新需求默认 executor=ai；人工任务使用 human，其他执行器使用 plugin:<id> 或 agent:<id>。旧需求未设置该字段时兼容为 ai。只领取有效排期中的 AI 任务，未排期、已退回、已取消、过期快照及其他执行器任务不领取。完成回写需要支持 scheduled-ai-complete 的新版 ReqFlow 桌面程序（1.10.3 起）；旧程序会被阻止回写。CLI complete 携带 --batch 和 --item-version 在存储操作内重新检查排期和版本。
