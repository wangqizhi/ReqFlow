//go:build !windows

package main

import "os/exec"

func hideChildWindow(cmd *exec.Cmd) {}

func showStartupError(message string) {}
func registeredDataDir() string       { return "" }

func registerDesktopInstance(dataFile string) (func(), error) { return func() {}, nil }
func otherDesktopInstance(dataFile string) bool               { return false }
