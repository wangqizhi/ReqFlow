# ReqFlow 2.0.0

ReqFlow 桌面宿主和后端完整切换到 Go/MyGO，界面保留现有 React 工作台。工作区规则、SQLite/JSON 存储、CLI、AI 请求、系统加密、Git、远程备份、文件浏览、发布日志、归档和在线更新都由 Go 执行，运行包不再携带 Electron、Chromium 或 Node。

- `ReqFlow-Setup-2.0.0.exe`：新版安装升级程序，约 5 MB。沿用原安装位置和数据目录标记，只删除明确的旧运行库文件；保留工作区、数据库、图片、AI 设置、原 `Local State` 和用户文件。运行中的旧版必须先关闭，安装器不会强制结束它。
- `ReqFlow-Portable-2.0.0.exe`：约 15.4 MiB 的单文件绿色版，数据默认放在 EXE 同级 `data/`。可用 `REQFLOW_DATA_DIR` 或 CLI `--data-dir` 指向已有数据。
- `SHA256SUMS-2.0.0.txt`：安装版和绿色版的校验值。

运行需要 Microsoft Edge WebView2 Runtime；无需安装 Node/Electron。新工作区默认 SQLite，原 JSON 和原 SQLite 表结构保持兼容，旧 AI 密钥通过当前 Windows 用户的 DPAPI 直接读取。

发布流程已切换为 Go EXE 和 NSIS 安装器。上传前同时检查 Go 标记、版本和打包哈希，不再使用 Electron ASAR 或旧 Electron 安装包。

验证覆盖：Go 测试与 vet、原规则逐步比对、SQLite 增量写入与并发版本、空 PATH 的实际 CLI、Codex Agent 领取和回写、本地真实 Git 备份与失败重试、实际 WebView 中原数据副本的 6 个项目和 AI 配置，以及隔离沙盒内的安装升级/卸载数据保留和发布 dry-run。
