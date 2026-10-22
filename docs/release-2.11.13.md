# ReqFlow 2.11.13

## 主要更新

- 「提交验证」指派 DeepSeek Harness 时改用交互终端：先执行本轮指派任务，结束后可在同一终端继续输入，与 Codex / Claude Code 的交互方式一致。
- 终端按步骤显示 DSH 的思考摘要、工具调用与工具结果；`Ctrl+C` 中止当前一轮并保留会话，`/new` 开新会话，`/exit` 退出。
- 每轮通过 `--session-id` 沿用同一个 DSH 会话，上下文连续；只读任务日志仅保留给 ZCode。
- 交互终端客户端随程序内嵌，启动时释放到临时目录，不新增安装步骤；任务正文通过临时文件传入，不受 Windows 命令行长度限制。

## 说明

- DeepSeek Harness 仍由 `dsh --profile headless` 执行，只是改为按轮次读取 `--json` 事件并渲染。需要本机 Node.js 22+、可用的 `dsh` 命令，并在 headless profile 安装 `reqflow-agent-dsh` 插件、配置模型。
- 交互终端以项目目录作为工作目录；模型、网络、工具权限与沙箱策略沿用 DSH 自身设置，ReqFlow 不额外提权。
- 若终端提示找不到 DeepSeek Harness 或模型不可用，先在该 profile 运行 `dsh --profile headless "你好"` 验证，再回到 ReqFlow 指派。
