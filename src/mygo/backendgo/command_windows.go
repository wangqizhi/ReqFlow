package backendgo

import (
	"os/exec"
	"syscall"
)

func desktopHideCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

// desktopGUICommand 用于启动有界面的程序（如 VS Code）：不隐藏窗口，独立进程组，
// 避免继承后台命令的 SW_HIDE / CREATE_NO_WINDOW 导致窗口不显示。
func desktopGUICommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000200 | 0x00000008}
}
