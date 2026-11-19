# ReqFlow 2.21.0

## 主要更新

- 项目设置的「编辑设置」弹窗在保存成功后自动关闭弹窗并以浮层提示保存结果，保存失败时继续保留输入并在弹窗内显示失败原因。
- 新增 Antigravity 插件 `reqflow-agent-antigravity`，支持按当前工作区目录匹配 ReqFlow 项目，通过内置 stdio MCP 工具（`reqflow_read`、`reqflow_complete`、`reqflow_projects`、`reqflow_doctor`）、路由规则与执行/配置技能领取 AI 排期需求并回写待验证。
- ReqFlow CLI 与桌面界面新增 `antigravity` 执行客户端标识支持，执行中列表与数据看板可识别并显示 Antigravity；插件在旧版 ReqFlow 上自动回退至 `pi` 保持兼容。
