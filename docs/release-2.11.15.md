# ReqFlow 2.11.15

## 主要更新

- REQ-218：我的项目旁新增同高搜索框，支持项目名称关键字筛选、隐藏空分组、清除按钮与 Esc 清除。
- REQ-219：指派 CLI 终端在待验证阶段继续对话，待验证需求不再被终端会话计入执行中；全部关联需求归档或移除后停止会话并保留输出。跨项目会话也同步检查归档状态。
- REQ-220：批量指派按钮简化为 CLI 名称，保留原有指派行为。
- 指派的 DeepSeek Harness 默认以完全访问运行（`DSH_PERMISSION_MODE=danger-full-access`），与 Codex 指派的 `--sandbox danger-full-access` 一致，不再被工作区沙箱或无人应答的审批阻断；需要收紧时设置 `REQFLOW_DSH_PERMISSION_MODE=workspace-write`。
