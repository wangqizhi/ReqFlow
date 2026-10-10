# ReqFlow 1.2.4

- 外部 Git 提交输入框恢复为一行、30px 高度，保留框内魔术棒；完整多行文案在展开窗口查看和编辑。默认仍为空。
- OpenAI 格式的 DeepSeek 模型请求增加 `reasoning_effort: "none"`，关闭思考模式以优先减少生成延迟。其他模型与 Anthropic 格式不追加此参数。避免同时传入相互冲突的 thinking 参数。
- 请求日志增加 `reasoning=none` 标识，可直接确认请求使用的推理配置。

依据 [DeepSeek 官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)，reasoning_effort 的 none 关闭思考模式，low 则启用低强度思考。本次选择关闭。

验证：TypeScript、构建、Electron UI 检查（一行 rows、30px 高度、魔术棒在框内、展开操作）、本地 HTTP 请求检查（DeepSeek 参数为 none、其他模型不添加参数）、实际服务调用、安装包构建与包内文件一致性。实际 deepseek-flash 单次测试：225ms 收到响应头，760ms 完成正文与文案处理；此耗时仅代表本次短文案调用。

安装包：`release/ReqFlow-Setup-1.2.4.exe`、`release/ReqFlow-Portable-1.2.4.exe`。
