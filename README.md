# ReqFlow · 需求流

把想法整理成可执行需求，交给 AI 编码，再把实现结果带回人工验证。

ReqFlow 2.0 是面向个人开发者的 Windows 桌面工作台，使用 Go/MyGO 后端、系统 WebView2 和 React 界面。它把多项目需求管理、Prompt 生成、AI 需求讨论、项目文件浏览和 Git 操作放在同一个应用中，也提供 CLI 与 Agent 插件，方便编码助手读取需求和回写实现结果。运行时不包含 Node 或 Electron。

核心需求管理在本机运行，无需登录。AI 调用、远程 Git 操作和远程备份需要联网及相应配置。当前源码版本见 [package.json](package.json)。

[2.0 安装升级与绿色版说明](docs/mygo-portable.md)。新版安装器沿用原安装位置与数据标记，仅清理明确的旧 Electron/Node 组件，保留旧工作区、图片、AI 设置和用户文件。

## 2.13.3 更新

- 关联 Server Agent 的项目待验证需求也显示“在版本 X 及以上验证”。
- 终端收起后只保留底部一行信息栏，PowerShell 与其他终端入口并排。
- Server Agent 的新增、安装、远程卸载与配置改为弹出浮层。
- 详见 [2.13.3 版本说明](docs/release-2.13.3.md)。

## 2.13.2 更新

- 启动先显示本地项目，Server Agent 连接改为后台异步进行；连接期间显示加载提示，操作关联远程的项目会等待连接完成。
- 详见 [2.13.2 版本说明](docs/release-2.13.2.md)。

## 2.13.1 更新

- 项目浏览窗口去掉系统标题栏，最大化/还原按钮放在关闭按钮旁；打开时先显示本地数据并带加载动画。
- 待验证需求自动显示“在版本 X 及以上验证”。
- 终端默认在项目目录启动 PowerShell。
- Agent 只完成部分需求时自动推动它继续；会话结束后未完成的需求退回排期表。
- 详见 [2.13.1 版本说明](docs/release-2.13.1.md)。

## 2.13.0 更新

- 项目浏览器使用独立窗口，支持最大化；终端可在项目目录打开 PowerShell 标签页。
- 待验证需求可记录适用的验证版本。
- Server Agent 支持通过免密 SSH 获取访问令牌，新增与安装入口合并；远程卸载后清理对应配置并切回项目本地备份。
- 详见 [2.13.0 版本说明](docs/release-2.13.0.md)。

## 2.12.5 更新

- 本地 Git 仓库可使用提交、分支和历史操作；未配置远程仓库时隐藏推送操作。
- 记录需求不再显示交付引导输入框，交付引导由项目设置管理。
- Server Agent 管理入口移至「插件 / MOD / AGENT」。
- 详见 [2.12.5 版本说明](docs/release-2.12.5.md)。

## 2.12.0 更新

- 新增远程同步服务端（Server Agent）：独立入口命令 `ReqFlow.exe server` / `reqflow-server`（随包附带 Linux amd64/arm64），单命令 `--port / --data-dir / --config` 启动，支持注册 Windows 服务或 systemd，令牌认证，数据目录与客户端隔离。
- 客户端与服务端支持「自签证书 + 首次指纹确认」和「受信任 CA」两种信任模式；指纹变化阻断连接并提示重置，令牌与指纹本地加密保存，连接测试区分网络 / 证书 / 令牌三类失败。
- 「插件 / MOD / AGENT」提供 Server Agent 分类：多套服务端配置、连接状态与失败原因展示、手动断开重连、SSH 自动安装到免密登录的 Linux 服务器。
- 项目设置新增「远程同步」：关联后 flow 数据每次变更自动推送服务端（本地保留一份），支持手动推送与拉取，解除关联继续使用本地数据。
- 「记录新需求」展开后标题与验收条件各占一整行，标题单行、验收条件多行。
- 详见 [2.12.0 版本说明](docs/release-2.12.0.md) 与 [Server Agent 部署指南](docs/server-agent.md)。

## 2.11.25 更新

- 「插件 / MOD 说明」页占满右侧工作区宽度，正文不再被限制在中间一段阅读宽度，长表格与代码块随页面展开。
- 说明页正文与页头左侧对齐，滚动到底部保留适当留白；Local Agent 与实验室页签布局保持不变。
- 详见 [2.11.25 版本说明](docs/release-2.11.25.md)。

