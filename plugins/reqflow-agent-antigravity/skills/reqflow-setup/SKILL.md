---
name: reqflow-setup
description: >-
  配置 Antigravity 中 ReqFlow 插件使用的本机 ReqFlow 可执行文件和数据目录，并检查 CLI 连接；
  安装后、路径变化或连接失败时使用。
---

# 配置 ReqFlow Agent（Antigravity 版）

本插件的桥接脚本位于插件根目录的 `scripts/reqflow.mjs`，同时通过内置 MCP 提供 `reqflow_doctor` 工具。要求 Node >= 22，无 npm 依赖。

## 检查

优先调用 `reqflow_doctor` 工具，或运行：

```powershell
node "<插件根>/scripts/reqflow.mjs" doctor
```

支持环境变量 `REQFLOW_EXE`、`REQFLOW_DATA_DIR`、`REQFLOW_PLUGIN_CONFIG`。默认配置在用户目录 `~/.reqflow-antigravity/config.json`。脚本会自动检查 `%LOCALAPPDATA%/Programs/ReqFlow/ReqFlow.exe`、`%ProgramFiles%/reqflow/ReqFlow.exe`、`%ProgramFiles%/ReqFlow/ReqFlow.exe`，以及 Windows 卸载注册表中的 `InstallLocation`。

未检测到程序时，向用户询问 `ReqFlow.exe` 的真实路径；不要运行安装器。安装版使用 CLI `version` 返回的数据目录；便携版使用其实际数据目录。不要默认切换到空的 APPDATA 工作区。

## 配置

调用 `reqflow_doctor` 并传入 `exe`（必要时附 `dataDir`），或运行：

```powershell
node "<插件根>/scripts/reqflow.mjs" configure --exe "<真实可执行文件>"
```

用户指定数据目录时追加 `--data-dir "<目录>"`。

检查返回的 `dataFile` 与 ReqFlow 界面「帮助」展示的数据文件一致，然后再次运行 `doctor`。配置步骤不调用 `workspace import`、`generate`、`submit` 或 `complete`。

如果由 `reqflow-execute` 流程进入，连接恢复后返回执行流程继续读取并实现需求。用户明确只要求配置时到此结束。

## 使用方式

在已绑定项目目录的 Antigravity 会话中：

- 直接说「执行 ReqFlow 需求」：模型调用 `reqflow_read`（`execute=true`）领取并开始实现。
- 直接说「查看 ReqFlow 需求」：模型调用 `reqflow_read`（`execute=false`）只读查看，不锁定任务。
- 直接说「检查 ReqFlow 配置」：模型调用 `reqflow_doctor` 检查连接。

插件按目录匹配，不按项目名称；目录未关联时使用 ReqFlow「浏览项目」绑定。
