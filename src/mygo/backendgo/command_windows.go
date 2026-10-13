package backendgo

import (
	"os/exec"
	"syscall"
)

func desktopHideCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
