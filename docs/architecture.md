# ReqFlow 桌面版架构说明

本文描述本地 Electron 版的运行结构、与线上版（Cloudflare Workers）的对应关系、数据模型与并发语义。线上版架构见 `reference/reqflow-local/docs/02-architecture.md`。

## 1. 总体结构

```
┌────────────────────────────────────────────────┐
│ Electron 主进程（dist/main/index.js）           │
│  ├─ CLI 模式：--cli <command> → 无窗口 → JSON   │
│  └─ GUI 模式：BrowserWindow + IPC              │
├────────────────────────────────────────────────┤
│ 领域核心 src/core/（GUI 与 CLI 共用）           │
│  domain.ts   状态机/Prompt 生成（移植自线上）   │
│  service.ts  get / mutate / import             │
│  storage.ts  workspace.json 读写 + 版本并发     │
│  cli-help.ts CLI 参考数据源（三处文档同源）     │
├────────────────────────────────────────────────┤
│ 渲染进程（dist/renderer，React + 手写 CSS）     │
│  App.tsx 工作台   help.tsx 帮助/CLI 参考       │
│  经 preload 桥（contextIsolation）调 IPC        │
└────────────────────────────────────────────────┘
```

- 构建零运行时依赖：主/preload 由 esbuild 打包为 CJS，渲染端由 vite 打包；`package.json` 无 `dependencies`，asar 内只有 `dist/`。
- 渲染端在浏览器预览（`npm run dev:renderer`）时自动切换内置 mock（localStorage 持久化、复用同一 `domain.ts`），便于无 Electron 环境调试 UI。

## 2. 与线上版的对应关系

| 线上（Workers） | 桌面版（Electron） |
| --- | --- |
| `app/api/workspace` GET/POST | IPC `workspace:get` / `workspace:apply`；CLI `workspace get` / 各操作命令 |
| Cloudflare D1 `workspaces(id,data,version)` | `%APPDATA%/ReqFlow/workspace.json` `{id,version,data}` |
| Sites 平台身份头 / 回环模拟登录 | 单机单用户 `local_electron`，无认证层 |
| `lib/domain.ts` 领域规则 | `src/core/domain.ts` 原样移植（含 normalizeWorkspace 兼容旧状态） |
| 页面内 modelContext 工具注册 | CLI 命令模式（`--cli`），面向任意 Agent/脚本 |

领域操作（op）集合不变：`project` / `guidance` / `item` / `generate` / `submit` / `cancel` / `complete` / `verify` / `regress` / `archive`（`ready` 保留兼容）。状态流、批次快照、SHA-256、未通过原因带入下一轮 Prompt 等规则与线上完全一致，冒烟测试（`npm run smoke`）覆盖全部迁移路径。

## 3. 并发与数据安全

- 写入采用「临时文件 + rename」原子替换，进程中断不会产生半写文件。
- GUI 每次 `apply` 携带 `expectedVersion`：文件版本不一致即拒绝并提示刷新（对应线上 409）。
- CLI 使用「读最新版本 → 应用 → 条件写入」并在冲突时自动重试（最多 3 次）；因此 CLI 与 GUI 混用时，后写一方在极小概率竞争窗口内会重试而不是覆盖。
- 数据文件只有一个；备份 = 复制该文件；跨机迁移用导出 JSON + `workspace import`。

## 4. CLI 设计

- 入口：`ReqFlow.exe --cli <command> [options]`；主进程检测到 `--cli` 即不创建窗口，执行后 `app.exit(0|1)`。
- 输出契约：stdout 单行 JSON，`ok` 字段标示成败；`--pretty` 供人读，`--out <file>` 落盘，`--data-dir` 隔离数据目录（测试/多实例）。
- stdout 说明：Windows GUI 子系统程序在部分终端直接运行时输出不可见，管道/重定向始终有效 —— Agent 对接请用 `child_process.execFile`（见帮助页与 docs/cli-reference.md 的示例）。
- 命令表、全局选项、注意事项的唯一数据源是 `src/core/cli-help.ts`：`--cli help` 文本、GUI 帮助页、`docs/cli-reference.md`（构建时生成）三处自动一致。

## 5. 构建 / 打包

- `npm run build`：esbuild（main/preload）→ vite（renderer）→ 生成 CLI 文档。
- `npm run dist`：electron-builder → `release/ReqFlow-Setup-<version>.exe`（NSIS 一键安装）+ `ReqFlow-Portable-<version>.exe`（便携单文件）。
- 图标：`scripts/make-icon.mjs` 纯 Node 绘制（无设计文件依赖），产物 `build/icon.ico`（16–256 多尺寸）。
- 测试链：`npm run smoke`（领域核心 12 组断言）→ `npm run cli-e2e`（真实 electron.exe 18 项端到端）→ 浏览器 GUI 走查（dev:renderer + mock）。

## 6. 已知边界

- 单用户单机工作区，不支持多人协作（与线上定位一致）。
- CLI 与 GUI 同时写同一数据文件时靠版本并发保护；极端并发下 CLI 自动重试，GUI 需要手动刷新。
- 便携版 exe 每次启动需自解压到临时目录，启动慢于安装版；Agent 高频调用建议使用安装版路径。
