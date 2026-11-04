# 2026-11-03 Defender 告警复查

- 本机安装版本 2.17.1，发布主程序 SHA256 为 b3ca3b0e5acf5a6b1261a8f4b165ce989c9bc6f398ac8b47de32e907719597e2。
- 08:16 Defender 以 Trojan:Win32/Bearfoos.A!ml 隔离安装主程序。当时病毒库 1.463.80.0。
- 对比 2.17.0 与 2.17.1：Go 编译参数与依赖没有变化；主要变化为编辑器启动及发布输出 UI。没有证据可将检测归因于这些变化。
- 使用病毒库 1.463.97.0、引擎 1.1.26100.4 重扫原始 2.17.1 主程序、2.17.1 安装包及保留的 2.17.0 安装包，均明确 found no threats。未通过反复重编译改变样本，也未修改 Defender 设置。
- 从扫描通过的原始安装包重新安装至原目录，安装退出码 0。安装后主程序哈希仍与发布记录一致，独立扫描通过。
- CLI version 返回 2.17.1，数据仍为 E:\Program Files\reqflow-data\AppData\Roaming\ReqFlow\requirements.sqlite。启动后确认存在响应正常的 ReqFlow · 需求流 窗口，复查没有新的检测记录。
- 补充 scripts/run-go.mjs：本地 GUI 启动前使用当前病毒库扫描；扫描失败即停止。CLI 保持轻量调用。通过 node --check、defender-scan-check 和 git diff --check。

结论：原始字节目前通过新版病毒库扫描，支持启发式误报的可能性，但未经微软确认，不能宣布误报根因已修复。此次没有改动应用业务代码或重新构建发布包。

## 下午再次告警：2.17.2

上文是上午针对 2.17.1 的历史结论，不代表当前 2.17.2 仍通过扫描。

### 本轮确认的证据

- `release/packaging-manifest-2.17.2.json` 记录：主程序发布哈希为 `b8cfb13b2ee47ab062756fa0135b45f3d83c775bffdf50397d3e4d34c516774a`；北京时间 10:35:32 扫描通过，引擎 `1.1.26100.4`、病毒库 `1.463.97.0`。
- 15:33:15 Defender 事件 1116 记录当前安装路径 `C:\Users\wangq\AppData\Local\Programs\ReqFlow\ReqFlow.exe` 命中 `Trojan:Win32/Bearfoos.A!ml`。随后检测资源也包含原桌面进程 PID 28704。下午的引擎、病毒库版本与上午发布扫描记录相同，不能将复发解释为本地病毒库版本升级。
- 执行 `node scripts/defender-scan.mjs release/win-unpacked/ReqFlow.exe`，只扫描现存发布文件、不执行该 EXE，返回 `found 1 threats` 和同一威胁名称。脚本按预期失败并阻止继续发布。后续读取文件哈希和 Authenticode 状态被实时保护拒绝，因此本轮未重新证明被检测文件与清单哈希相同，也未取得签名状态。
- `go mod verify` 返回 `all modules verified`。这验证模块缓存与已记录校验值一致，不等于独立确认所有依赖安全。
- `git diff e571e89 HEAD -- src/mygo/go.mod src/mygo/go.sum scripts/build-mygo.mjs` 无变化。2.17.1 到 2.17.2 未改变 Go 依赖或构建参数。

### 具体代码审查结果

下表是按后续审查优先级列出的候选，不是 Defender 命中特征，也不是因果定位结果。

| 位置 | 实际作用与值得复查的实现 | 证据边界 |
| --- | --- | --- |
| `src/mygo/backendgo/project_terminal_windows.go:94` | 后台 PowerShell 包装器通过 `Start-Process` 打开可见终端，内层使用 `-ExecutionPolicy Bypass -EncodedCommand`；Base64 为 UTF-16 命令文本 | 编码和执行策略参数可以简化为更透明的启动路径，但没有证据证明其触发检测；该模式在 2.17.1 前已存在 |
| `src/mygo/backendgo/agent_terminal_windows.go:92-99` | 为 ConPTY 中的 Agent CLI 构造 Base64 提示数据及编码 PowerShell 命令，同时指定 `ExecutionPolicy Bypass` | 正常功能为传递含引号/换行的任务文件提示；该实现至少在 10 月 27 日已存在，不是 2.17.2 新增 |
| `src/mygo/backendgo/ai_cli.go:66-69` | 用隐藏 PowerShell 调用 npm CLI shim，设置 `ExecutionPolicy Bypass`；参数经 JSON 环境变量传递、提示通过 stdin 输入 | 包装脚本内容固定，没有把提示直接拼成命令；仍值得核查执行策略参数是否必要 |
| `src/mygo/backendgo/editor_windows.go` | 本版新增 `EnumWindows`、查询进程镜像路径、`AttachThreadInput`，用于确认并激活 VS Code 窗口 | 审查到的进程句柄只请求 `PROCESS_QUERY_LIMITED_INFORMATION`，没有远程内存写入或远程线程创建；不能据 API 名称认定为恶意或误报根因 |
| `src/mygo/backendgo/command_windows.go:24-33` | 本版新增对自身进程令牌的 `OpenProcessToken`，通过 `Environ(false)` 获取当前用户环境 | 未见读取其他用户令牌、模拟用户或提权逻辑；不能认定它触发检测 |
| `src/mygo/backendgo/syncserver_windows.go:100-116` | 显式 `server install` 命令注册同步服务，失败时回退登录计划任务 | 属于服务安装功能，不是普通 GUI 启动时无条件创建任务 |

