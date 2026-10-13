# ReqFlow 2.2.3

- REQ-132：新需求方式菜单支持点击外部、移出键盘焦点与 Esc 关闭，切换项目时关闭菜单。
- REQ-133：移除右侧顶部的项目切换入口，收紧顶栏，项目标题与设置区域上移；侧栏保留项目切换。
- REQ-134：新增 `plugin version` / `plugin bundle` CLI 接口，正式程序内置 Codex 0.3.0、ZCode 0.2.0、Pi 0.2.0 的离线插件包。插件运行前检查版本、校验更新包并通过宿主安装流程更新；失败停止领取和回写，更新后使用最新脚本。ZCode 支持发现安装目录附带的 CLI；非标准目录可配置 `zcodeCli` / `REQFLOW_ZCODE_CLI`。宿主技能和 Pi 注册需重新加载。
- REQ-135：四个阶段统一顶部操作、类型筛选与搜索位置；本轮排期从底部移到同一工具栏，日期范围放在工具栏第二行。排期批量操作只处理当前搜索、类型与日期范围中的需求。

验证：TypeScript 检查、Go 测试与 vet、实际 CLI 需求领取与完成回写测试、更新包校验和宿主失败处理测试、Codex/ZCode/Pi 实际更新，以及隔离数据副本上的 MyGO 界面与低高度布局检查通过。

Windows x64 安装版与便携版：`release/ReqFlow-Setup-2.2.3.exe`、`release/ReqFlow-Portable-2.2.3.exe`。
