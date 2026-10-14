---
name: setup
description: 配置 ReqFlow Agent（Claude Code 版）使用的本机 ReqFlow 可执行文件和数据目录，并检查 CLI 连接；安装后或连接失败时使用。
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/reqflow.mjs *)
---

# 配置 ReqFlow Agent（Claude Code 版）

使用插件内置桥接脚本 `${CLAUDE_PLUGIN_ROOT}/scripts/reqflow.mjs`。要求 Node >= 22。

先运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/reqflow.mjs" doctor`。支持 REQFLOW_EXE、REQFLOW_DATA_DIR、REQFLOW_PLUGIN_CONFIG 环境变量；默认配置在用户目录 `.reqflow-claude-code/config.json`（与其他宿主版本插件互相独立）。

未检测到程序时寻找用户已安装的 ReqFlow.exe；可以读本地安装路径，但不要运行安装器。路径无法确定时向用户询问 ReqFlow.exe 路径。安装版可使用 CLI version 返回的数据目录；便携版使用其实际数据目录。不要默认切换到空的 APPDATA 工作区。

运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/reqflow.mjs" configure --exe "<真实可执行文件>"`；用户指定数据目录时添加 `--data-dir "<目录>"`。开发版 Electron 需要同时给 `--app "<ReqFlow源码根目录>"`，且已有构建。

检查返回的 dataFile 与 ReqFlow 界面「帮助」展示的数据文件一致，然后运行 doctor。配置步骤不调用 workspace import、generate、submit、complete。用户明确只要求配置时到此结束；若由 execute 执行流程进入，连接恢复后返回 execute 继续读取并执行需求。

说明使用方法：在已绑定目录的会话中说「执行 ReqFlow 中这个项目已提交的需求」，或输入 `/reqflow-agent-claude:execute`。插件根据目录匹配，不按项目名称；目录未关联时使用 ReqFlow「浏览项目」绑定。
