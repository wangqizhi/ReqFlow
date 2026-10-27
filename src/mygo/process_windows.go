package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

func hideChildWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func registeredDataDir() string {
	var key syscall.Handle
	if e := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, syscall.StringToUTF16Ptr(`Software\ReqFlow`), 0, syscall.KEY_READ, &key); e != nil {
		return ""
	}
	defer syscall.RegCloseKey(key)
	proc := syscall.NewLazyDLL("advapi32.dll").NewProc("RegQueryValueExW")
	var kind, size uint32
	r, _, _ := proc.Call(uintptr(key), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("DataDir"))), 0, uintptr(unsafe.Pointer(&kind)), 0, uintptr(unsafe.Pointer(&size)))
	if r != 0 || size == 0 || kind != syscall.REG_SZ {
		return ""
	}
	units := make([]uint16, size/2+1)
	r, _, _ = proc.Call(uintptr(key), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("DataDir"))), 0, uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(&units[0])), uintptr(unsafe.Pointer(&size)))
	if r != 0 {
		return ""
	}
	return syscall.UTF16ToString(units)
}

func showStartupError(message string) {
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("ReqFlow MyGO 启动失败")
	_, _, _ = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}

func confirmForceShutdown(message string) bool {
	text := syscall.StringToUTF16Ptr(message)
	title := syscall.StringToUTF16Ptr("ReqFlow · 确认强制关闭")
	r, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x134)
	return r == 6
}

// An exclusive handle is the liveness signal, released by Windows even on crash.
func registerDesktopInstance(dataFile string) (func(), error) {
	dir := filepath.Join(filepath.Dir(dataFile), "desktop-instances")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	file := filepath.Join(dir, fmt.Sprintf("%d.lock", os.Getpid()))
	handle, err := syscall.CreateFile(syscall.StringToUTF16Ptr(file), syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, err
	}
	return func() { syscall.CloseHandle(handle); os.Remove(file) }, nil
}
func otherDesktopInstance(dataFile string) bool {
	dir := filepath.Join(filepath.Dir(dataFile), "desktop-instances")
	// CLI and installer helper processes are not desktop instances. They must
	// retain their existing final-shutdown checks rather than bypassing them.
	if _, err := os.Stat(filepath.Join(dir, fmt.Sprintf("%d.lock", os.Getpid()))); err != nil {
		return false
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if entry.Name() == fmt.Sprintf("%d.lock", os.Getpid()) || filepath.Ext(entry.Name()) != ".lock" {
			continue
		}
		file := filepath.Join(dir, entry.Name())
		h, err := syscall.CreateFile(syscall.StringToUTF16Ptr(file), syscall.GENERIC_READ, 0, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
		if err == syscall.Errno(32) {
			return true
		}
		if err == nil {
			syscall.CloseHandle(h)
			os.Remove(file)
		}
	}
	return false
}
