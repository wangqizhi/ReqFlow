# REQ-044：新建项目目录、分组与仓库绑定

版本：1.3.1（本轮 1 条需求，按小变动提升补丁版本）。

## 功能

新建项目表单支持：

1. 选择已有 ReqFlow 分组文件夹，或填写新分组名称，随项目一次保存。
2. 通过系统目录对话框选择现有文件夹；或直接输入完整绝对路径。
3. 点击「创建此目录」立即准备目录；也可开启「目录不存在时创建」，保存项目时自动创建缺失目录及父目录。
4. 不填系统目录也可先建立项目。已有目录不清空，不覆盖现有文件；拒绝文件路径、相对路径以及权限失败。
5. 可选 GitHub/GitLab 仓库绑定，填写 HTTPS/SSH 地址、分支与 SSH 私钥位置；支持 GitLab 自建站。
6. 「测试连接」复用只读 `git ls-remote`，展示成功/失败反馈；异步操作防重复提交，失败保留表单。

分组、目录、仓库配置在一次工作区事务中保存。已知无效项目/仓库/分组和过期表单在目录创建前拒绝；IO 后工作区仍再次检查版本。手动创建或保存并发失败时已创建的目录不自动删除，避免删除用户文件。

仓库绑定指保存 ReqFlow 项目仓库设置，不自动克隆、初始化、推送或更改 origin。需要更改本地 origin 时，沿用「设置 → 项目仓库 → 保存并应用到本地 Git」。连接测试需要本机 Git 与相应网络/凭据权限；不把密码或 Token 写入仓库 URL。

## 实现文件

- `src/renderer/project-create.tsx`：新建表单、分组选择、目录动作、仓库测试。
- `src/renderer/settings.tsx`：导出并复用 RemoteFields。
- `src/main/project-directory.ts`：系统目录验证与无覆盖创建。
- `src/main/ipc.ts`、`src/preload/index.ts`、`src/renderer/api.ts`：目录准备接口与创建时验证。
- `src/core/domain.ts`：原子保存分组、目录和仓库配置。
- `src/renderer/styles.css`：统一字段/按钮/开关与低窗口高度下可访问的保存区。

## 检查

- `npm run typecheck`、`npm run build`：通过。
- `node scripts/project-create-check.mjs`：真实 Electron UI/IPC 检查通过；使用独立临时目录，测试分组创建与选择、目录选择与自动创建、现有文件保护、加载禁用/成功/失败、低窗口高度保存、无效目录/远程/分组拒绝与过期表单拒绝。UI 的远程成功/认证失败使用受控模拟，不依赖私人仓库。
- 另外使用生产 `runRemoteGit` 对 GitHub `github/gitignore` 与 GitLab `gitlab-org/gitlab-test` 两个公共仓库进行真实 `ls-remote`，均成功。
- `npm run smoke`：16 组断言通过。
- `node scripts/feature-check.mjs`：通过。
- `npm run cli-e2e`：通过。
- `node scripts/ui-check.mjs`：现有综合 UI 回归通过。
- `npm run dist`：NSIS 安装包、便携版均生成。
- `node scripts/package-check.mjs`：安装/便携文件为 PE，可执行版本 1.3.1，ASAR 全部代码与最终构建一致。
- `git diff --check`：通过（仅已有换行符提示）。

UI 截图：`out/review-1.3.1/project-create-900.png`、`project-create-650.png`。

## 交付

- 安装包：`release/ReqFlow-Setup-1.3.1.exe`
- 便携版：`release/ReqFlow-Portable-1.3.1.exe`
- SHA256：`release/SHA256SUMS-1.3.1.txt`

本轮未发现阻塞需求的问题。私有仓库/自建实例连接仍需用户用自己的凭据验收。没有替用户安装升级，没有执行 ReqFlow verify/archive。
