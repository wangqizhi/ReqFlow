package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
)

var (
	clipboardUser32     = syscall.NewLazyDLL("user32.dll")
	clipboardKernel32   = syscall.NewLazyDLL("kernel32.dll")
	openClipboard       = clipboardUser32.NewProc("OpenClipboard")
	closeClipboard      = clipboardUser32.NewProc("CloseClipboard")
	emptyClipboard      = clipboardUser32.NewProc("EmptyClipboard")
	setClipboardData    = clipboardUser32.NewProc("SetClipboardData")
	globalAlloc         = clipboardKernel32.NewProc("GlobalAlloc")
	globalLock          = clipboardKernel32.NewProc("GlobalLock")
	globalUnlock        = clipboardKernel32.NewProc("GlobalUnlock")
	globalFree          = clipboardKernel32.NewProc("GlobalFree")
	moveClipboardMemory = clipboardKernel32.NewProc("RtlMoveMemory")
)

func writeTerminalClipboard(window *mygo.Window, text string) error {
	const movable = 0x0002
	const unicodeText = 13
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", "\r\n")
	units, err := syscall.UTF16FromString(text)
	if err != nil {
		return err
	}
	// Publish materialized CF_UNICODETEXT, so another process can read it
	// without waiting for ReqFlow to serve a delayed OLE clipboard provider.
	size := uintptr(len(units)) * unsafe.Sizeof(units[0])
	memory, _, err := globalAlloc.Call(movable, size)
	if memory == 0 {
		return fmt.Errorf("分配剪贴板内存：%w", err)
	}
	defer func() {
		if memory != 0 {
			globalFree.Call(memory)
		}
	}()
	address, _, err := globalLock.Call(memory)
	if address == 0 {
		return fmt.Errorf("锁定剪贴板内存：%w", err)
	}
	moveClipboardMemory.Call(address, uintptr(unsafe.Pointer(&units[0])), size)
	globalUnlock.Call(memory)
	var writeErr error
	mygo.RunOnMain(func() {
		for attempt := 0; ; attempt++ {
			opened, _, err := openClipboard.Call(window.NativeHandle())
			if opened != 0 {
				break
			}
			if attempt == 5 {
				writeErr = fmt.Errorf("打开剪贴板：%w", err)
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		defer closeClipboard.Call()
		if result, _, err := emptyClipboard.Call(); result == 0 {
			writeErr = fmt.Errorf("清空剪贴板：%w", err)
			return
		}
		if result, _, err := setClipboardData.Call(unicodeText, memory); result == 0 {
			writeErr = fmt.Errorf("写入剪贴板：%w", err)
			return
		}
		memory = 0 // The system owns the allocation after SetClipboardData succeeds.
	})
	return writeErr
}

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
	// Only registered desktops participate in desktop shutdown coordination.
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
