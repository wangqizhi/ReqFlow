//go:build !windows

package backendgo

func desktopFileAttributes(string) string { return "" }
