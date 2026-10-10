# 开发说明

## 1. 环境与安装

使用 Node.js >=22.13.0、pnpm 11.25.0，网络需要能够访问 npm 软件源。无需 Go、Cloudflare 账号或远程数据库即可本地开发。

```sh
npm install -g pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm local:init
pnpm dev
```

不要直接运行 `next dev`；项目通过 Vinext/Vite 在本机模拟 Workers 与 D1。下载包没有 `.sites-runtime/execution-profile.json`，因此默认使用 portable 模式。不要从原开发环境拷贝 managed-linux 的状态目录。

依赖版本由 `pnpm-lock.yaml` 锁定。`pnpm-workspace.yaml` 保留依赖发布时长及构建脚本策略。优先排查网络、Node/pnpm 版本与安装错误，不要先删除锁文件。项目中的原 `install:ci` 是托管环境 Bash 辅助入口，本地跨平台使用上述 pnpm 命令。

## 2. 开发入口

| 修改目标 | 文件 |
| --- | --- |
| 页面、需求编辑、项目切换、提示、手机交互 | `app/page.tsx` |
| 响应式布局、颜色、手机弹窗、开关 | `app/globals.css` |
| Prompt、状态流转、校验、旧数据规范化 | `lib/domain.ts` |
| GET/POST、认证、并发保存 | `app/api/workspace/route.ts` |
| 数据库绑定 | `lib/store.ts` |
| 登录用户读取 | `app/chatgpt-auth.ts` |
| 表结构与迁移 | `db/schema.ts`、`drizzle/` |
| 本机模拟 Workers/D1/登录 | `vite.config.ts`、`build/sites-vite-plugin.ts` |
| 本地初始化和备份导入 | `scripts/local-workspace.mjs` |

默认数据库配置在 `wrangler.local.jsonc`，与 Vite 的本地 DB 绑定和持久化目录一致。`local:init` 使用 CREATE TABLE IF NOT EXISTS，不会清空已有数据。以后修改表结构应生成、审查并应用增量迁移，初始化脚本不会自动升级已有表。

## 3. 从线上迁移业务数据

1. 打开线上 ReqFlow，展开工作区菜单，点击“导出全部数据”，得到 `reqflow-backup.json`。
2. 将文件复制到本地项目目录。停止本地开发服务器，运行：

```sh
pnpm local:import ./reqflow-backup.json
```

如果本机已经登录过，GET 接口会创建空工作区；默认导入会拒绝覆盖。确认要以备份替换本地工作区时运行：

```sh
pnpm local:import ./reqflow-backup.json --replace
```

导入目标固定为模拟用户 `local_seedy`。默认只新增；`--replace` 替换该用户整份工作区并增加版本号，不合并项目。先从本地界面导出当前数据或备份 `.wrangler/state/`。导入完成后启动 `pnpm dev` 并刷新页面。脚本不会访问或修改线上数据。

当前页面只有 JSON 导出，没有图形化导入；下载包提供了命令行导入。原备份中项目和需求 ID、批次和历史保留，服务端读取时兼容旧状态。包本身不携带线上业务数据。

## 4. 验证与构建

```sh
pnpm exec tsc --noEmit
pnpm build
```

建议手动验证：新建/编辑需求 → 关闭 AI 测试验证 → 生成 Prompt → 确认提交 → 实现完成 → 未通过并填写原因 → 再生成 Prompt → 再执行 → 通过并归档。确认失败原因被带入、关闭后无系统自动插入的测试说明、通过后归档。

浏览器开发者工具使用 390 × 844 的 CSS 视口检查 iPhone 14 尺寸，另测键盘打开、滚动、安全区、横屏和项目菜单。真实 iOS 键盘与剪贴板行为仍需要真机验证。

`pnpm start` 预览已构建 Worker；与 `pnpm dev` 不同，它不模拟登录，普通本机访问 API 会被拒绝。个人本地继续开发请使用 `pnpm dev`。构建可用于后续 Workers 部署；独立服务器部署需要替换认证和存储层。

## 5. 常见问题

- API 返回 503：确认已安装依赖并执行 `pnpm local:init`；查看终端是否存在 DB 绑定或表缺失错误。
- 401 或登录循环：用 `localhost` / `127.0.0.1`，不要用局域网 IP；确保使用 dev 模式，没有 managed-linux 配置。
- 409：其他页面或导入修改了版本。保留正在编辑的文本，刷新后再操作。
- 手机在同一 Wi-Fi 无法登录：现有模拟登录仅支持回环地址，手机远程访问不适用。可先用桌面浏览器设备模拟；若要真机本地联调，需设计独立开发认证，不能直接把信任用户请求头的方式暴露到公网。
- 重启后数据为空：确认启动目录和 `.wrangler/state` 没变，模拟用户相同；线上和本地数据库相互独立。

## 6. 后续开发建议

领域规则集中放在 `lib/domain.ts`，不要仅在界面约束状态。改 Prompt 模板时维护模板版本，旧批次应保留原始快照。多人协作和大量数据时可将 JSON 工作区拆成项目/需求/批次表。若新增 AI 自动执行，需要独立任务队列、结果保存和人工确认流程；当前应用只生成 Prompt。
