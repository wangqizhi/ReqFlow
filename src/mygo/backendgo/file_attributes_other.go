//go:build !windows

package backendgo

import "os"

func desktopFileAttributes(string) string { return "" }

func desktopFileHidden(os.FileInfo) bool { return false }
