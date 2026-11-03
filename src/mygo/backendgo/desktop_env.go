package backendgo

import "strings"

// cleanLaunchEnvironment 去掉由启动 ReqFlow 的宿主（Codex、Claude Code、VS Code 终端等）
// 注入、会改变用户终端或编辑器行为的变量：关闭颜色的 NO_COLOR / TERM=dumb、
// 宿主会话标识 CODEX_* / CLAUDECODE / CLAUDE_CODE_*，以及 Electron/VS Code 运行方式变量。
// 仅在无法读取当前用户全新环境时作为兜底使用。
func cleanLaunchEnvironment(env []string) []string {
	result := make([]string, 0, len(env))
	for _, item := range env {
		pair := strings.SplitN(item, "=", 2)
		name := strings.ToUpper(pair[0])
		value := ""
		if len(pair) > 1 {
			value = pair[1]
		}
		switch {
		case name == "NO_COLOR", name == "CLAUDECODE", name == "ELECTRON_RUN_AS_NODE", name == "ELECTRON_NO_ATTACH_CONSOLE":
			continue
		case name == "TERM" && strings.EqualFold(value, "dumb"), name == "COLORTERM" && value == "":
			continue
		case strings.HasPrefix(name, "CODEX_"), strings.HasPrefix(name, "CLAUDE_CODE_"), strings.HasPrefix(name, "VSCODE_"):
			continue
		}
		result = append(result, item)
	}
	return result
}
