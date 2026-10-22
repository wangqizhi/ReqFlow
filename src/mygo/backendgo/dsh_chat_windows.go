//go:build windows

package backendgo

import (
	"bytes"
	_ "embed"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/UserExistsError/conpty"
)

// dshChatScript 是随程序嵌入的交互终端客户端；构建时自动打包，运行时释放到临时目录。
//
//go:embed dsh_chat.mjs
var dshChatScript []byte

//go:embed dsh_runtime.mjs
var dshRuntimeScript []byte

// dshChatScriptPath 返回本次运行使用的客户端脚本路径，内容变化时覆盖写入，
// 避免升级后残留旧脚本。
func dshChatScriptPath() (string, error) {
	dir := filepath.Join(os.TempDir(), "reqflow-dsh")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "dsh-chat.mjs")
	if err := os.WriteFile(filepath.Join(dir, "dsh_runtime.mjs"), dshRuntimeScript, 0o600); err != nil {
		return "", err
	}
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, dshChatScript) {
		return path, nil
	}
	if err := os.WriteFile(path, dshChatScript, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// dshNodePath 解析运行客户端所需的 Node.js：DeepSeek Harness 本身依赖 Node，
// 因此优先使用 PATH 中的 node，其次检查常见安装位置。
func dshNodePath() (string, error) {
	candidates := []string{}
	if path, err := exec.LookPath("node"); err == nil {
		candidates = append(candidates, path)
	}
	if programFiles := os.Getenv("ProgramFiles"); programFiles != "" {
		candidates = append(candidates, filepath.Join(programFiles, "nodejs", "node.exe"))
	}
	if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
		candidates = append(candidates, filepath.Join(localAppData, "Programs", "nodejs", "node.exe"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", errors.New("未找到 Node.js；DeepSeek Harness 交互终端需要先安装 Node.js 22 或更高版本")
}

// dshChatPermissionDefault 与 Codex 指派的 --sandbox danger-full-access 对齐：
// 由 ReqFlow 启动的 DSH 默认完全访问，避免实现需求时被沙箱或无人应答的审批拦住。
// base 组合用 DSH_PERMISSION_MODE 同时决定沙箱模式与审批策略。
const dshChatPermissionDefault = "danger-full-access"

// dshPermissionMode 返回本次运行使用的权限模式；REQFLOW_DSH_PERMISSION_MODE
// 可以显式改回 workspace-write 或 read-only。
func dshPermissionMode() string {
	if value := strings.TrimSpace(os.Getenv("REQFLOW_DSH_PERMISSION_MODE")); value != "" {
		return value
	}
	return dshChatPermissionDefault
}

// dshChatInvocation 组合交互终端客户端的命令行；任务正文通过临时文件传递，
// 不进入命令行，避免超出 Windows 命令行长度上限。
func dshChatInvocation(node, script, taskFile, root, label, permission string) string {
	return syscall.EscapeArg(node) +
		" " + syscall.EscapeArg(script) +
		" --task-file " + syscall.EscapeArg(taskFile) +
		" --cwd " + syscall.EscapeArg(root) +
		" --profile headless" +
		" --permission " + syscall.EscapeArg(permission) +
		" --label " + syscall.EscapeArg(label)
}

// startDshChatPTY 在项目目录启动 DeepSeek Harness 交互终端：先执行指派任务，
// 随后在同一个终端里继续对话。
func startDshChatPTY(root, prompt, label string) (agentPTY, error) {
	node, err := dshNodePath()
	if err != nil {
		return nil, err
	}
	script, err := dshChatScriptPath()
	if err != nil {
		return nil, errors.New("无法释放 DeepSeek Harness 交互终端客户端：" + err.Error())
	}
	file, err := os.CreateTemp("", "reqflow-dsh-task-*.txt")
	if err != nil {
		return nil, err
	}
	name := file.Name()
	if _, err = file.WriteString(prompt); err != nil {
		file.Close()
		os.Remove(name)
		return nil, err
	}
	file.Close()
	pty, err := conpty.Start(dshChatInvocation(node, script, name, root, label, dshPermissionMode()), conpty.ConPtyWorkDir(root), conpty.ConPtyDimensions(100, 24))
	if err != nil {
		os.Remove(name)
		return nil, err
	}
	return &agentPromptPTY{agentPTY: pty, file: name}, nil
}
