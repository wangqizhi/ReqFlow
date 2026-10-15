package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"github.com/egoist/mygo"
	"golang.org/x/sys/windows/registry"
)

// MyGO 0.4.8 leaves hBalloonIcon empty. Windows Vista+ reads that member
// (not hIcon) for NIIF_USER; keep the fix in the host rather than the Go cache.
type notificationIconData struct {
	Size                       uint32
	Window                     uintptr
	ID, Flags, CallbackMessage uint32
	Icon                       uintptr
	Tip                        [128]uint16
	State, StateMask           uint32
	Info                       [256]uint16
	Version                    uint32
	InfoTitle                  [64]uint16
	InfoFlags                  uint32
	GUID                       [16]byte
	BalloonIcon                uintptr
}

const notificationMessage = 0x8000 + 121
const notificationID = 121

var notificationUser32 = syscall.NewLazyDLL("user32.dll")
var notificationShell = syscall.NewLazyDLL("shell32.dll").NewProc("Shell_NotifyIconW")
var notificationComctl = syscall.NewLazyDLL("comctl32.dll")

type desktopNotifications struct {
	window          uintptr
	callback        uintptr
	added           bool
	lastNoSound     bool
	lastSoundPlayed bool
}

func loadNotificationIcon() (uintptr, error) {
	instance, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	width, _, _ := notificationUser32.NewProc("GetSystemMetrics").Call(11)                               // SM_CXICON
	height, _, _ := notificationUser32.NewProc("GetSystemMetrics").Call(12)                              // SM_CYICON
	icon, _, err := notificationUser32.NewProc("LoadImageW").Call(instance, 1, 1, width, height, 0x8000) // IMAGE_ICON, LR_SHARED
	if icon == 0 {
		return 0, fmt.Errorf("无法加载 ReqFlow 通知图标资源 #1: %v", err)
	}
	return icon, nil // LR_SHARED: owned by Windows, never DestroyIcon.
}

func notificationText(dst []uint16, text string) {
	units := syscall.StringToUTF16(strings.ReplaceAll(text, "\x00", ""))
	n := len(units) - 1
	if n >= len(dst) {
		n = len(dst) - 1
	}
	if n > 0 && units[n-1] >= 0xd800 && units[n-1] <= 0xdbff {
		n--
	}
	copy(dst, units[:n])
	dst[n] = 0
}

func notificationData(window, icon uintptr, opts mygo.NotificationOptions) notificationIconData {
	// Shell acceptance does not mean a sound was played. Own audio delivery
	// explicitly and suppress Shell audio to avoid a double chime.
	d := notificationIconData{Window: window, ID: notificationID, Flags: 0x01 | 0x02 | 0x04 | 0x10, CallbackMessage: notificationMessage, Icon: icon, BalloonIcon: icon, InfoFlags: 0x04 | 0x20 | 0x10}
	d.Size = uint32(unsafe.Sizeof(d))
	notificationText(d.Tip[:], "ReqFlow")
	title := opts.Title
	if strings.TrimSpace(title) == "" {
		title = "ReqFlow"
	}
	notificationText(d.InfoTitle[:], title)
	body := opts.Body
	if opts.Subtitle != "" {
		body = opts.Subtitle + "\n" + body
	}
	notificationText(d.Info[:], body)
	return d
}

