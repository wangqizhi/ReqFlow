//go:build !windows

package main

import "github.com/egoist/mygo"

type desktopNotifications struct{}

func (n *desktopNotifications) show(w *mygo.Window, opts mygo.NotificationOptions) error {
	notice := mygo.NewNotification(opts)
	notice.OnClick(func() { w.Restore(); w.Show(); w.Focus() })
	return notice.Show()
}

func checkNotificationIcon() (map[string]any, error) {
	return map[string]any{"ok": true, "platform": "non-windows"}, nil
}

func checkNotificationDelivery(w *mygo.Window) map[string]any {
	return map[string]any{"ok": true, "platform": "non-windows"}
}
