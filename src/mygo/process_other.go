//go:build !windows

package main

import "os/exec"

func hideChildWindow(cmd *exec.Cmd) {}

func showStartupError(message string)          {}
func registeredDataDir() string                { return "" }
func confirmForceShutdown(message string) bool { return false }

func registerDesktopInstance(dataFile string) (func(), error) { return func() {}, nil }
func otherDesktopInstance(dataFile string) bool               { return false }