## 2.11.24 更新

- 修正插件、设置侧栏菜单与首页「我的项目」标题行的字号和颜色差异，统一系统字体、11px 字号、常规字重、字距及灰色文字。
- 返回项目菜单与上下文管理菜单同步对齐，选中状态通过背景区分。
- 详见 [2.11.24 版本说明](docs/release-2.11.24.md)。

## 2.11.23 更新

- 停止终端 CLI 或 CLI 自行退出后，自动释放本会话仍在执行的需求，保留结束时间与用时，可在排期表重新指派；已完成需求继续保留人工验收。
- 隐藏 xterm 6 自带的浮动滚动条，指派终端仅保留右侧历史滚动条。
- 插件与设置左侧菜单统一使用项目菜单的系统字体、14px 正文、行高与配色，选中态保持相同字重。
- 详见 [2.11.23 版本说明](docs/release-2.11.23.md)。

## 2.11.22 更新

- 插件 / MOD / AGENT 改为右侧整页工作区，左侧菜单切换接入说明、Local Agent 与实验室。
- 保留 Agent 自动检测、更新数量提示和实验室配置，内容区独立滚动，可返回原项目。
- 详见 [2.11.22 版本说明](docs/release-2.11.22.md)。

## 2.11.21 更新

- DeepSeek Harness 在同一终端中复用运行实例与 Agent，连续沟通不再逐轮重启；上一批进入待验证后可在原实例接收新指派，`/new` 仅切换会话。
- 最大化终端保留当前项目的 CLI / 发布标签页，切换后继续原会话，关闭独立窗口恢复停靠显示。
- 指派终端展开时隐藏底部重复的「打开终端」按钮。
- 详见 [2.11.21 版本说明](docs/release-2.11.21.md)。

## 2.11.20 更新

- 终端会话页签移至底部，使用纯色标签页样式并去除底部分隔黑线。
- 移除侧栏「协作项目」及开发中占位说明。
- 插件模块统一导航、卡片、按钮和说明布局，较低窗口下内容独立滚动。
- 详见 [2.11.20 版本说明](docs/release-2.11.20.md)。

## 2.11.19 更新

- 终端 CLI / 发布页签改为标签页样式：去掉渐变背景，活动页签与终端内容连成一体。
- 指派终端隐藏 xterm 自带滚动条，只保留最右侧历史滚动条。
- 详见 [2.11.19 版本说明](docs/release-2.11.19.md)。

## 2.11.18 更新

- 终端收起时恢复原有打开标题，展开后在标题下方显示 CLI / 发布页签，以渐变背景衔接终端内容。
- 生成 Prompt 的引导词标题增加严格执行要求的说明。
- 我的项目搜索框取消内发光，保留细描边与焦点提示。
- 详见 [2.11.18 版本说明](docs/release-2.11.18.md)。

## 2.11.17 更新

- 侧栏新增「执行中」，汇总所有项目正在执行的需求，显示所属项目、执行客户端、开始时间与实时用时，并支持进入对应项目。
- 终端支持 CLI 与发布页签切换；发布时自动打开发布页签，保留 CLI 等待输入的会话。
- 排期表提交验证弹窗的单条与批量指派按钮统一显示 CLI 名称。
- 详见 [2.11.17 版本说明](docs/release-2.11.17.md)。

## 2.11.16 更新

- 我的项目搜索框改为淡灰细描边与顶部内渐变反光，降低在深色侧栏中的存在感；保持 20px 行高、文字内间距与结尾清除按钮。
- 详见 [2.11.16 版本说明](docs/release-2.11.16.md)。

## 2.11.15 更新

- 我的项目标题旁新增紧凑搜索框，按项目名称筛选，支持清除与 Esc 重置，不增加标题行高度。
- 指派 CLI 的交互终端在需求待验证期间继续保持会话；全部关联需求归档或移除后停止，保留历史输出。
- 批量指派按钮直接显示 CLI 名称。
- 指派的 DeepSeek Harness 默认以完全访问运行（`DSH_PERMISSION_MODE=danger-full-access`），与 Codex 指派一致，不再被工作区沙箱或无人应答的审批阻断；可用 `REQFLOW_DSH_PERMISSION_MODE` 收紧。
- 详见 [2.11.15 版本说明](docs/release-2.11.15.md)。

