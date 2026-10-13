package main

import (
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"github.com/egoist/mygo"
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
	window        uintptr
	callback      uintptr
	added         bool
	soundAccepted bool
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
	// Play one explicit Windows information sound after Shell accepts delivery;
	// suppress Shell's implicit sound to avoid playing the effect twice.
	d := notificationIconData{Window: window, ID: notificationID, Flags: 0x01 | 0x02 | 0x04 | 0x10, CallbackMessage: notificationMessage, Icon: icon, BalloonIcon: icon, InfoFlags: 0x04 | 0x20 | 0x10}
	d.Size = uint32(unsafe.Sizeof(d))
	if opts.Silent {
		d.InfoFlags |= 0x10
	}
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
		n.soundAccepted = false
		if !opts.Silent {
			accepted, _, _ := notificationUser32.NewProc("MessageBeep").Call(0x40) // MB_ICONINFORMATION, Windows configured sound.
			n.soundAccepted = accepted != 0
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
	silentRespected := !n.soundAccepted
	err = n.show(w, mygo.NotificationOptions{Title: "ReqFlow 音效检查", Body: "Windows 通知音效与点击返回检查"})
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	soundAccepted := n.soundAccepted
	mygo.RunOnMain(func() {
		notificationUser32.NewProc("SendMessageW").Call(w.NativeHandle(), notificationMessage, notificationID, 0x405)
	})
	return map[string]any{"ok": shown && !n.added && w.IsVisible() && !w.IsMinimized() && soundAccepted && silentRespected, "shellAccepted": shown, "clickRemovedTray": !n.added, "soundAccepted": soundAccepted, "silentRespected": silentRespected}
}
