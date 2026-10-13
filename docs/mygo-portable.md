# ReqFlow 2.0 Go/MyGO 安装版与绿色版

2.0 使用完整 Go 后端。Go 宿主直接处理工作区、SQLite/JSON、CLI、AI、Git、备份、文件、发布、归档和更新；React 界面通过 MyGO 调用 Go 方法。产品运行时不启动 Node 或 Electron，也不携带 Chromium。

## 生成和运行

开发构建需要 Windows x64、Node 22.13+、Go 1.27.1+（可自动下载工具链）和 NSIS 3。Node 只用于编译界面及运行构建脚本。

```powershell
npm ci
npm run typecheck
npm run build
npm run smoke
npm run cli-e2e
npm run check:mygo:ui
npm run dist
npm run package-check
npm run installer-check
```

构建得到 `release/win-unpacked/ReqFlow.exe` 和 Go 构建标记；打包得到：

```text
release/
  ReqFlow-Setup-2.0.0.exe
  ReqFlow-Portable-2.0.0.exe
  SHA256SUMS-2.0.0.txt
  packaging-manifest-2.0.0.json
```

安装包约 5 MB，单文件绿色版约 15.4 MiB。运行电脑需要系统 Microsoft Edge WebView2 Runtime；Git 功能需要安装 Git。项目自身的 JavaScript 发布脚本需要开发环境的 Node，ReqFlow 本身不依赖它。

## 原版升级与数据保留

先关闭原 ReqFlow，再运行 Setup。安装器读取原卸载注册表键，沿用旧安装位置；已有 `data-dir.cfg` 优先于注册表 `Software\ReqFlow\DataDir`。默认保持原数据目录，不运行旧卸载程序，也不递归删除安装目录。

仅删除显式名单中的 Electron/Chromium 文件、语言资源和旧 Node 适配组件，删除空目录；数据库、JSON、images、备份、AI 配置、原加密 `Local State`、用户文件与目录链接均保留。若安装目录包含数据，清理过程避开选定数据目录。新版卸载只删除程序本身，继续保留数据及目录标记。

本机原目录为 `E:\Program Files\reqflow`，数据为 `E:\Program Files\reqflow-data\AppData\Roaming\ReqFlow`。本轮只生成安装包，未运行真实升级安装。

## 数据目录与加密

安装版优先级：`REQFLOW_DATA_DIR` > EXE 同级 `data-dir.cfg` > 注册表 DataDir > 本机已有指定安装数据根目录 > `%APPDATA%\ReqFlow`。绿色版文件名 `ReqFlow-Portable-<版本>.exe` 默认使用同级 `data/`，环境变量可覆盖。CLI 的 `--data-dir` 可单独覆盖。

```powershell
$env:REQFLOW_DATA_DIR = 'E:\Program Files\reqflow-data\AppData\Roaming\ReqFlow'
& '.\release\ReqFlow-Portable-2.0.0.exe'
```

显式选择旧目录后，保存会写入已有数据。新工作区默认 SQLite，旧 JSON 可读且可迁移，SQLite 沿用原分表结构和乐观并发/跨进程写锁，稳定数据行不重复更新。

原 AI 密钥兼容 Electron v10/v11，直接调用 Windows DPAPI 解密原 `Local State` 密钥。可用 `REQFLOW_ELECTRON_LOCAL_STATE` 指向其他原用户配置文件。原用户配置从不自动删除；新电脑没有原配置时使用 Go DPAPI 格式保存新密钥，文件不存明文。

## 验证与发布

`npm run smoke` 运行 Go 测试与 vet；`cli-e2e` 用清空 PATH 的真实 EXE 测试完整流程，证明不依赖 Node/Electron。原 CLI/Agent 协议继续支持 `scheduled-ai-complete`。

`check:mygo:ui` 将原 SQLite 以只读连接备份到随机临时目录，再测试真实 WebView 与 Go 桥；报告只记录版本、数量与成功状态，不保存 AI 密钥。测试结束清理副本。`installer-check` 编译真实 NSIS 分支，并在隔离安装沙盒验证旧组件清理、数据保留、junction 避让和运行中进程保护；不触碰真实安装目录或注册表。

`node scripts/publish.mjs` 仍使用当前 package.json 版本，现只构建并上传 Go 安装版、Go 绿色版和 SHA256。版本校验读取 Go 构建标记/打包清单/PE 版本和哈希，拒绝旧 Electron 包。可以先运行 `npm run release:github -- --dry-run`；本轮未执行 Git 提交、推送或 GitHub 上传。

源码：`src/mygo/backendgo/` 为完整 Go 后端，`src/mygo/main.go`/`native.go` 为桌面宿主；`src/renderer/` 保留 React 界面。旧 `src/main/` 仅作迁移参照，不参与新版运行包。