## 2.11.14 更新

- 安装检查发现执行中任务且用户取消时，恢复 ReqFlow 窗口；应用已退出时重新打开已安装版本。
- 指派 Agent 终端新增常驻历史滚动条，支持查看最多 20000 行输出；任务完成后保留终端和最后输出，收起后可重新打开。
- 详见 [2.11.14 版本说明](docs/release-2.11.14.md)。

## 2.11.13 更新

- 「提交验证」指派 DeepSeek Harness 改为交互终端：首轮执行指派任务后可在同一终端继续输入，与 Codex / Claude Code 的交互方式一致。
- 终端显示 DSH 的思考摘要、工具调用与结果；`Ctrl+C` 中止当前一轮，`/new` 开新会话，`/exit` 退出，每轮沿用同一个 DSH 会话保持上下文。
- 交互终端客户端随程序内嵌，运行时释放到临时目录；DeepSeek Harness 仍使用 headless profile，需要 Node.js 22+、可用的 `dsh` 命令，并在该 profile 安装 `reqflow-agent-dsh` 插件与配置模型。
- 只读任务日志仅保留给 ZCode；详见 [2.11.13 版本说明](docs/release-2.11.13.md)。

## 2.11.12 更新

- 「提交验证」指派新增 Claude Code 与 DeepSeek Harness：Claude Code 在项目目录以交互终端执行单条或合并需求，DeepSeek Harness 使用 headless profile 执行一次任务并显示只读日志。
- 「插件 / MOD / AGENT → Local Agent」新增两张卡片，可分别开启或关闭指派，并检测是否安装、当前版本与 npm 是否有更新，支持一键安装或更新到最新版。
- 检测摘要、页签角标与安装数量统计同时覆盖这两个 Agent；版本比较支持 `0.2.1-rc.2` 这类预发布版本。
- DeepSeek Harness 指派需要在该 headless profile 安装 `reqflow-agent-dsh` 插件并配置模型，完成状态以插件回写为准；执行中页面与数据看板统一显示为 DeepSeek Harness。
- 详见 [2.11.12 版本说明](docs/release-2.11.12.md)。

## 2.11.11 更新

- 执行 Agent CLI 任务时关闭程序会弹出确认，默认继续运行；确认强制关闭后释放任务，使其返回排期表。
- 安装向导与应用内更新也检查执行中任务，取消确认或释放失败则停止操作。
- 详见 [2.11.11 版本说明](docs/release-2.11.11.md)。

## 2.11.10 更新

- Local Agent 实验室主动检测：打开面板即在后台检测 Codex、Pi、OpenCode、ZCode 是否安装、版本是否需要更新，不再需要先点检测按钮。
- 进入「Local Agent」页签或窗口重新获得焦点时刷新结果，5 分钟内复用上一次结果；页签用橙色数字提示有可用更新的 Agent 数量。
- 状态行显示检测时间、已安装数量与可更新数量，单个 Agent 卡片显示已安装版本、最新版本与是否需要更新；命令缺失、版本无法识别或 npm registry 不可用时分别说明原因。
- 实验室页签同步显示 Agent 安装与更新摘要，可直接触发重新检测。
- 详见 [2.11.10 版本说明](docs/release-2.11.10.md)。

## 2.11.9 更新

- 指派 Codex / Pi / ZCode 的交互终端新增最大化按钮，在独立窗口继续同一个会话，与发布终端一致。
- 最大化后主界面隐藏停靠终端；关闭窗口不结束会话，可通过标题栏的 Agent 终端按钮把窗口切回前台。
- 需求全部完成或移除时，停靠终端与独立窗口一起关闭。
- 详见 [2.11.9 版本说明](docs/release-2.11.9.md)。

## 2.11.8 更新

- 发布前自动将当前版本之前最近两个版本的产物移入 `release/backup/<版本>/`；保留当前版本和公共文件，备份重名时停止且不覆盖。
- 发布流程仅生成和上传 Setup 安装版、校验文件及更新元数据，不再生成或上传 Portable 绿色版。
- 修复 ZCode 指派的 CLI 能力检测失败：自动发现桌面安装包内的 Provider 配置，检测与执行共用配置，保留用户自定义路径。
- 能力检测失败时显示具体错误，对诊断信息限长并脱敏；真实模型执行及套餐计费仍需端到端验证。
- 详见 [2.11.8 版本说明](docs/release-2.11.8.md)。

