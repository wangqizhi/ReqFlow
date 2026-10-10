# ReqFlow Pi 插件

Node >= 22，兼容支持 version / workspace get / complete 的 ReqFlow 桌面版。

## 安装

将本目录整体复制到 `~/.pi/agent/extensions/reqflow/`，然后重新启动 Pi 或执行 `/reload`。不需要 npm install。

独立配置：`~/.reqflow-pi/config.json`；运行快照：`~/.reqflow-pi/runs/`，可能含私有需求，不要提交或分享。

```powershell
node scripts/reqflow.mjs configure --exe "E:\Program Files\reqflow\ReqFlow.exe"
# 如有必要增加 --data-dir "实际数据目录"
```

也支持 REQFLOW_EXE、REQFLOW_DATA_DIR、REQFLOW_PLUGIN_CONFIG。默认自动发现 LOCALAPPDATA/Programs/ReqFlow/ReqFlow.exe。

## 使用

- `/reqflow-doctor`：检查 CLI 配置。
- `/reqflow`：优先按当前工作目录匹配项目，子目录按最深绑定匹配；未匹配时弹出项目列表供用户选择。读取有效已提交需求并启动实现。
- `/reqflow select`：强制重新选择项目。
- 自然语言“读取/分析/执行 ReqFlow 需求”：模型可调用 `reqflow_read`；只有明确授权执行才可实现和回写。
- 非交互环境：未匹配时返回列表，必须由用户明确选择 projectId。

目标项目必须绑定真实存在的本地目录。选择不会更改 ReqFlow 绑定，不会更改 Pi 会话 cwd。返回 executionCwd，工作流要求使用目标绝对文件路径、bash 显式 cd，并先读取目标项目适用说明。为准确加载项目扩展/配置，最好在目标项目根目录启动 Pi。该规则不是安全沙箱，也不保证系统禁止访问其他目录。

保留 Codex/ZCode 桥接的有效批次过滤、版本/签名核对、部分成功停止及幂等回写。仅实际完成需求转待验证，不执行 verify/archive，不直接修改 workspace.json。旧 CLI 无原子条件写入，避免多个 Agent 同时处理相同需求。

Pi 版本配置独立，不修改 Codex/ZCode 插件。会话重载后需重新领取；不在启动时自动执行需求。
