# 交接与验证记录

## 来源

- 线上地址：https://reqflow.wqz1987.chatgpt.site
- 源码提交：3892f74571164c9136987f6d7dec58784e80703d
- 打包日期：2026-10-08
- 提交版本包含最新验证开关、顶部成功提示及此前所有流程简化与手机适配。

源码从此提交导出，未携带 .git。包内保留前端、后端、组件、构建插件、运行脚本、依赖锁文件、数据库表结构与 SQL 迁移、公共文件及 vendor 许可。原 Go 方案文档转存 docs/legacy，并明确标记为历史方案。当前实现没有 Go 代码。

本地交接新增：README 与四份当前说明、wrangler.local.jsonc、scripts/local-workspace.mjs，以及 package.json 的 local:init/local:import 命令。没有修改线上应用行为，也没有重新发布线上站点。

## 验证记录

具体本次验证结果记录在根目录 VERIFICATION.txt。依赖验证使用开发环境已安装且与锁文件对应的依赖；不代表重新从公共软件源完成安装。真实 iPhone 操作未实测。

## 数据与凭据

压缩包不包含线上业务数据、访问令牌、用户凭据、node_modules、dist、开发缓存或 .wrangler 数据库。项目的 .openai/hosting.json 只声明非秘密的站点 ID/DB 绑定，用于保留原配置。下载后重新初始化本地数据库；需要旧需求时先线上导出 JSON，再命令行导入。

## 接手后建议

先按 README 本地启动，测试完整需求流程，再决定是否继续 Workers 架构。如果希望改为纯 Node 后端，优先拆分认证和数据适配层，再迁移 API；无需先重写 UI 或需求领域规则。