## 2.11.7 更新

- Codex 默认出现在已开启的指派入口中，实验室保留调起 Codex 桌面窗口功能。
- Local Agent 集中配置 Pi、OpenCode、ZCode；Codex / Pi / OpenCode 支持版本检测和点击安装、更新，ZCode 仅检测官方安装。
- ZCode 可执行单条或合并需求，显示只读流式任务日志，以插件领取与待验证回写为准；采用显式 build 权限、任务文件、超时与进程树取消。
- ZCode 需要完整官方 CLI 资源、Node.js 及有效模型 / 登录配置。自定义入口可设置 `REQFLOW_ZCODE_CLI`，时限可设置 `REQFLOW_ZCODE_TIMEOUT`（默认 2h，1m–24h）。当前机器官方 bundle 缺少 provider 配置资源，真实模型执行仍需修复官方安装后验收。
- 安装向导首次显示在鼠标所在屏幕的工作区中央。

## 2.11.6 更新

- 排期表右下角「提交验证」支持将当前列表合并为一份 Prompt，一次指派给 Codex / pi；单条入口仍独立指派。
- 批量会话跟踪全部需求，全部完成后自动关闭终端；指派入口继续由实验室「指派」开关控制。

## 2.11.5 更新

- 实验室新增「指派」开关：开启后，排期表单条与右下角整个列表的「提交验证」弹窗才会显示指派浮层，可逐条选择 Codex / pi 在交互终端执行。
- 关闭「指派」时，「提交验证」弹窗只保留是否确认完成；指派 Codex / pi 同样受这个开关控制。

## 2.11.4 更新

- 指派 pi 的交互终端以 `--approve` 启动，自动信任项目目录，不再停在「Trust / 信任目录」确认提示上；信任仅对本次会话生效。

## 2.11.3 更新

- 指派 Codex 的交互终端改为完全控制模式启动（`--sandbox danger-full-access`），不再受沙箱权限限制。
- 指派入口移入「提交验证」弹窗：每条需求可选择 Codex / pi 在交互终端执行，排期表原「指派」按钮移除。
- pi 与 Codex 支持相同的终端指派；一次仍指派一条需求，每个项目保留一个运行中的会话，接口接收需求 ID 数组预留批量扩展。
- 指派后需求立即进入「执行中」；终端可能等待输入时，「执行中」页签红色提醒。
- 需求完成转入待验证后自动停止并关闭对应终端会话。

## 2.11.2 更新

- 项目分别记住 Flow 页签，切换项目或重新打开后恢复上次位置。
- 记录新需求时继续刷新 Flow，Agent 回写待验证不打断表单；修复 Windows 写入锁交接时偶发的拒绝访问。
- 实验室开启 Codex 后，排期表通过「指派」选择 Codex，在项目目录启动交互式 CLI 终端；可输入沟通、收起后恢复和停止会话。保留调起 Codex 桌面窗口功能。
- 当前一次指派一条需求，每个项目同时保留一个运行中的 Codex 会话；接口接收需求 ID 数组，预留批量扩展。需要本机已安装并登录 Codex CLI，沿用其权限与确认设置。

## 2.11.1 更新

- 需求池支持延迟与取消延迟；全选跳过延迟需求，仍可手动勾选和单条排期，延迟状态随工作区保存。

## 2.11.0 更新

- Agent 技能明确先领取需求、再阅读源码与分析实现，尽快显示执行中；只读查看继续使用 inspect。
- 项目守则仅引用功能关联的上下文，正文按需通过 `context show --id <ID>` 获取；返回总结文件与原始代码目录。
- 上下文卡片以 Markdown 预览正文与补充说明。
- 新需求窗口可合并 Agent 回写引起的版本变化，保留输入并正常保存、关闭；其他窗口修改同一草稿时仍提示冲突。
- 发布开始自动打开终端显示进度，启动应用仍保持收起；支持手动关闭和重新打开。

## 2.10.3 更新

