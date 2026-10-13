//go:build !windows

package backendgo

import (
	"errors"
	"os/exec"
)

func desktopHideCommand(cmd *exec.Cmd)    {}
func desktopLaunchZcode(dir string) error { return errors.New("调起 ZCode 当前仅支持 Windows") }
