//go:build !windows

package main

import (
	"os/exec"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
)

func writeTerminalClipboard(_ *mygo.Window, text string) error {
	return mygo.Clipboard.Write(transfer.TextData(text))
}

func hideChildWindow(cmd *exec.Cmd) {}

func showStartupError(message string) {}
func registeredDataDir() string       { return "" }

func registerDesktopInstance(dataFile string) (func(), error) { return func() {}, nil }
func otherDesktopInstance(dataFile string) bool               { return false }
