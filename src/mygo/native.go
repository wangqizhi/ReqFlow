package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"

	"github.com/egoist/mygo"
)

type nativeHost struct {
	window        atomic.Pointer[mygo.Window]
	notifications desktopNotifications
}

type dialogOptions struct {
	Title       string   `json:"title"`
	DefaultPath string   `json:"defaultPath"`
	ButtonLabel string   `json:"buttonLabel"`
	Properties  []string `json:"properties"`
	Filters     []struct {
		Name       string   `json:"name"`
		Extensions []string `json:"extensions"`
	} `json:"filters"`
}

func firstString(args []any) string {
	if len(args) > 0 {
		value, _ := args[0].(string)
		return value
	}
	return ""
}

func options(args []any, value any) error {
	if len(args) == 0 {
		return nil
	}
	raw, err := json.Marshal(args[0])
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, value)
}

func filters(opts dialogOptions) []mygo.FileFilter {
	out := make([]mygo.FileFilter, len(opts.Filters))
	for i, f := range opts.Filters {
		out[i] = mygo.FileFilter{Name: f.Name, Extensions: f.Extensions}
	}
	return out
}

func hasProperty(opts dialogOptions, property string) bool {
	for _, v := range opts.Properties {
		if v == property {
			return true
		}
	}
	return false
}

func allowedExternal(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" || u.Scheme == "mailto" || (u.Scheme == "codex" && strings.EqualFold(u.Host, "threads"))
}

func (n *nativeHost) call(method string, args []any) (any, error) {
	w := n.window.Load()
	if w == nil {
		return nil, fmt.Errorf("native window is unavailable")
	}
	switch method {
	case "dialog.open", "openDialog":
		var opts dialogOptions
		if err := options(args, &opts); err != nil {
			return nil, err
		}
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: w, Title: opts.Title, DefaultPath: opts.DefaultPath, ButtonLabel: opts.ButtonLabel, Filters: filters(opts), Directory: hasProperty(opts, "openDirectory"), Multiple: hasProperty(opts, "multiSelections"), ShowHiddenFiles: hasProperty(opts, "showHiddenFiles"), CreateDirectories: hasProperty(opts, "createDirectory")})
		if paths == nil {
			paths = []string{}
		}
		return map[string]any{"canceled": len(paths) == 0, "filePaths": paths}, err
	case "dialog.save", "saveDialog":
		var opts dialogOptions
		if err := options(args, &opts); err != nil {
			return nil, err
		}
		path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: w, Title: opts.Title, DefaultPath: opts.DefaultPath, ButtonLabel: opts.ButtonLabel, Filters: filters(opts)})
		return map[string]any{"canceled": path == "", "filePath": path}, err
	case "shell.openPath", "openPath":
		if err := mygo.Shell.OpenPath(firstString(args)); err != nil {
			return err.Error(), nil
		}
		return "", nil
	case "shell.openExternal", "openExternal":
		raw := firstString(args)
		if !allowedExternal(raw) {
			return nil, fmt.Errorf("unsupported external URL")
		}
		return nil, mygo.Shell.OpenExternal(raw)
	case "shell.showItemInFolder", "showItemInFolder":
		mygo.Shell.ShowItemInFolder(firstString(args))
		return nil, nil
	case "window.minimize":
		w.Minimize()
	case "window.close":
		go mygo.App.Quit()
	case "window.show":
		w.Show()
	case "window.focus":
		w.Focus()
	case "window.restore":
		w.Restore()
	case "window.isFocused":
		return w.IsFocused(), nil
	case "window.isMinimized":
		return w.IsMinimized(), nil
	case "window.isVisible":
		return w.IsVisible(), nil
	case "notification.show", "notification":
		var opts mygo.NotificationOptions
		if err := options(args, &opts); err != nil {
			return nil, err
		}
		if w.IsFocused() && !w.IsMinimized() {
			return nil, nil
		}
		return nil, n.notifications.show(w, opts)
	default:
		return nil, fmt.Errorf("unsupported native operation: %s", method)
	}
	return nil, nil
}

func localNavigation(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return (u.Scheme == "mygo" && strings.EqualFold(u.Host, "localhost")) || (u.Scheme == "http" && strings.EqualFold(u.Host, "mygo.localhost"))
}
