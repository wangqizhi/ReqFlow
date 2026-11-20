//go:build windows

package backendgo

import (
	"os"
	"strings"
	"syscall"
)

func desktopFileHidden(info os.FileInfo) bool {
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && data.FileAttributes&syscall.FILE_ATTRIBUTE_HIDDEN != 0
}

// desktopFileAttributes 返回 Windows 文件属性（只读、隐藏、系统、存档）。
func desktopFileAttributes(file string) string {
	name, e := syscall.UTF16PtrFromString(file)
	if e != nil {
		return ""
	}
	value, e := syscall.GetFileAttributes(name)
	if e != nil {
		return ""
	}
	labels := []string{}
	for _, item := range []struct {
		flag  uint32
		label string
	}{
		{syscall.FILE_ATTRIBUTE_READONLY, "只读"}, {syscall.FILE_ATTRIBUTE_HIDDEN, "隐藏"},
		{syscall.FILE_ATTRIBUTE_SYSTEM, "系统"}, {syscall.FILE_ATTRIBUTE_ARCHIVE, "存档"},
	} {
		if value&item.flag != 0 {
			labels = append(labels, item.label)
		}
	}
	return strings.Join(labels, "、")
}
