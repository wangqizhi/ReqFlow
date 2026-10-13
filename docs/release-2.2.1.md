# ReqFlow 2.2.1

本轮交付 REQ-121、REQ-126、REQ-127、REQ-128，共 4 条需求，按交付引导递增补丁版本。

- Windows 系统通知显式传入应用图标资源 #1，分别设置托盘图标与提示气泡图标，支持大图标和静音；保留点击返回应用及超时清理。修正 MyGO 0.4.8 未填充 `hBalloonIcon` 的调用路径。Windows Vista 及以后使用该字段显示自定义提示图标，见 [Microsoft NOTIFYICONDATAW 文档](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-notifyicondataw)。
- 左侧入口改名“上下文管理”，放在新建项目下方、协作项目上方，复用侧栏分组文字样式。进入后保留底部操作，隐藏项目切换，并支持返回项目菜单。
- 移除右侧最底部说明，排期表的本轮排期及操作按钮固定在内容区底部，需求列表单独滚动。
- 待验证条目新增开发完成说明，显示在验证提示上方，最多 50 个 Unicode 字符。说明绑定需求版本；返工后的旧说明不会显示为新版本说明，完整开发报告仍保存在历史中。

## CLI

完成时写入简短说明：

```text
ReqFlow.exe --cli complete --project <项目ID> --id <需求ID> --batch <批次ID> --item-version <版本> --summary "已实现功能，CLI检查通过" --note "完整开发和验证报告"
```

补写当前版本待验证条目的说明：

```text
ReqFlow.exe --cli item completion-note --project <项目ID> --id <需求ID> --item-version <版本> --summary "已补齐完成说明，CLI检查通过"
```

显式 summary 为空或超过 50 字会拒绝。旧插件仅传 note 时，自动去除 ReqFlow 运行标记后提取前 50 字。未附报告的旧 CLI 完成操作保持兼容。

## 交付与检查

- 安装包：`release/ReqFlow-Setup-2.2.1.exe`。
- 绿色版：`release/ReqFlow-Portable-2.2.1.exe`。
- 独立程序：`release/win-unpacked/ReqFlow.exe`。
- `npm run typecheck`、`npm run check:mygo`、`npm run cli-e2e`、`npm run check:mygo:ui` 通过。实际 Go 程序的图标资源和 hBalloonIcon 检查通过；隔离数据下 Shell_NotifyIcon 调用及模拟点击回调通过。
- `npm run package-check`、`npm run installer-check` 通过；确认构建产物版本、SHA256、升级保留用户数据和目录配置、运行中阻止静默覆盖、卸载保留数据。
- 界面检查覆盖上下文入口顺序及文字样式、返回项目菜单、说明位置、1440×900 / 1440×720 排期操作栏贴底、长中文与十二张附件的编辑布局。
- 系统通知最终视觉效果仍由用户在安装新版后验收，自动检查不等于人工验证通过。

REQ-126 指定的 `E:\project\ops-yiban\auto-oa\target\release\auto-oa.exe` 属于另一个项目。当前项目构建 ReqFlow Go/MyGO 应用，未生成或覆盖该 auto-oa 程序，本轮实际产物位置如上。
