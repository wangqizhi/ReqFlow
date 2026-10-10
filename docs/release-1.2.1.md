# ReqFlow 1.2.1

本轮处理 REQ-037 返修与 REQ-038，共 2 条需求，按交付规则增加小版本号。

- 浏览项目默认展开 Git 面板；待 Git 提交需求下方立即显示提交文案框，位于分支与变动列表上方。
- 魔术棒位于输入框内部左侧，点击后通过主进程实际调用所配置的 OpenAI / Anthropic 服务。文案框默认展示多行，生成中禁用重复操作，失败保留原文且在框下持续显示原因。没有待提交需求时禁用魔术棒。
- 待 Git 提交需求区不再提供「填入需求」与「AI 优化」按钮。
- 设置页底部增加「打开配置目录」，所有标签页均可用。资源管理器打开的是本次运行的实际数据目录，包含 workspace.json、ai-settings.json、backup-settings.json；兼容安装版、便携版和自定义数据目录。若目录尚不存在，会先创建目录；打开失败保留设置输入并显示原因。

验证通过：`npm run typecheck`、`npm run build`、`node scripts/ui-check.mjs`、`npm run dist`、`node scripts/package-check.mjs`。UI 验证覆盖默认可见性、魔术棒在输入框内的位置、真实 IPC 到本地 HTTP 模拟服务的两种协议调用、失败保留输入、配置目录路径及错误提示；桌面和较低窗口高度截图位于 `out/review-1.2.1/`。未使用真实服务商密钥进行联网测试。

交付：`release/ReqFlow-Setup-1.2.1.exe`（安装版）、`release/ReqFlow-Portable-1.2.1.exe`（便携版）。安装后确认界面左上角版本为 1.2.1。
