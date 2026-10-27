# 2026-10-27 Defender 告警排查

## 复现证据

本机 Defender 引擎 1.1.26090.9、病毒库 1.461.216.0，实时保护启用。使用 `MpCmdRun.exe -Scan -ScanType 3 -File <原始 EXE> -DisableRemediation` 检查从保留的 NSIS 安装包提取的主程序，未运行被报毒的 EXE。

| 原始安装包版本 | 主程序扫描结果 |
| --- | --- |
| 2.13.3 | found no threats |
| 2.13.4 | Trojan:Win32/Bearfoos.B!ml |
| 2.13.5 | found no threats |

2.13.4 原始安装包 SHA256 为 `73ce0bd2a4009fbbd304ef11eeb99e9deca5d102e4d9bed3e6e655e86a1091c3`，与 GitHub 附件记录的 digest 一致。构建记录的主程序 SHA256 为 `f7e4f16e12dce1d53d7f8ea1cbf54e8a2778523a726cda46719737c09ea3ae14`。安装目录 `E:\Program Files\reqflow\build-info.json` 与原始 2.13.4 包内记录完全一致，写入时间为 10:35:58；该安装目录没有成功更新到 2.13.5 的证据。被隔离的 EXE 已不存在，无法重新计算其哈希，不能仅凭剩余元数据证明它与包内文件逐字节一致。

原始 2.13.5 主程序 SHA256 为 `2957aa75ae79cd57cb45a8047e751aac0ae0370516845c1d2c156e340cc8f6c6`。11:13 重新构建的同版本主程序哈希为 `5617f2ac1a92b48634ba5a86d31a334e08965489de851a9456d27e21e0d5c1fe`，也通过扫描。两者不能混作同一份样本。

最初检测时间 11:12:44，进程为安装目录内的 ReqFlow.exe；随后 PowerToys 访问同一文件再次触发检测，11:13:25–26 隔离成功。11:18 对原始 2.13.4 的复现也产生了检测记录。

## 原因与边界

可以确认特定 2.13.4 发布二进制会触发本机静态文件检测，无需启动 GUI、连接服务器或执行 AI CLI。2.13.3 到 2.13.4 没有改变 Go 构建参数、依赖或 PowerShell CLI 包装逻辑，新增内容为批量需求操作、模型连接测试和发布说明模板等。前次提及的未签名、PowerShell Bypass 在邻近版本中同样存在，不能据此认定它们是此次新增原因。

这些证据支持“特定构建被启发式/机器学习检测误判”的判断，但不等于微软确认误报；Defender 未提供具体命中特征，无法诚实地归因到某行代码。Go 官方也说明 Windows 杀毒软件可能误判 Go 二进制结构：[Go FAQ](https://go.dev/doc/faq#virus)。最终误报裁定需微软分析原始样本：[微软误报处理说明](https://learn.microsoft.com/en-us/defender-endpoint/defender-endpoint-false-positives-negatives)。

## 修复与后续检查

2.13.6 给 `npm run dist` 增加主程序和安装器的 Defender 检查，上传前重新扫描。只有进程正常返回且明确报告 `found no threats` 才通过；异常、超时、排除或未知输出均拒绝发布。当前检查器对无法识别的本地化输出也会拒绝，需确认实际扫描结论再适配。`npm run security:check` 可重新检查当前产物；也可传入指定文件路径。不修改 Defender 配置、不自动重编译以绕过检测。

扫描记录对应当时的病毒库和文件哈希，不保证未来病毒库或其他产品永远给出相同结论。微软扫描命令说明：[MpCmdRun](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus)。

## 2.13.6 本轮验证

- 主程序 SHA256：`8ec2b7acc9d5926703430577557004ac950eaaddbaeccaea4e4427407ca74807`；安装包 SHA256：`c267aafe607d2a9103f336f55f3f8db1f00fe5f3ca8ef832bc819d0cbafde074`。二者均通过上述引擎与病毒库扫描，详见 `release/packaging-manifest-2.13.6.json`。
- 扫描结果判定测试通过：命中威胁、异常、超时、无明确结论、排除输出均阻止发布。
- `npm run package-check`、`npm run installer-check`、发布说明检查通过，覆盖实际 CLI、SQLite、安装升级/卸载及用户数据保留。
- 全新隔离数据的基本 GUI 启动检查通过，版本、WebView2 页面、工作区与存储接口正常；报告保存在 `tmp/defender-investigation/startup-2.13.6/report.json`。
- 完整交互 UI 冒烟未通过：PowerShell 阶段超时，Windows 通知返回 Unspecified error，后续紧凑布局断言因测试未完成而失败。相关应用代码本轮未修改，不能声称完整 UI 回归通过；原始报告为 `tmp/mygo-ui-report.json`。
- 排查期间 11:19 本机安装被恢复为 2.13.3，已有桌面实例运行。本轮保留该实例，交付新安装包供退出旧版本后升级。
