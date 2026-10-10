# REQ-045：Git Pull 与新项目远程文件拉取

版本：1.3.2。本轮 1 条需求，按小变动提升补丁版本。此需求扩展 1.3.1 的仓库绑定：新项目绑定后不再仅保存配置，也会尝试拉取文件。

## 功能与使用

- 「浏览项目 → Git → 历史 Git Log」增加 Pull 按钮，不要求已有 behind 计数（该计数可能未 fetch）。Pull 成功后刷新 Git 状态及文件树。
- 手动 Pull 遵循当前分支的 upstream，使用 `git pull --ff-only --no-rebase`，不自动生成合并提交、不改写历史、不自动 stash。
- 有未提交、已暂存、未跟踪文件或文件编辑器未保存内容时，不执行 Pull。分支已经分叉时返回 Git 错误，用户自行处理，不做强制 reset。
- 新建项目填写远程仓库后：空目录按所填分支 clone；已有独立 Git 仓库必须干净、origin 地址与配置一致、当前分支一致，才尝试快进拉取。
- 非空普通目录不会被覆盖；所选目录若只是父仓库下的子目录，拒绝操作父仓库。不自动改写已有 origin。
- 使用项目配置中的 SSH Key，或系统 SSH/HTTPS 凭据；无交互提示，失败/超时返回原因。
- 拉取失败、分支不存在或没有选择本地目录时，项目及配置仍保留，主界面显示「项目已保存，但远程文件未拉取」及具体原因；避免因网络失败重新创建重复项目。
- 同一目录同时发起拉取会被拒绝；长时间拉取后返回最新工作区版本及明确创建的项目 ID，避免客户端回退到旧快照。

## 检查

- `npm run typecheck`、`npm run build`：通过。
- `node scripts/git-pull-check.mjs`：真实 Git + Electron IPC/UI 测试通过。使用独立临时 bare 仓库与 URL 映射（不依赖私人网络/凭据）；覆盖新建 clone、已有仓库快进、手动 Pull、追踪/未跟踪改动保留、父仓库/错误 origin 拒绝、并发拒绝、分支分叉不改本地 HEAD、错误地址/分支仍保留项目，以及真实 UI Pull 按钮点击和错误反馈。
- `node scripts/project-create-check.mjs`：上一轮新建项目表单回归通过（远程结果使用受控模拟）。
- `npm run smoke`：16 组断言通过。
- `node scripts/feature-check.mjs`、`npm run cli-e2e`、`node scripts/ui-check.mjs`：通过。
- `npm run dist`：安装包及便携版生成。
- `node scripts/package-check.mjs`：打包 CLI 版本 1.3.2、ASAR 内容与最终构建一致、安装/便携版有效 PE，均通过。
- `git diff --check`：通过。

UI 截图：`out/review-1.3.2/git-pull.png`。

## 交付

- `release/ReqFlow-Setup-1.3.2.exe`
- `release/ReqFlow-Portable-1.3.2.exe`
- `release/SHA256SUMS-1.3.2.txt`

## 限制

- 本轮未发现阻塞需求的问题。实际私有仓库认证仍需用户自己的网络、凭据与权限。
- 目录安全检查与 Git 命令之间不构成操作系统原子事务；请勿同时用其他工具修改目标仓库。
- clone 失败后不做破坏性清理；目录状态交由 Git 自身及用户检查。
- 未替用户安装升级，未执行 ReqFlow 验收/归档，上一轮未提交改动保留。
