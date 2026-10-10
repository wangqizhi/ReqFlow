# 技术与实施方案

## 技术栈

| 层 | MVP 选择 | 原因 |
| --- | --- | --- |
| 语言 | Go，实施时选受支持稳定版本并固定 go.mod | 简单部署、类型安全、适合 HTTP 与 MCP 服务 |
| HTTP | net/http + chi | 标准库基础，轻量路由与中间件 |
| 网页 | html/template + HTMX + 原生 JavaScript | 单体开发，自动保存和局部刷新足够 |
| 样式 | 本地静态 CSS | 不依赖运行时 CDN，可离线部署 |
| 数据库 | SQLite，modernc.org/sqlite | 单文件、无需 CGO，适合个人使用 |
| SQL | database/sql + sqlc + goose | 显式 SQL、生成类型、可追踪迁移 |
| MCP | 官方 Go SDK，实施时核对版本与 Streamable HTTP 支持 | 与 Web 复用 Go 服务 |
| 日志 | log/slog | 结构化日志，默认不记录完整需求或 Prompt |
| 打包 | go:embed + 多阶段 Docker 构建 | 模板、静态资源随二进制发布 |

SQLite 启用外键、WAL、busy_timeout，写事务保持短小并限制写并发。需要多实例或多人高并发时迁移 PostgreSQL；通过单独迁移文件和查询验证实现迁移，不承诺更换驱动即可兼容。

## 目录规划

```text
cmd/reqflow/main.go
internal/config/
internal/domain/
internal/service/
internal/store/sqlite/
internal/transport/http/
internal/transport/mcp/
internal/auth/
internal/prompt/
internal/audit/
web/templates/
web/static/
db/migrations/
db/queries/
docs/
```

依赖方向是 transport → service → domain/repository；domain 不依赖 HTTP、MCP 或数据库包。数据库实现由启动入口注入。

## REST 接口草案

所有接口位于 `/api/v1`，统一 JSON 错误 `code/message/request_id`，校验失败 422、版本冲突 409、未认证 401、无权限 403。

| 方法与路径 | 用途 |
| --- | --- |
| POST /projects | 创建项目 |
| GET /projects | 当前用户项目 |
| GET /projects/{id} | 项目详情 |
| POST /projects/{id}/guidance-versions | 追加引导词版本 |
| GET /projects/{id}/requirements | 按类型、状态、关键字分页查询 |
| POST /projects/{id}/requirements | 创建需求 |
| PATCH /requirements/{id} | 携带 expected_version 编辑 |
| POST /requirements/{id}/transitions | 按状态机转换并记录原因 |
| POST /projects/{id}/prompt-batches | 指定需求和版本生成快照 |
| GET /prompt-batches/{id} | 查看快照 |
| POST /prompt-batches/{id}/submit | 原子确认提交 |
| GET /prompt-batches/{id}/export | 下载 Markdown |
| POST /requirements/{id}/verification-runs | 写验证结果并按规则更新状态 |
| POST /requirements/{id}/archive | 归档 |

创建批次、确认提交及 MCP 写操作支持 Idempotency-Key；键按用户和操作作用域保存，重复请求返回原结果，键相同而 payload 不同返回冲突。列表采用稳定游标分页。限定正文大小和每批需求数量，超限明确报错。

## Prompt 模板示例

```markdown
# 项目上下文
项目：ReqFlow
技术栈：Go + SQLite + HTMX

# 引导词
遵守现有代码结构。先阅读仓库约定，完成后说明改动和验证结果。

# 本轮目标
实现以下已选需求，仅在必要时修改相关模块。

## REQ-001 [新需求] 自动保存
需求：编辑需求时自动保存，并展示保存结果。
验收条件：刷新后内容保留；保存失败可重试；并发编辑提示冲突。

# 交付要求
说明涉及文件、执行的检查、未完成事项和人工验证步骤。
不要在缺乏验证证据时宣称验收通过。
```

模板输出严格按选定顺序，不隐藏用户正文。展示字数与近似 token 范围；估算不是模型精确计费。超过配置预算要求用户拆分或删减，不能悄悄裁切验收条件。

## 安全与部署

本地版默认绑定 `127.0.0.1`，不对公网开放，校验 Origin/Host并为写请求提供 CSRF 保护。远程版启用 HTTPS 和登录；优先复用支持 OIDC 的身份服务，浏览器用 HttpOnly、Secure、SameSite Cookie。REST 与 MCP 均检查项目成员权限。

限流、请求大小限制、数据库参数化查询、Markdown 清理、审计与最少日志字段为基本要求。公网 MCP 不使用浏览器 Cookie替代 OAuth。配置从环境变量或配置文件读取，真实密钥不提交仓库。

部署使用单 Go 进程与持久化数据卷，提供 `/healthz` 和数据库可用性检查 `/readyz`。启动前迁移数据库，失败时拒绝提供写服务。SQLite 使用在线备份 API 或一致的数据库备份命令，不直接拷贝运行中的主文件；升级前备份，并实际演练恢复。备份保留策略由部署配置决定。

## 实施顺序与完成条件

1. 基础：初始化 Go 模块、配置、数据库迁移、项目和引导词。完成条件是启动与重启后数据保留。
2. 工作区：需求分区、类型与状态、编辑和验收条件、自动保存与冲突处理。完成条件是产品文档中的编辑场景通过。
3. Prompt：确定性渲染、不可变批次、复制/导出、确认提交与执行中列表。完成条件是下一轮新增需求不污染已提交快照，并发提交被拦截。
4. 验证闭环：实现关联、逐项验收、失败回流、历史与归档。完成条件是未验证不能自动进入已验证，旧版本验证不能覆盖新版本。
5. ChatGPT：先实现只读 MCP 工具，再引入受权限控制的写操作；公开接入前完成 OAuth 和客户端实测。

## 测试与 CI

领域单元测试覆盖状态转换、Prompt 顺序、快照稳定性和验收规则；数据库集成测试覆盖事务回滚、并发版本冲突和重复提交；HTTP 测试覆盖权限隔离、CSRF 与输入校验。浏览器关键流程测试覆盖自动保存失败、复制降级以及从记录到验证的完整路径。

CI 执行格式检查、`go vet ./...`、`go test -race ./...`、构建与依赖漏洞检查；依赖工具版本固定。MCP 增加协议测试和目标 ChatGPT 客户端实测，不能仅凭工具列表返回成功宣称兼容。
