package main

import (
	"os/exec"
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