func notificationSoundPath() string {
	for _, event := range []string{"Notification.Default", "SystemNotification"} {
		key, err := registry.OpenKey(registry.CURRENT_USER, `AppEvents\Schemes\Apps\.Default\`+event+`\.Current`, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		file, _, _ := key.GetStringValue("")
		key.Close()
		file, _ = registry.ExpandString(file)
		if info, err := os.Stat(file); err == nil && !info.IsDir() {
			return file
		}
	}
	for _, name := range []string{"Windows Notify System Generic.wav", "Windows Notify.wav", "notify.wav"} {
		file := filepath.Join(os.Getenv("SystemRoot"), "Media", name)
		if info, err := os.Stat(file); err == nil && !info.IsDir() {
			return file
		}
	}
	return ""
}

func playNotificationSound() error {
	file := notificationSoundPath()
	if file == "" {
		return fmt.Errorf("未找到 Windows 通知音效文件")
	}
	name, err := syscall.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	// SND_FILENAME | SND_ASYNC | SND_NODEFAULT | SND_SYSTEM: use the system
	// notification audio session and respect its volume/mute setting.
	ok, _, _ := syscall.NewLazyDLL("winmm.dll").NewProc("PlaySoundW").Call(uintptr(unsafe.Pointer(name)), 0, 0x20000|0x1|0x2|0x200000)
	if ok == 0 {
		return fmt.Errorf("Windows 通知音效播放失败")
	}
	return nil
}

func (n *desktopNotifications) remove() {
	if n.added {
		d := notificationIconData{Window: n.window, ID: notificationID}
		d.Size = uint32(unsafe.Sizeof(d))
		notificationShell.Call(2, uintptr(unsafe.Pointer(&d))) // NIM_DELETE
		n.added = false
	}
}

func (n *desktopNotifications) show(w *mygo.Window, opts mygo.NotificationOptions) error {
	var result error
	mygo.RunOnMain(func() {
		icon, err := loadNotificationIcon()
		if err != nil {
			result = err
			return
		}
		if n.callback == 0 {
			n.window = w.NativeHandle()
			n.callback = syscall.NewCallback(func(hwnd uintptr, message uint32, wp, lp, id, data uintptr) uintptr {
				if message == notificationMessage && wp == notificationID {
					switch lp {
					case 0x405: // NIN_BALLOONUSERCLICK
						n.remove()
						w.Restore()
						w.Show()
						w.Focus()
					case 0x404: // NIN_BALLOONTIMEOUT
						n.remove()
					}
					return 0
				}
				if message == 0x82 { // WM_NCDESTROY
					n.remove()
					notificationComctl.NewProc("RemoveWindowSubclass").Call(hwnd, n.callback, notificationID)
				}
				r, _, _ := notificationComctl.NewProc("DefSubclassProc").Call(hwnd, uintptr(message), wp, lp)
				return r
			})
			ok, _, err := notificationComctl.NewProc("SetWindowSubclass").Call(n.window, n.callback, notificationID, 0)
			if ok == 0 {
				result = fmt.Errorf("无法注册通知点击事件: %v", err)
				n.callback = 0
				return
			}
		}
		d := notificationData(n.window, icon, opts)
		operation := uintptr(1) // NIM_MODIFY replaces the previous notification.
		if !n.added {
			operation = 0
		}
		ok, _, err := notificationShell.Call(operation, uintptr(unsafe.Pointer(&d)))
		if ok == 0 {
			n.remove()
			result = fmt.Errorf("无法显示 Windows 通知: %v", err)
			return
		}
		n.added = true
		n.lastNoSound = opts.Silent
		n.lastSoundPlayed = false
		if !opts.Silent {
			result = playNotificationSound()
			n.lastSoundPlayed = result == nil
		}
	})
	return result
}

func checkNotificationIcon() (map[string]any, error) {
	icon, err := loadNotificationIcon()
	if err != nil {
		return nil, err
	}
	d := notificationData(0, icon, mygo.NotificationOptions{Title: "ReqFlow", Body: "图标检查"})
	return map[string]any{"ok": d.BalloonIcon != 0 && d.BalloonIcon == d.Icon, "iconResource": 1, "balloonIcon": d.BalloonIcon != 0, "largeIcon": d.InfoFlags&0x20 != 0, "structureSize": d.Size}, nil
}

// Explicit UI smoke hook exercises Shell_NotifyIcon and our click callback.
// It runs only against the isolated test application, never the installed app.
func checkNotificationDelivery(w *mygo.Window) map[string]any {
	n := &desktopNotifications{}
	err := n.show(w, mygo.NotificationOptions{Title: "ReqFlow 图标检查", Body: "原生通知与点击返回检查", Silent: true})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	shown := n.added
	silentRespected := n.lastNoSound
	err = n.show(w, mygo.NotificationOptions{Title: "ReqFlow 音效检查", Body: "Windows 通知音效与点击返回检查"})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	// Verify the audio API accepted the file, not merely the Shell sound flag.
	soundEnabled := !n.lastNoSound && n.lastSoundPlayed
	mygo.RunOnMain(func() {
		notificationUser32.NewProc("SendMessageW").Call(w.NativeHandle(), notificationMessage, notificationID, 0x405)
	})
	return map[string]any{"ok": shown && !n.added && w.IsVisible() && !w.IsMinimized() && soundEnabled && silentRespected, "shellAccepted": shown, "clickRemovedTray": !n.added, "soundEnabled": soundEnabled, "silentRespected": silentRespected}
}
