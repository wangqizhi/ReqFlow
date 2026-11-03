package backendgo

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

func desktopHideCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// desktopGUICommand 用于启动有界面的程序（如 VS Code）：不隐藏窗口，独立进程组，
// 避免继承后台命令的 SW_HIDE / CREATE_NO_WINDOW 导致窗口不显示。
func desktopGUICommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x00000008}
}

// desktopUserEnvironment 返回当前用户的全新登录环境（系统与用户环境变量、最新 PATH），
// 供用户可见的终端与编辑器使用。ReqFlow 可能由 Codex 等 Agent 启动并继承 NO_COLOR、
// TERM=dumb 等变量，直接沿用会让终端里的 CLI 失去颜色。读取失败时退回清理后的当前环境。
func desktopUserEnvironment() []string {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &token); err == nil {
		defer token.Close()
		if env, err := token.Environ(false); err == nil && len(env) > 0 {
			return env
		}
	}
	return cleanLaunchEnvironment(os.Environ())
}
