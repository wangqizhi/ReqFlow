# ReqFlow 1.5.0

本轮仅实现已授权的 REQ-047、REQ-051、REQ-052、REQ-053。四条需求按交付规则升中版本：1.4.0 → 1.5.0。保留已有工作树改动，未自动提交代码、安装升级、验收或归档需求。

## 变更

- **REQ-047**：移除主导航独立「批次历史」，改为归档页「归档需求 / 批次历史」次级入口。保留批次快照、Prompt/hash、状态、取消和 CLI 查询。点击批次仍回排期表。确认记录见 `batch-history-analysis.md`。
- **REQ-051**：共享浮层手势记录初始按下位置，阻止浮层内开始、背景结束所产生的误关闭 click。覆盖需求/项目/设置/帮助/MOD/浏览器/嵌套仓库浮层；真正的背景点击、按钮和键盘关闭不变。
- **REQ-052**：记录/编辑需求可选择计划日期，新需求默认本机本地今天，后端校验合法 YYYY-MM-DD；未传日期的部分编辑保留原值。排期表每次从主导航进入默认今天及之前，可选具体日期或所有需求。旧无日期条目在「日期及之前」中保留，指定日期不混入无日期条目。需求池/待验证/归档等状态语义未改变，「所有需求」指排期表内全部未归档待开发需求。顶部复制 Prompt / 提交验证只处理当前日期范围，不包含隐藏的未来条目。CLI item add/edit 新增 `--date`，item 查询返回 scheduledDate。
- **REQ-053**：不拆配置文件；新增项目 revision 和 SHA256 内容令牌，跨项目变化安全重读合并，同项目变化仍提示冲突。跨项目迁移校验双方。文件提交增加短时跨进程互斥、CAS 与唯一临时文件，Windows rename 短时拒绝时有限重试，首次并发初始化不覆盖数据。分析及升级边界见 `project-isolation.md`。

## 已通过的检查

- `npm run typecheck`、`npm run build`、`npm run smoke`（16 组断言）。
- `review-1.5-core.mjs`：跨项目旧全局版本保存、同项目/目标项目/全局操作/导入冲突保护，旧写入方内容令牌，6 路并发初始化，6 个独立进程累计 48 次写入无数据丢失，日期校验/保留/无日期兼容。
- `review-1.5-ui.mjs`：归档次级入口与批次哈希不变，今天及之前/指定日期/所有需求筛选，范围内提交验证，外部 B 项目写入后 A 界面保存成功，浮层内文本/标题拖出后保留，正常背景点击关闭、嵌套浮层不误关闭父层。1440×900 和 1440×650 保存按钮可见。
- `review-1.4-check.mjs`、`project-create-check.mjs`、`git-pull-check.mjs`、`feature-check.mjs`。
- `cli-e2e.mjs` 在开发 Electron 与 `release/win-unpacked/ReqFlow.exe` 上均通过，包括 --date 闰日、默认日期、无效日期不创建及原有完整生命周期。
- `npm run dist`、`package-check.mjs`：Setup/Portable PE、打包 CLI 版本/退出码、ASAR 文件与最终 dist 一致。
- `git diff --check`、发布文件 SHA256。

## 未通过或需人工核对

综合 `scripts/ui-check.mjs` 不是全绿：此前的新需求布局（含 12 张图片）、设置、AI HTTP 等断言已通过，但「复制文件名到系统剪贴板」断言读到空字符串。诊断时复制调用已触发，原因尚未最终确认；没有弱化断言，也没有把该脚本计为通过。安装后请人工回归文件/文件夹名称和路径复制。专项四条需求检查通过不代表这项回归已通过。

项目隔离的原子提交保证要求实际 GUI 与 Agent/CLI 写入方使用 1.5.0 及以上新协议。内容令牌能发现旧写入，旧二进制却不会遵守新文件锁，不保证新旧写入方混跑的原子性。本轮未自动安装，也未改 Agent 可执行文件路径。硬终止遗留锁和大工作区序列化成本见隔离文档。

## 交付

- 安装包：`E:\project\reqFlow\release\ReqFlow-Setup-1.5.0.exe`
- 便携包：`E:\project\reqFlow\release\ReqFlow-Portable-1.5.0.exe`
- 校验：`release/SHA256SUMS-1.5.0.txt`
- 专项截图：`out/review-1.5.0/`

SHA256：

```text
f409b1f9b1dc940fc96467c95bd783de0cf2f63b9f978faa88a2f5aa07f2ee1b  ReqFlow-Setup-1.5.0.exe
9d208014db26c9c211291d5e666f44d6fabcf1fea0d94513ff66d4a73e81a278  ReqFlow-Portable-1.5.0.exe
```
