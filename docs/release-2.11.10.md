# ReqFlow 2.11.10

## 主要更新

- Local Agent 实验室主动检测：打开面板即在后台探测 Codex、Pi、OpenCode、ZCode 是否已安装、版本是否需要更新，不再需要先点一次检测按钮。
- 进入「Local Agent」页签或窗口重新获得焦点时自动刷新；5 分钟内复用上一次结果，并复用进行中的检测请求，避免重复探测。
- 页签用橙色数字提示有可用更新的 Agent 数量；状态行显示检测时间、已安装数量、可更新数量与无法比较版本的数量。
- 单个 Agent 卡片显示已安装版本、最新版本与是否需要更新；命令缺失、版本无法识别、npm registry 请求失败时分别说明原因。
- 实验室页签同步显示 Agent 安装与更新摘要，并保留手动「检测安装 / 检查更新」入口；安装或更新完成后立即重新检测。
- UI 冒烟检查新增「打开面板即触发 agents:detect」回归检查。

## 验证

- `npm run check:mygo`（`go test ./...` 与 `go vet`）通过。
- `npx tsc --noEmit` 通过；`npm run check:mygo:ui` 界面检查全部通过，新增的 `localAgentAutoDetect` 确认打开面板即调用 `agents:detect`，无需点击按钮。
- `npm run package-check` 与 `npm run installer-check` 通过，安装、升级保留数据与旧组件清理均符合预期。
- 安装包 `release/ReqFlow-Setup-2.11.10.exe` 已生成，未自行安装。
- 真实安装 / 更新需要机器已装 Node.js 与 npm，并在有网络的环境人工点击验收。
