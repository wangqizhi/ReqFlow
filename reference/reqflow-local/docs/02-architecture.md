# 架构说明

## 1. 当前技术栈

| 层 | 实际实现 |
| --- | --- |
| 界面 | React 19、TypeScript、CSS、Tailwind、现有组件与 Sonner 提示 |
| 框架与打包 | Vinext（Next 风格路由）+ Vite |
| 后端 | TypeScript API，Cloudflare Worker 运行时 |
| 持久化 | Cloudflare D1（SQLite），本地由 Miniflare 模拟 |
| 表结构 | Drizzle schema + SQL migration |
| 线上认证 | Sites 平台身份头，由平台注入 |
| 本机认证 | Vite 开发插件的回环地址模拟登录 |
| 开发工具 | Node.js >=22.13、pnpm |

页面通过同源 `/api/workspace` 读取和更新工作区。后端先取得当前用户，以用户 ID 为数据库主键，执行领域规则，再保存。前端不会直接访问 D1。认证与数据库是平台适配层；项目、需求、Prompt 和状态流转规则主要在 `lib/domain.ts`。

## 2. 数据模型

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL,
  version INTEGER DEFAULT 0 NOT NULL
);
```

每用户一行，data 为完整 Workspace JSON，顶层 projects 数组。Project 保存名称、背景、引导词、默认 AI 验证/交付引导、版本历史、需求、批次与下一个需求编号。

Item 保存 id、REQ 编号、标题、正文、类型、优先级、验收条件、状态、版本、历史、AI 验证开关和交付引导。executionVersion 指向本次实现对应的需求版本，archived 用于归档兼容。

批次保存 id、编号、mode、status、生成时间、提交时间、需求快照、引导版本、模板版本、完整 Prompt 文本与 SHA-256。内部批次 draft 表示“未提交”，与已移除的需求草稿功能不同。

## 3. API 协议与并发

- GET `/api/workspace`：认证；不存在工作区时创建默认项目；返回 `{state, version}`，设置 no-store。
- POST `/api/workspace`：接收 `{op, expectedVersion, ...操作参数}`；认证并检查 Origin；读取数据库；比对 expectedVersion；调用 apply；按旧版本条件 UPDATE；返回新 state/version。
- 401 未认证；403 来源不符；409 版本冲突；GET 503 数据不可用；POST 400 操作或输入错误。

条件 UPDATE `WHERE id=? AND version=?` 配合受影响行数，避免并发写覆盖。版本不符拒绝整次修改。此模型实现简单，但每次更新读写完整 JSON，适合个人小规模工作区，尚不具备细粒度多人协作。

主要 op：project、guidance、item、generate、submit、cancel、complete、verify、regress、archive；ready 是历史接口，现有界面不使用。

## 4. 状态规则

保存需求 → ready（待执行）；提交批次 → in_progress（执行中）；实现完成 → pending_verification（待验证）；人工通过 → archived（归档）；人工未通过 → ready 并记录问题；归档回归 → ready。取消已提交批次将仍执行中的需求退回 ready。

只有待执行需求可编辑；旧草稿会规范化成待执行。旧 verified 状态规范化为归档。编辑增加需求 version，项目引导修改增加 guideVersion。提交时校验需求版本、状态、归档标志和引导版本；旧快照不匹配时必须重新生成。

## 5. Prompt 与验证

buildPrompt 由界面预览和服务端生成共用。每条需求使用自身 AI 验证与交付引导；旧记录无该字段时回退项目默认值。关闭 AI 验证时不生成该需求的 AI 测试段落；默认交付文案同步去除测试说明，用户自定义文本原样保留。

失败原因收集到最近一次验证通过为止，再带到下一轮 Prompt。生成后保存独立快照，后续编辑不会改写历史批次。SHA-256 用于标识文本一致性，不是数字签名。

开关只控制交给外部 AI 的指令；站点没有执行 AI、运行测试、连接 Git、核对 commit 或采集验证环境。人工通过是用户手动确认。

## 6. 认证与迁移边界

线上认证头只有在可信 Sites 入口下注入才可靠。复制到普通服务器时不能直接信任公网客户端提供的同名请求头。应将 `getChatGPTUser` 替换为独立会话认证，并保留按用户隔离。

`lib/store.ts` 直接使用 `cloudflare:workers` 的 DB，因此源码不能直接当作 Express/纯 Node 服务启动。可继续使用现有本地 Worker 模拟；若改成纯 Node 后端，需要替换 storage/API 持久化适配器，用 SQLite 或其他数据库，并实现认证。领域逻辑和多数页面可复用。当前没有 Go 服务。
