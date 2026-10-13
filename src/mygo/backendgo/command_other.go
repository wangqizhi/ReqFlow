//go:build !windows

package backendgo

import (
	"os/exec"
)

func desktopHideCommand(cmd *exec.Cmd) {}
