# ReqFlow 2.17.2

## 主要更新

- 修复项目设置中「从编辑器打开」无反应的问题：等待 VS Code 窗口出现后自动还原并切到前台，不再被 ReqFlow 窗口遮挡；超时仍未出现窗口时提示原因。
- 项目目录的「打开终端 CLI」优先使用已安装的最新 PowerShell 7（pwsh），未安装时回退到 Windows PowerShell 5.1。
- 修复从终端启动的 Claude Code 等 CLI 没有颜色的问题：终端与 VS Code 改用当前用户的系统环境启动，不再继承 ReqFlow 启动来源中的 NO_COLOR、TERM=dumb 等变量。
