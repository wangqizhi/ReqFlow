---
name: reqflow-setup
description: 配置 OpenCode 中 ReqFlow 插件使用的本机 ReqFlow 可执行文件和数据目录，并检查 CLI 连接；安装后或连接失败时使用。
metadata:
  opencode/slash: "true"
---

# 配置 ReqFlow Agent（OpenCode 版）

插件的桥接脚本是 `scripts/reqflow.mjs`，与插件同目录。用 shell 工具运行 `node "<插件根>/scripts/reqflow.mjs"`，不要猜测缓存目录。要求 Node >= 22。

## 检查

先运行 `node "<插件根>/scripts/reqflow.mjs" doctor`。

支持环境变量 `REQFLOW_EXE`、`REQFLOW_DATA_DIR`、`REQFLOW_PLUGIN_CONFIG`。默认配置在用户目录 `.reqflow-opencode/config.json`。脚本会自动检查 `%LOCALAPPDATA%/Programs/ReqFlow/ReqFlow.exe`、`%ProgramFiles%/reqflow/ReqFlow.exe`，以及 Windows 卸载注册表中的 `InstallLocation`。

未检测到程序时，向用户询问 `ReqFlow.exe` 的真实路径；不要运行安装器。安装版使用 CLI `version` 返回的数据目录；便携版使用其实际数据目录。不要默认切换到空的 APPDATA 工作区。

## 配置

运行：

```powershell
node "<插件根>/scripts/reqflow.mjs" configure --exe "<真实可执行文件>"
```

用户指定数据目录时追加 `--data-dir "<目录>"`。开发版 Electron 需要同时给 `--app "<ReqFlow 源码根目录>"`，且已有构建。

检查返回的 `dataFile` 与 ReqFlow 界面「帮助」展示的数据文件一致，然后再次运行 `doctor`。配置步骤不调用 workspace import、generate、submit 或 complete。

如果由 execute 流程进入，连接恢复后返回 execute 继续读取并执行需求。用户明确只要求配置时到此结束。

## 使用方式

在已绑定项目目录的 OpenCode 会话中：

- 输入 `/reqflow-execute`：按当前目录匹配项目并领取，随后开始实现。
- 直接说「执行 ReqFlow 需求」：模型调用 `reqflow_read`（`execute=true`）领取。
- 只读查看：模型调用 `reqflow_read`（`execute=false`），不锁定任务。

插件按目录匹配，不按项目名称；目录未关联时使用 ReqFlow「浏览项目」绑定。
