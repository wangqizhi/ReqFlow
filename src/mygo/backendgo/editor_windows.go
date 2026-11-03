package backendgo

import (
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	editorUser32                 = windows.NewLazySystemDLL("user32.dll")
	procEditorGetWindowText      = editorUser32.NewProc("GetWindowTextW")
	procEditorIsIconic           = editorUser32.NewProc("IsIconic")
	procEditorShowWindow         = editorUser32.NewProc("ShowWindow")
	procEditorSetForeground      = editorUser32.NewProc("SetForegroundWindow")
	procEditorAllowForeground    = editorUser32.NewProc("AllowSetForegroundWindow")
	procEditorBringWindowToTop   = editorUser32.NewProc("BringWindowToTop")
	procEditorAttachThreadInput  = editorUser32.NewProc("AttachThreadInput")
	editorEnumCallbackOnce       sync.Once
	editorEnumCallback           uintptr
	editorEnumMu                 sync.Mutex
	editorEnumHandles            []windows.HWND
	editorWindowWait             = 20 * time.Second
	editorCustomTitleGracePeriod = 3 * time.Second
)

type editorWindow struct {
	hwnd  windows.HWND
	title string
}

// allowEditorForeground 在用户点击后（ReqFlow 仍是前台进程）放开前台限制。
// VS Code 由 CLI 间接拉起，自身没有前台权限，否则新窗口会被压在 ReqFlow 后面。
func allowEditorForeground() {
	procEditorAllowForeground.Call(uintptr(0xFFFFFFFF)) // ASFW_ANY
}

// editorWindowSnapshot 记录启动前已存在的编辑器窗口，用于识别新打开的窗口。
func editorWindowSnapshot(program string) map[uintptr]bool {
	result := map[uintptr]bool{}
	for _, window := range listEditorWindows(program) {
		result[uintptr(window.hwnd)] = true
	}
	return result
}

// awaitEditorWindow 等待 VS Code 显示项目窗口并切到前台；超时未出现窗口时返回错误，
// 避免 CLI 返回成功但实际没有窗口时界面静默无反馈。
func awaitEditorWindow(program, dir string, before map[uintptr]bool) error {
	name := strings.ToLower(filepath.Base(dir))
	deadline := time.Now().Add(editorWindowWait)
	var fresh windows.HWND
	var freshSince time.Time
	for {
		windowsNow := listEditorWindows(program)
		for _, window := range windowsNow {
			if name != "" && strings.Contains(strings.ToLower(window.title), name) {
				activateEditorWindow(window.hwnd)
				return nil
			}
		}
		for _, window := range windowsNow {
			if !before[uintptr(window.hwnd)] && fresh == 0 {
				fresh, freshSince = window.hwnd, time.Now()
			}
		}
		// 自定义 window.title 时标题可能不含目录名：新窗口出现一段时间后直接激活。
		if fresh != 0 && time.Since(freshSince) >= editorCustomTitleGracePeriod {
			activateEditorWindow(fresh)
			return nil
		}
		if time.Now().After(deadline) {
			if fresh != 0 {
				activateEditorWindow(fresh)
				return nil
			}
			return errors.New("已调用 VS Code，但 20 秒内未检测到其窗口；若 VS Code 正在更新或首次启动较慢，请稍后重试")
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func listEditorWindows(program string) []editorWindow {
	editorEnumCallbackOnce.Do(func() {
		// 回调只创建一次（NewCallback 数量有上限），结果写入受锁保护的包级切片。
		editorEnumCallback = windows.NewCallback(func(hwnd windows.HWND, param uintptr) uintptr {
			editorEnumHandles = append(editorEnumHandles, hwnd)
			return 1
		})
	})
	editorEnumMu.Lock()
	editorEnumHandles = nil
	windows.EnumWindows(editorEnumCallback, nil)
	handles := editorEnumHandles
	editorEnumHandles = nil
	editorEnumMu.Unlock()
	paths := map[uint32]bool{}
	result := []editorWindow{}
	for _, hwnd := range handles {
		if !windows.IsWindowVisible(hwnd) {
			continue
		}
		var pid uint32
		if _, err := windows.GetWindowThreadProcessId(hwnd, &pid); err != nil || pid == 0 {
			continue
		}
		match, known := paths[pid]
		if !known {
			match = strings.EqualFold(filepath.Clean(processImagePath(pid)), filepath.Clean(program))
			paths[pid] = match
		}
		if !match {
			continue
		}
		buffer := make([]uint16, 512)
		length, _, _ := procEditorGetWindowText.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
		if length == 0 {
			continue
		}
		result = append(result, editorWindow{hwnd: hwnd, title: windows.UTF16ToString(buffer[:length])})
	}
	return result
}

func processImagePath(pid uint32) string {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(process)
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(process, 0, &buffer[0], &size); err != nil {
		return ""
	}
	return windows.UTF16ToString(buffer[:size])
}

func activateEditorWindow(hwnd windows.HWND) {
	if minimized, _, _ := procEditorIsIconic.Call(uintptr(hwnd)); minimized != 0 {
		procEditorShowWindow.Call(uintptr(hwnd), 9) // SW_RESTORE
	}
	if ok, _, _ := procEditorSetForeground.Call(uintptr(hwnd)); ok != 0 {
		return
	}
	// 前台锁定时临时挂接当前前台线程的输入队列，再切换窗口。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	current := windows.GetCurrentThreadId()
	foreground, _ := windows.GetWindowThreadProcessId(windows.GetForegroundWindow(), nil)
	if foreground != 0 && foreground != current {
		procEditorAttachThreadInput.Call(uintptr(current), uintptr(foreground), 1)
		defer procEditorAttachThreadInput.Call(uintptr(current), uintptr(foreground), 0)
	}
	procEditorBringWindowToTop.Call(uintptr(hwnd))
	procEditorSetForeground.Call(uintptr(hwnd))
}