构建脚本使用普通 Go `-trimpath -s -w -H windowsgui`，本轮未见 UPX/garble 或新增加壳步骤。更新器限定项目 GitHub release 下载地址并验证安装包大小和 SHA256；本轮检索应用 Go 源码（排除测试与插件生成文本），未发现 `WriteProcessMemory`、`CreateRemoteThread`、`VirtualAlloc`、`SetWindowsHook`、修改 Defender 设置或下载后 `Invoke-Expression` 的实现。以上是定向审查结果，不是全面安全认证。

### 结论和下一步

1. 本轮可复现文件级检测，不要求在这次扫描中执行 GUI 或点击终端功能；这不排除此前运行行为或云端判定对当前检测的影响。
2. 优先审查终端与 Agent 的“编码 PowerShell + ExecutionPolicy Bypass + 后台包装”组合。不能从本机日志得知具体命中字符串或源代码行，也不能宣布删掉某参数就能解决问题。2.17.1 已出现同类告警，因此仅归因于 2.17.2 新增的 VS Code 激活或用户环境代码没有依据。
3. 微软说明 Defender 同时使用本地、云端及行为模型；相同签名版本不等于所有判定条件相同。云端判定变化是解释之一，但本机证据不足以确认本次原因。
4. 如后续进行代码简化，应以减少不必要的脚本包装和执行策略覆盖为目的，保留 CLI 参数、Unicode、交互终端和退出清理功能验证；扫描通过本身不能证明某段代码就是原始原因。本轮没有修改业务代码、重编译更换样本、运行被报毒样本、恢复隔离文件或更改防护设置。
5. 确认误报及具体命中特征需要微软分析原始样本。本轮未向第三方上传项目或二进制。

参考：[Defender 检测技术](https://learn.microsoft.com/en-us/defender-endpoint/adv-tech-of-mdav)、[微软样本分析入口](https://www.microsoft.com/en-us/wdsi/filesubmission)、[Go 官方杀毒误报说明](https://go.dev/doc/faq#virus)。

## 15:40 更新官方病毒库后恢复启动

- 用户要求恢复应用启动后，运行 `Update-MpSignature`，病毒库由 `1.463.97.0` 更新至 `1.463.102.0`，引擎仍为 `1.1.26100.4`；未更改防护配置或添加排除项。
- 原始 `release/ReqFlow-Setup-2.17.2.exe` 扫描通过，哈希仍为 `dc03501b04dcf3917a0c8b1d89590385cb6c375fef2350ef87b03164c4ca7693`。
- 通过 7-Zip 从该安装包提取主程序到 `tmp/defender-investigation/original-2.17.2`，独立扫描明确通过，哈希为发布记录中的 `b8cfb13b2ee47ab062756fa0135b45f3d83c775bffdf50397d3e4d34c516774a`。未重新编译或更换代码。
- 原来的桌面进程已被 Defender 后续处置结束。重装前备份数据目录标记与当时的 SQLite 主文件至 `tmp/defender-investigation/repair-20261103`；备份不作为完整数据归档使用，原数据目录保持原位。
- 使用扫描通过的原始安装包 `/S` 修复安装，退出码 0。安装器沿用注册表安装目录 `E:\Program Files\reqflow`，并保留 `E:\Program Files\reqflow-data\AppData\Roaming\ReqFlow` 数据配置。
- 安装后的 EXE 独立扫描再次通过，哈希与原始发布一致；CLI version 返回 2.17.2 和上述原 SQLite 路径。
- 15:41 启动 GUI，进程 PID 52088 响应正常；通过窗口截图及可访问性内容确认项目列表、需求卡片与 v2.17.2 正常显示，已将窗口置于前台。启动后的短时观察未发现新的 Defender 1116/1117 事件。

结论：本次已通过更新官方病毒库、校验原始安装包和修复安装恢复启动。没有修改业务代码，所以不能将恢复归因于某段代码修复；原始样本在更新后通过扫描支持误报可能性，但不代表微软已确认误报或未来不会再次检测。
