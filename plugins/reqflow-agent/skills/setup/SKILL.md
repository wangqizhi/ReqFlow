---
name: setup
description: 配置 ReqFlow Agent 插件使用的本机 ReqFlow 可执行文件和数据目录，并检查 CLI 连接；安装后或连接失败时使用。
---

# 配置 ReqFlow Agent

解析插件根目录 scripts/reqflow.mjs 的绝对路径（相对此文件 ../../scripts/reqflow.mjs）。要求 Node >= 22。

先运行 `node "<script>" doctor`。支持 REQFLOW_EXE、REQFLOW_DATA_DIR、REQFLOW_PLUGIN_CONFIG 环境变量；默认配置在用户目录 `.reqflow-codex/config.json`。

未检测到程序时寻找用户已安装的 ReqFlow.exe；可以读本地安装路径，但不要运行安装器。路径无法确定时向用户询问 ReqFlow.exe 路径。安装版可使用 CLI version 返回的数据目录；便携版使用其实际数据目录。不要默认切换到空的 APPDATA 工作区。

运行 `node "<script>" configure --exe "<真实可执行文件>"`；用户指定数据目录时添加 `--data-dir "<目录>"`。开发版 Electron 需要同时给 `--app "<ReqFlow源码根目录>"`，且已有构建。

检查返回的 dataFile 与 ReqFlow 界面“帮助”展示的数据文件一致，然后运行 doctor。不调用 workspace import、generate、submit、complete，不自动执行真实需求。

说明使用方法：在已绑定目录的 Codex 项目聊天中说“执行 ReqFlow 中这个项目已提交的需求”。插件根据目录匹配，不按项目名称；目录未关联时使用 ReqFlow“浏览项目”绑定。
