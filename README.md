# ReqFlow · 需求流

把想法整理成可执行需求，交给 AI 编码，再把实现结果带回人工验证。

ReqFlow 是面向个人开发者的 Windows 桌面工作台，使用 Electron、React 和 TypeScript。它把多项目需求管理、Prompt 生成、AI 需求讨论、项目文件浏览和 Git 操作放在同一个应用中，也提供 CLI 与 Agent 插件，方便编码助手读取需求和回写实现结果。

核心需求管理在本机运行，无需登录。AI 调用、远程 Git 操作和远程备份需要联网及相应配置。当前源码版本见 [package.json](package.json)。

## 下载与安装

前往 [GitHub Releases](https://github.com/wangqizhi/ReqFlow/releases) 下载已发布的 Windows x64 安装包：

| 文件 | 用途 |
| --- | --- |
| `ReqFlow-Setup-<版本>.exe` | 向导安装，可选择安装位置与数据目录 |
| `ReqFlow-Portable-<版本>.exe` | 免安装，数据保存到程序同级的 `data/` 目录 |
| `SHA256SUMS-<版本>.txt` | 安装包 SHA256 校验值 |

安装版的数据目录由安装向导选择，默认 `%APPDATA%\ReqFlow`。便携版移动时应一起移动 `data/`。升级或迁移前，可在应用中导出完整备份。

## 从记录想法到验证归档

1. **创建项目**：填写项目背景和交付要求，可关联本地目录，也可配置 GitHub/GitLab 仓库并拉取文件。项目可以按文件夹分组。
2. **记录需求**：在需求池填写说明，选择新需求、优化或修复，以及 P0–P2 优先级；可补充验收条件、排期日期、参考图片与交付引导。
3. **安排开发**：选择本轮需求进行排期，生成包含背景、需求、验收要求与交付指引的 Prompt，交给编码助手。Agent/CLI 也可以读取已提交的批次。
4. **提交验证**：实现完成后转入待验证，人工通过后归档；未通过时记录问题并退回，问题会进入后续 Prompt。
5. **继续迭代**：归档需求可以重新打开，历史排期可在归档中的「批次历史」查看。

应用保留需求版本、批次快照和验证记录，便于追踪多轮开发。需求可以迁移到其他项目，排期支持日期筛选。

## 项目工作台

- **AI 需求助手**：根据项目上下文整理想法、讨论建议，确认候选后加入需求池。支持 OpenAI 与 Anthropic API 格式，可配置服务 URL、模型和 API Key。
- **项目文件浏览**：查看 Markdown、图片和文本，编辑文本并使用 `Ctrl+S` 保存；支持语法高亮及文件右键操作。
- **Git 面板**：初始化仓库、查看变动、暂存、提交、管理分支，以及 Pull/Push。AI 可根据实际暂存 diff 生成提交文案。Git 功能需要本机安装 Git。
- **远程仓库与备份**：支持配置仓库地址、分支及 SSH Key 路径，测试连接，以及将工作区数据备份到远程仓库。
- **Agent 对接**：提供 Codex、ZCode 和 Pi 插件，用当前项目目录匹配需求，并将实现结果转入待验证。

侧栏的「协作项目」目前是开发中入口；插件/MOD 页面提供协议说明，尚未实现通用 MOD 加载器。

## 数据与隐私

工作区使用本地 `workspace.json` 保存项目、需求、图片与历史。GUI 与 CLI 共用领域逻辑和数据文件，写入使用版本检查及进程锁，避免并发覆盖。

AI Key 使用 Electron `safeStorage` 加密，单独保存在 `ai-settings.json`，不进入远程工作区备份。AI 请求日志记录时间和请求元数据，不保存 Key、URL、需求正文或响应文案。使用 AI 功能时，相关项目上下文会发送到所配置的服务。

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

可通过 `--data-dir` 或 `REQFLOW_DATA_DIR` 覆盖数据目录。插件运行记录默认位于用户主目录下的 `.reqflow-codex/`、`.reqflow-zcode/` 或 `.reqflow-pi/`，其中包含本地需求快照。

- [完整 CLI 参考](docs/cli-reference.md)
- [Codex 插件接入](docs/reqflow-codex-plugin.md)
- [Codex 插件](plugins/reqflow-agent/README.md) · [ZCode 插件](plugins/reqflow-agent-zcode/README.md) · [Pi 插件](plugins/reqflow-agent-pi/README.md)
- [MOD 协议](docs/mod-protocol.md)

## 本地开发

需要 Node.js ≥ 22.13、npm 和 Windows。Git 操作需要 Git；手动发布需要 GitHub CLI。

```powershell
npm ci
npm run dev             # Vite + Electron 开发窗口
npm run dev:renderer    # 仅浏览器预览，使用 mock 数据
npm run typecheck
npm run smoke
npm run cli-e2e
npm run build           # 构建主进程、preload、界面及 CLI 文档
npm run dist            # 打包 Windows x64 安装版与便携版
```

`npm run dist` 使用已有 `dist/`，发布前务必先执行 `npm run build`。构建输出保存在 `dist/` 与 `release/`，均不提交到 Git。

## 手动发布到 GitHub Releases

发布版本以 `package.json` 为准，交付时只设定一次；发布和失败重试不会再次升版。目标仓库读取 Git `origin`，发布时会自动提交工作区变更、推送当前分支和同版本标签。

1. 交付时运行 `npm version <版本> --no-git-tag-version`，同步源码及锁文件版本，准备 `docs/release-<版本>.md`。
2. 登录 GitHub CLI：`gh auth login`。
3. 运行 `node scripts/publish.mjs`，使用该版本构建、打包、检查内部版本并上传；脚本也会修正锁文件根包的版本。

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

脚本只上传当前版本的 Setup、Portable 和自动生成的 SHA256 校验文件，不上传构建日志、解包目录、用户数据或其他版本的安装包。缺少任一安装包时会停止。

已有 Release 时只上传附件，保留原说明和发布状态；同名附件默认拒绝覆盖，明确需要替换时使用 `--clobber`。草稿发布状态请在 GitHub 中手动调整。

其他用法：

```powershell
npm run release:github -- --version 1.11.1 --dry-run
npm run release:github -- --repo owner/repo --notes docs/my-release.md
npm run release:github -- --help
```

`--version` 必须与当前源码、锁文件及安装包内部版本一致，`--repo` 必须与 `origin` 一致。上传前会检查版本，避免把旧安装包当作当前版本发布。参数依据 [GitHub CLI 发布文档](https://cli.github.com/manual/gh_release_create) 与 [附件上传文档](https://cli.github.com/manual/gh_release_upload)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/core/` | 领域模型、存储、服务、CLI 帮助 |
| `src/main/` | Electron 主进程、IPC、CLI、Git 与本地配置 |
| `src/preload/` | 界面与主进程之间的桥接 |
| `src/renderer/` | React 工作台 |
| `plugins/` | Codex、ZCode、Pi 接入 |
| `scripts/` | 开发、构建、检查与手动发布脚本 |
| `docs/` | CLI、架构、协议与版本说明 |
| `build/` | 图标及安装器源码，需要入库 |
| `reference/reqflow-local/` | 原始线上源码和文档参考，不参与桌面构建 |

更多设计说明见 [架构文档](docs/architecture.md) 和 [界面规范](docs/ui-guidelines.md)。

## 许可

项目声明采用 MIT；参考源码中的第三方组件许可见 `reference/reqflow-local/vendor/`。
