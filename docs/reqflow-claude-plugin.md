# ReqFlow Claude Code 插件

日期：2026-10-14。插件源码：`plugins/reqflow-agent-claude/`，版本 0.1.0。与 Codex（`plugins/reqflow-agent`）、ZCode（`reqflow-agent-zcode`）、Pi（`reqflow-agent-pi`）三套宿主插件并列，领取与回写协议一致。

## 工作方式

Claude Code 在目标代码项目的会话中执行插件技能：按当前 cwd 的 realpath 匹配 ReqFlow 的 Project.dir → 从有效排期（draft 或 submitted）领取 executor=ai 的 ready/in_progress 需求，无需点击提交 → 实现与检查 → 逐条 complete → pending_verification。不会代替用户 verify 或归档。

宿主标识为 `claude-code`：领取记录的 client、CLI `execution claim --client` 与 `plugin version/bundle --host` 均使用该值；ReqFlow「执行中」页显示为 Claude Code。需要 ReqFlow 2.2.4+（原子领取）或对应能力版本。

同名项目依目录区分；在项目子目录中调用时选择最长匹配根目录，同目录多项目报错。不同 worktree 必须在 ReqFlow 分别关联目录。没有目录绑定时请点击 ReqFlow 项目的「浏览项目」。

这是按用户请求运行的本地技能插件，安装不会后台轮询或主动启动会话。

## 安装

源码包含 `.claude-plugin/plugin.json` 清单、execute / setup 技能与零依赖 Node 桥接脚本。需要 Node >= 22；无需 npm install。插件更新通过本地 marketplace `reqflow-local` 自动完成（见下），首次安装两种方式：

```powershell
# 方式一：直接把插件目录所在的上层目录作为市场（市场文件在插件目录内无效，需在上级放 marketplace.json 时使用仓库根 staging 布局）
# 方式二（推荐）：安装后由插件自更新流程接管
claude plugin marketplace add <包含 .claude-plugin/marketplace.json 的目录>
claude plugin install reqflow-agent-claude@reqflow-local
```

私有分发：构造 staging 目录，写入 `.claude-plugin/marketplace.json`（`name: reqflow-local`、`owner`、`plugins: [{name, source: "./reqflow-agent-claude"}]`）与插件目录副本，对 staging 执行上面两条命令。

## 首次配置

安装后调用 setup 技能，或在会话中运行源码脚本：

```powershell
node E:\project\reqFlow\plugins\reqflow-agent-claude\scripts\reqflow.mjs doctor
node E:\project\reqFlow\plugins\reqflow-agent-claude\scripts\reqflow.mjs configure --exe "D:\Apps\ReqFlow\ReqFlow.exe"
```

路径仅为示例。自选数据目录添加 `--data-dir "D:\ReqFlowData"`；开发版已有 dist 构建时给 `--app <源码根目录>`。检查 doctor 的 dataFile 与 ReqFlow 界面「帮助」中的路径一致。

默认配置在用户 `.reqflow-claude-code/config.json`，与 Codex / ZCode / Pi 版插件互相独立。环境变量 REQFLOW_EXE、REQFLOW_DATA_DIR、REQFLOW_PLUGIN_CONFIG 可覆盖；read 发现数据文件不存在时拒绝，不自动创建空工作区。run 快照保存在配置文件旁的 runs 目录，含需求内容，不要分享。

## 日常使用

在 ReqFlow 生成 Prompt 后，需求已进入「执行中」、批次为 submitted。在匹配目录的会话里说：

> 执行 ReqFlow 中当前项目已提交的需求，完成后转入待验证。

或输入 `/reqflow-agent-claude:execute`。技能读取完整正文、验收条件、交付引导与批次 Prompt，执行当前范围。仅查看 / 分析请求使用 `inspect`，不领取、不锁定、不回写。完成报告写入需求历史；ReqFlow 已打开时需要刷新以看到 CLI 回写。

可手动检查领取结果：

```powershell
node E:\project\reqFlow\plugins\reqflow-agent-claude\scripts\reqflow.mjs read --cwd "E:\project\目标项目"
```

完成时传入 JSON 报告文件：

```json
{"items":[{"id":"本轮需求ID","summary":"实现说明","validation":"检查命令及结果，或未运行原因"}]}
```

```powershell
node E:\project\reqFlow\plugins\reqflow-agent-claude\scripts\reqflow.mjs complete --cwd "E:\project\目标项目" --run "<read返回的runFile>" --report "<报告JSON绝对路径>"
```

脚本拒绝未领取、重复 ID、工作目录变化、项目绑定变化、旧版本 / 新批次 / 项目设置变化。处理结果包含 outcomes 和 unprocessed，部分完成不会伪装成全量成功。

## 插件自更新

read / doctor / complete 启动前调用 ReqFlow `plugin version --host claude-code` 比对版本。内置版本更新时下载 `plugin bundle`，校验 SHA256 与清单后写入 staging 目录，用 `claude plugin marketplace remove/add` 重建 `reqflow-local` 市场并 `claude plugin install reqflow-agent-claude@reqflow-local --json`。既有市场仅在本插件名匹配时才替换；安装失败恢复原市场来源。更新后需 `/reload-plugins` 或重启会话；当前命令自动使用最新桥接脚本。

## 技术边界

插件完全复用 ReqFlow 的 JSON CLI，使用 execFile 参数数组，不拼 shell 命令，不直接修改业务数据文件。生产应用代码保持不变。

complete 写前核对完整快照、写后核对状态与历史，但仍有检查与写入之间的并发窗口。当前不提供多 Agent 原子领取锁，不保证 exactly-once。使用期间避免同时操作同一需求；错误后检查回执与 ReqFlow 当前状态，勿盲重试。中断任务由用户在「执行中」页确认释放（或 CLI execution release），释放后旧运行记录不能回写。

## 验证

运行 `node scripts/plugin-update-check.mjs` 覆盖版本协商、SHA256、非法路径与四个宿主的安装阻塞。Go 侧 `go test ./...` 覆盖 claude-code 的并发领取与插件版本查询。安装冒烟：`claude plugin validate plugins/reqflow-agent-claude` 通过后，实际 `marketplace add + install` 验证技能被宿主发现。CLI 集成通过不代表模型实际实现需求正确，人工验收保留。
