//go:build !windows

package backendgo

import (
	"os"
	"os/exec"
)

func desktopHideCommand(cmd *exec.Cmd) {}

func desktopGUICommand(cmd *exec.Cmd) {}

func desktopUserEnvironment() []string { return cleanLaunchEnvironment(os.Environ()) }
