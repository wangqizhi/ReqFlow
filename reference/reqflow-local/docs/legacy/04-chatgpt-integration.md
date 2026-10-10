# ChatGPT 插件兼容方案

## 接入定位

保留用户指定的 Go Web 技术栈，使用独立部署的 Go MCP 服务作为 ChatGPT 应用/插件的数据接口。本次交付是设计文档，不创建或发布插件。

不要以旧式 `ai-plugin.json` 作为主要方案。优先采用 MCP，并按接入时 ChatGPT 当前支持的自定义应用、开发者模式、账号权限和组织策略验证。客户端版本、套餐与工作区能力不同，不能承诺所有 ChatGPT 客户端都可安装。

产品应始终提供网页和 Markdown 复制导出，即使客户端没有 MCP 接入能力仍可使用。普通 Go REST API 不能直接当作 MCP 服务。

## Go MCP 服务

在同一进程中提供 `/mcp` Streamable HTTP 端点。使用官方 Go MCP SDK 处理初始化、协议协商、工具列表、调用和错误；不要手写仅返回 JSON 的仿 MCP 接口。支持的协议版本以选定 SDK 和目标客户端联调结果为准。

| 工具 | 输入概要 | 行为 |
| --- | --- | --- |
| list_projects | cursor、limit | 列出当前身份可访问项目 |
| get_project_context | project_id | 读取当前引导词、项目规范和版本 |
| list_requirements | project_id、type、status、cursor | 查询需求，不默认返回全部历史正文 |
| get_requirement | requirement_id | 读取正文、验收条件与版本 |
| generate_prompt | project_id、requirement_ids、expected_versions、mode | 保存不可变 Prompt 快照，属于写操作 |
| get_prompt_batch | batch_id | 返回已有快照与状态 |
| create_requirement | project_id、title、type、body、criteria | 创建草稿 |
| update_requirement | requirement_id、expected_version、changes | 乐观锁编辑，不隐式提交 |
| submit_prompt_batch | batch_id、expected_versions、idempotency_key | 明确确认提交并转换执行状态 |
| mark_implementation_ready | requirement_id、execution_version、links | 记录实现并进入待验证 |
| record_verification | requirement_id、execution_version、results、evidence | 按验收规则记录结果 |

工具输入 JSON Schema 禁止未知字段，限制长度和枚举；输出包含业务 ID、源版本、当前状态和操作结果。读操作标注只读；generate_prompt 虽名为生成，但保存快照，因此不得标成只读。幂等标记必须符合真实实现。工具注解是客户端提示，服务端仍必须执行权限和状态校验。

首期只开放 list/get；generate 与写操作作为下一阶段。模型认为“代码写好了”只能进入待验证，不等于人工验收通过。验证结果必须关联受测版本、验收项和证据；对外工具可限定只有具备 verifier 权限的用户能提交最终通过结果。

## 身份与网络

本地调试可以使用支持 stdio 的开发工具；ChatGPT 云侧调用远程服务需要可达的 HTTPS 地址，通常不能直接访问用户电脑的 localhost。开发隧道仅用于测试，生产使用稳定域名与证书。

公网接入按当前 MCP 授权规范提供 OAuth、受保护资源元数据和授权服务器发现。优先复用成熟 OAuth/OIDC 提供方，校验访问令牌签名、issuer、audience、有效期和 scopes，并在应用层查询项目权限。实现客户端要求的注册方式、PKCE、回调地址校验和撤销机制；上线前核对规范与实际客户端支持。

建议 scopes 为 `projects:read`、`requirements:read`、`requirements:write`、`prompts:write`、`verification:write`。不要把长期管理员令牌嵌入插件清单或前端，不接受调用参数里伪造的 user_id 作为身份。

## 插件与可选交互界面

如果目标客户端支持创建插件或应用，将现有远程 MCP 地址与授权配置连接到该入口，保留 Go 服务的部署方式。插件说明指导 AI 先读取项目上下文、选择明确需求、生成批次，且未经用户明确提交不能自动调用 submit_prompt_batch。

可选 MCP Apps 界面展示需求选择、Prompt 预览和验证清单。MCP Apps 与宿主扩展的支持取决于客户端；普通网页不能自动嵌入 ChatGPT。界面使用宿主要求的资源、工具输出和 CSP 配置，实施时核对实际 SDK 与规范。导航入口、输入框引用和深链接等扩展在兼容性验证后逐步增加，不作为 MVP 依赖。

项目正文与引导词都是用户数据。工具结果应明确区分数据与操作指令，不能因为需求正文要求“读取其他项目”而绕过权限，也不能把用户正文提升为系统权限。

## 接入验收

1. MCP Inspector 或同类工具完成初始化、tools/list 和受权限限制的调用。
2. 目标 ChatGPT 客户端成功连接 HTTPS MCP 服务并完成登录授权。
3. 用户 A 无法通过工具读取用户 B 项目；撤销授权后调用失败。
4. 获取需求和生成 Prompt 与 Web 返回同一版本内容；生成快照不会自动标记执行中。
5. 重复写调用不会重复创建批次；版本过期返回明确冲突。
6. ChatGPT 能读取本轮需求；等待期间网页新增需求不会改变旧批次。
7. 不支持应用界面或无法连接 MCP 时，用户仍可通过网页复制 Prompt。

## 参考资料

- MCP 规范：https://modelcontextprotocol.io/specification/latest
- 官方 Go SDK：https://github.com/modelcontextprotocol/go-sdk
- MCP Apps：https://github.com/modelcontextprotocol/ext-apps
- OpenAI Apps SDK 文档：https://developers.openai.com/apps-sdk/
- MCP Extensions：https://github.com/openai/mcp-extensions/blob/main/docs/spec.md

这些是实施时需要核对的规范入口；本文未宣称已完成客户端联调或发布。
