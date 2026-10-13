package backendgo

import (
	"os/exec"
	"syscall"
)

func desktopHideCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
func desktopLaunchZcode(dir string) error {
	cmd := exec.Command("cmd.exe", "/d", "/k", "zcode")
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000010}
	if e := cmd.Start(); e != nil {
		return e
	}
	return cmd.Process.Release()
}
