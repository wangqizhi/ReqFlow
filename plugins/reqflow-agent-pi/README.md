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

## 启动前版本协商（ReqFlow 2.2.3+）

read、doctor、projects（Pi）与 complete 在执行前使用 ReqFlow 内置的插件版本查询接口。仅在内置版本更新时下载离线更新包，校验 SHA256 与清单；失败时停止，不领取或回写需求。版本来自当前安装的 ReqFlow，升级 ReqFlow 即更新插件发布目录；不访问第三方下载地址、不降级插件。

Codex 使用 plugin marketplace / plugin add；ZCode 使用安装目录附带的 resources/glm/zcode.cjs 的 plugins 命令（非标准安装路径可配置 zcodeCli 或 REQFLOW_ZCODE_CLI）；保留插件和市场名称，仅独立本地市场可自动切换到已校验更新包，失败恢复原来源。Pi 更新本地 extensions/reqflow 源目录；包安装使用稳定的 ~/.reqflow-pi/plugin 路径以避免重复注册。更新后需重新加载宿主技能或 Pi 扩展注册；当前命令自动使用最新桥接脚本。保留用户独立配置与领取快照。

## 独占执行（ReqFlow 2.2.4+）

执行使用 read 原子领取；只读使用 inspect，返回 runFile=null，不锁定任务。用户限定范围时使用 --ids <id1,id2>。领取记录包含 runId、client、startedAt；完成保留 endedAt 和 durationMs。其他客户端不能领取或完成，GUI 执行中页展示当前任务与实时用时。中断任务由用户确认释放，释放后旧凭据失效，不自动超时抢占。Pi 的 reqflow_read 默认只读，只有用户授权执行时 execute=true；/reqflow 为执行入口。
