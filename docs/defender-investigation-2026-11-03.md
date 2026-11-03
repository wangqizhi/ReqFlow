# 2026-11-03 Defender 告警复查

- 本机安装版本 2.17.1，发布主程序 SHA256 为 b3ca3b0e5acf5a6b1261a8f4b165ce989c9bc6f398ac8b47de32e907719597e2。
- 08:16 Defender 以 Trojan:Win32/Bearfoos.A!ml 隔离安装主程序。当时病毒库 1.463.80.0。
- 对比 2.17.0 与 2.17.1：Go 编译参数与依赖没有变化；主要变化为编辑器启动及发布输出 UI。没有证据可将检测归因于这些变化。
- 使用病毒库 1.463.97.0、引擎 1.1.26100.4 重扫原始 2.17.1 主程序、2.17.1 安装包及保留的 2.17.0 安装包，均明确 found no threats。未通过反复重编译改变样本，也未修改 Defender 设置。
- 从扫描通过的原始安装包重新安装至原目录，安装退出码 0。安装后主程序哈希仍与发布记录一致，独立扫描通过。
- CLI version 返回 2.17.1，数据仍为 E:\Program Files\reqflow-data\AppData\Roaming\ReqFlow\requirements.sqlite。启动后确认存在响应正常的 ReqFlow · 需求流 窗口，复查没有新的检测记录。
- 补充 scripts/run-go.mjs：本地 GUI 启动前使用当前病毒库扫描；扫描失败即停止。CLI 保持轻量调用。通过 node --check、defender-scan-check 和 git diff --check。

结论：原始字节目前通过新版病毒库扫描，支持启发式误报的可能性，但未经微软确认，不能宣布误报根因已修复。此次没有改动应用业务代码或重新构建发布包。
