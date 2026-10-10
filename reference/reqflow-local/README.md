# ReqFlow 本地开发包

个人需求管理与 Prompt 工作台，包含前端、服务端 API、领域逻辑、数据库表结构与迁移、界面组件和开发文档。

基于线上源码提交 `3892f74571164c9136987f6d7dec58784e80703d`，整理日期 2026-10-08。新增的本地辅助脚本和文档只在下载包中，未修改线上站点。

## 快速启动

安装 Node.js 22.13 或以上版本（建议 Node 22 LTS），使用项目声明的 pnpm 11.25.0。Windows、macOS、Linux 均可在终端运行：

```sh
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm local:init
pnpm dev
```

打开终端输出的本机地址（默认 `http://localhost:5173`）。首次访问会跳到模拟登录路由，再回到工作区。也可以直接打开：
`http://localhost:5173/signin-with-chatgpt?return_to=/`

模拟用户 ID 是 `local_seedy`，仅在回环地址的开发服务器生效，不需要线上登录凭据。数据库保存在本项目 `.wrangler/state/`，重启不会丢失。不要删除该目录；备份时先停止服务，再复制该目录。

## 文档

- [开发说明](docs/01-development.md)：环境、命令、修改位置、迁移数据、调试和后续开发建议。
- [架构说明](docs/02-architecture.md)：运行结构、认证、数据库、并发保存、Prompt 快照。
- [功能说明](docs/03-features.md)：当前实际功能和操作流程。
- [交接与验证记录](docs/04-handoff.md)：源码版本、包内改动、验证范围与限制。
- `docs/legacy/`：用户最初提供的 Go 方案文档，仅作历史参考，不能作为当前实现说明。

## 常用命令

```sh
pnpm local:init              # 创建本地数据表，可重复运行
pnpm dev                     # 本地开发，支持模拟登录
pnpm exec tsc --noEmit       # TypeScript 检查
pnpm build                   # 生产 Worker 构建
pnpm local:import ./reqflow-backup.json
```

包中不含线上数据库、node_modules、构建缓存或访问凭据。线上业务数据请先在页面的工作区菜单选择“导出全部数据”，再按开发说明导入。

当前后端是 TypeScript/Cloudflare Worker；Node.js 用于安装依赖和本地开发。它不是 Go 后端，也不是纯 Node/Express 服务。离开 Workers 运行方式时需要替换数据库和认证适配层，详见架构说明。