- 每条上下文使用独立目录：总结保存在 summary.md，相关代码按项目相对路径保留为原始文件，随上下文保存、迁移与 Git 提交。
- 功能转上下文生成的需求通过 CLI --files 收集实际代码文件；上下文卡片可打开独立目录。无 Git 时提示安装。
- 新建项目未填写名称时，选择本地或远程目录会自动填入末级文件夹名。
- 终端在启动和发布时默认收起，界面名称统一为“终端”。

## 2.9.2 更新

- 记录或编辑需求时，顶部使用透明拖动浮层，移除新增标题栏，保留原界面外观。
- 项目设置支持删除守则，删除前弹窗确认；保留上下文文档，停止自动加入后续 Prompt，并可重新生成。
- Agent 插件无变动，版本保持不变。

## 下载与安装

前往 [GitHub Releases](https://github.com/wangqizhi/ReqFlow/releases) 下载已发布的 Windows x64 安装包：

| 文件 | 用途 |
| --- | --- |
| `ReqFlow-Setup-<版本>.exe` | 向导安装，可选择安装位置与数据目录 |
| `SHA256SUMS-<版本>.txt` | 安装包 SHA256 校验值 |

安装版的数据目录由安装向导选择，默认 `%APPDATA%\ReqFlow`。便携版移动时应一起移动 `data/`。升级或迁移前，可在应用中导出完整备份。

## 从记录想法到验证归档

1. **创建项目**：填写项目背景和交付要求，可关联本地目录、通过免密 SSH 绑定远程目录，或配置 GitHub/GitLab 仓库拉取本地文件。项目可以按文件夹分组，通过置顶与鼠标拖拽排序。
2. **记录需求**：在需求池填写说明，选择新需求、优化或修复，以及 P0–P2 优先级；可补充验收条件、排期日期、参考图片与交付引导。
3. **安排开发**：选择本轮需求进行排期，生成包含背景、需求、验收要求与交付指引的 Prompt，交给编码助手。Agent/CLI 也可以读取已提交的批次。
4. **提交验证**：实现完成后转入待验证，人工通过后归档；未通过时记录问题并退回，问题会进入后续 Prompt。实验室打开「指派」后，单条与整个列表的提交验证浮层都可以逐条指派 Codex / pi / Claude Code 在交互终端执行，或由 DeepSeek Harness 在常驻交互终端、ZCode 在只读任务日志中执行，终端可收起、重新打开或最大化到独立窗口。
5. **继续迭代**：归档需求可以重新打开，历史排期可在归档中的「批次历史」查看。

应用保留需求版本、批次快照和验证记录，便于追踪多轮开发。需求可以迁移到其他项目，排期支持日期筛选。

## 项目工作台

- **AI 需求助手**：根据项目上下文整理想法、讨论建议，确认候选后加入需求池。在「设置 → AI 供应商」保存并切换多套配置，支持 OpenAI / Anthropic API，以及 Codex、ZCode、Pi、Claude Code 本地 CLI。CLI 复用本机登录，可检测安装与版本；有可靠来源时显示近期周/月额度快照。
- **项目文件浏览**：查看 Markdown、图片和文本，编辑文本并使用 `Ctrl+S` 保存；支持语法高亮及文件右键操作。
- **Git 面板**：初始化仓库、查看变动、暂存、提交、管理分支，以及 Pull/Push。AI 可根据实际暂存 diff 生成提交文案。Git 功能需要本机安装 Git。
- **远程仓库与备份**：支持配置仓库地址、分支及 SSH Key 路径，测试连接，以及将工作区数据备份到远程仓库。
- **Agent 对接**：提供 Codex、ZCode、Pi、OpenCode、Claude Code 和 DeepSeek Harness 插件，用当前项目目录匹配需求，并将实现结果转入待验证。Local Agent 实验室打开即主动检测系统里的 Agent 是否安装与版本是否落后。

远程目录在新建项目或浏览项目时连接，使用本机 OpenSSH 默认密钥/SSH Agent，服务器需启用 SFTP；首次连接前请在终端核对主机指纹并加入 known_hosts。目前远程文件提供只读预览，不执行远程 Git、发布或 Agent 派发。远程项目位于「协作项目」下方，连接检查失败时显示红色断线标识。远程 Agent 后续接入见 [设计讨论稿](docs/remote-agent-execution-design.md)。

侧栏的「协作项目」目前是开发中入口；插件/MOD 页面提供协议说明，尚未实现通用 MOD 加载器。

## 数据与隐私

新工作区使用本地 `requirements.sqlite` 保存项目、需求、批次快照与历史；AI、Agent、备份等配置仍使用独立文件。GUI 与 CLI 共用领域逻辑和存储入口，写入使用事务、版本检查及进程锁，避免并发覆盖。需求按项目与批次独立存储，未变更的数据行不会重复写入；存储适配接口预留后续 MySQL / PostgreSQL 接入。

旧工作区继续读取 `workspace.json`，可在「插件/MOD/AGENT → 实验室 → 迁移到 SQLite」进行迁移。迁移会校验完整数据、保留原文件及带时间戳的备份，成功后 GUI、CLI 和远程备份统一读取数据库。迁移后原 JSON 不再更新，导出最新数据请使用应用或 `workspace export`。便携版迁移时仍需一起移动整个 `data/` 目录。

多套 AI 配置单独保存在 `ai-settings.json`，其中每套 API Key 使用 Go 调用 Windows DPAPI 加密，兼容读取原 Electron `safeStorage` 的 v10/v11 密文，不进入工作区导出或远程备份。原 `Local State` 加密密钥文件保留。AI 请求日志记录时间和请求元数据，不保存 Key、URL、需求正文或响应文案。使用 AI 功能时，相关项目上下文会发送到所配置的服务；本地 CLI 使用该 CLI 的账户与供应商。

设置入口位于侧栏底部，进入后通过左侧功能菜单切换分类。完整 JSON 备份在「设置 → 数据 → 导出全部数据」；导出读取当前完整工作区。

远程工作区备份可能包含需求、图片和本地路径，请选择适合存放这些数据的仓库。发布源码前应检查文件；`.gitignore` 已排除常见本地数据、密钥、缓存和构建产物，但不能自动识别所有私密内容。

## CLI 与插件

安装后可使用程序完整路径调用 CLI：

```powershell
& "C:\你的安装目录\ReqFlow.exe" --cli help
& "C:\你的安装目录\ReqFlow.exe" --cli project list --pretty
& "C:\你的安装目录\ReqFlow.exe" --cli item add --project <项目ID> --title "登录限流" --type bug --priority P0
& "C:\你的安装目录\ReqFlow.exe" --cli batch list --project <项目ID>
```

执行具体命令时，请将示例路径和 `<项目ID>` 替换为实际值。CLI 默认输出单行 JSON，退出码为 0 或 1；`--pretty` 用于人工阅读。Windows 图形程序在部分终端中可能不直接显示输出，可使用管道、重定向或子进程读取。

可通过 `--data-dir` 或 `REQFLOW_DATA_DIR` 覆盖数据目录。插件运行记录默认位于用户主目录下的 `.reqflow-codex/`、`.reqflow-zcode/`、`.reqflow-pi/`、`.reqflow-opencode/`、`.reqflow-claude-code/` 或 `.reqflow-dsh/`，其中包含本地需求快照。

- [完整 CLI 参考](docs/cli-reference.md)
- [Codex 插件接入](docs/reqflow-codex-plugin.md)
- [Codex 插件](plugins/reqflow-agent/README.md) · [ZCode 插件](plugins/reqflow-agent-zcode/README.md) · [Pi 插件](plugins/reqflow-agent-pi/README.md) · [OpenCode 插件](plugins/reqflow-agent-opencode/README.md) · [Claude Code 插件](plugins/reqflow-agent-claude/README.md) · [DeepSeek Harness 插件](plugins/reqflow-agent-dsh/README.md)
- [MOD 协议](docs/mod-protocol.md)

## 本地开发

开发构建需要 Windows x64、Node.js ≥ 22.13、npm、Go ≥ 1.27.1（支持自动工具链下载）和 NSIS 3。运行程序只需要系统 WebView2；Git 操作需要 Git，手动发布需要 GitHub CLI。项目自身的 JavaScript 发布脚本需由开发环境的 Node 执行。

```powershell
npm ci
npm run dev             # 构建并启动 Go 程序
npm run dev:renderer    # 仅浏览器预览，使用 mock 数据
npm run typecheck
npm run smoke           # Go 测试与 vet
npm run build           # 内嵌 React 界面，编译独立 Go EXE
npm run cli-e2e         # 实际 Go EXE，空 PATH 验证独立运行
npm run check:mygo:ui   # 原数据只读副本中的 WebView 检查
npm run dist            # NSIS 安装程序
npm run package-check  # 实际 Go CLI、包哈希和发布 dry-run
npm run installer-check # 隔离沙盒中的安装升级/卸载验证
```

`npm run dist` 使用已编译的 `release/win-unpacked/ReqFlow.exe`，发布前务必先执行 `npm run build`。可通过 `REQFLOW_NSIS` 指定 `makensis.exe`。构建输出保存在 `dist/` 与 `release/`，均不提交到 Git。

## 手动发布到 GitHub Releases

发布版本以 `package.json` 为准，交付时只设定一次；发布和失败重试不会再次升版。目标仓库读取 Git `origin`，发布时会自动提交工作区变更、推送当前分支和同版本标签。

1. 交付时运行 `npm version <版本> --no-git-tag-version`，同步源码及锁文件版本，准备 `docs/release-<版本>.md`。文档一级标题须包含当前版本，并在「## 主要更新」（也支持新增、修复、改进、Changes 等标题）中用列表列出实际交付内容。空白、占位、仅安装说明或版本不符会阻止发布。
2. 登录 GitHub CLI：`gh auth login`。
3. 运行 `node scripts/publish.mjs`，使用该版本构建、打包、检查内部版本并上传；脚本也会修正锁文件根包的版本。构建前先校验发布说明，再查询 GitHub：该版本已发布且附件齐全时立即报错退出，需要替换附件时改用 `npm run release:github -- --version <版本> --clobber`。

已有当前版本安装包时，可预览后直接上传，上传失败也可如此重试：

```powershell
gh auth login
npm run release:github -- --dry-run
npm run release:github
```

上传前自动创建并推送标签；已有标签与当前源码不一致时会停止，不强制覆盖。新建 Release 默认公开发布；需要先检查线上草稿时使用：

```powershell
npm run release:github -- --draft
```

脚本只上传当前版本的 Go Setup 安装包、SHA256 校验文件和 update.json，不再生成或上传 Portable 绿色版。上传前核对 Go 构建标记、主程序/安装包版本、完整打包清单和 SHA256，拒绝旧 Electron 产物。缺少当前版本安装包时会停止。

已有 Release 时上传附件并同步本版本的更新说明，保留发布状态；同名附件默认拒绝覆盖，明确需要替换时使用 `--clobber`。草稿发布状态请在 GitHub 中手动调整。`--notes <文件>` 可指定遵循相同格式的文档，`--dry-run` 会展示完整说明及校验和。

其他用法：

```powershell
npm run release:github -- --version 2.0.0 --dry-run
npm run release:github -- --repo owner/repo --notes docs/my-release.md
npm run release:github -- --help
```

`--version` 必须与当前源码、锁文件及安装包内部版本一致，`--repo` 必须与 `origin` 一致。上传前会检查版本，避免把旧安装包当作当前版本发布。参数依据 [GitHub CLI 发布文档](https://cli.github.com/manual/gh_release_create) 与 [附件上传文档](https://cli.github.com/manual/gh_release_upload)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/mygo/` | Go 桌面宿主、原生系统操作和数据目录识别 |
| `src/mygo/backendgo/` | 完整 Go 领域规则、SQLite/JSON、CLI、AI、Git、备份、归档、发布与更新 |
| `src/mygo/preload/` | 前端直接调用 Go 服务的接口映射 |
| `src/core/` | 前端类型、界面辅助逻辑和 CLI 帮助，旧存储实现仅供迁移比对 |
| `src/main/`、`src/preload/` | 旧 Electron 源码参照，不参与 2.0 编译或发布 |
| `src/renderer/` | React 工作台 |
| `plugins/` | Codex、ZCode、Pi、OpenCode、Claude Code、DeepSeek Harness 接入 |
| `scripts/` | 开发、构建、检查与手动发布脚本 |
| `docs/` | CLI、架构、协议与版本说明 |
| `build/` | 图标及安装器源码，需要入库 |
| `reference/reqflow-local/` | 原始线上源码和文档参考，不参与桌面构建 |

更多设计说明见 [架构文档](docs/architecture.md) 和 [界面规范](docs/ui-guidelines.md)。

## 许可

项目声明采用 MIT；参考源码中的第三方组件许可见 `reference/reqflow-local/vendor/`。
