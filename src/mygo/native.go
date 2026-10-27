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
	prepareClose  func() bool
	window        atomic.Pointer[mygo.Window]
	notifications desktopNotifications
	terminals     map[string]*mygo.Window // Access only on the MyGO main thread.
	browsers      map[string]*mygo.Window
	browserReady  map[string]chan struct{}
	terminalReady map[string]chan struct{}
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
	case "window.prepareClose":
		return n.prepareClose == nil || n.prepareClose(), nil
	case "terminal.open", "terminal.close", "terminal.status":
		id := firstString(args)
		var detached bool
		mygo.RunOnMain(func() {
			if n.terminals == nil {
				n.terminals = make(map[string]*mygo.Window)
				n.terminalReady = make(map[string]chan struct{})
			}
			target := n.terminals[id]
			if method == "terminal.close" {
				if target != nil && !target.IsDestroyed() {
					target.Close()
				}
				return
			}
			if method == "terminal.open" {
				if target == nil || target.IsDestroyed() {
					project := ""
					if len(args) > 1 {
						project, _ = args[1].(string)
					}
					// Extra query is already URL-encoded by the backend; interactive
					// Agent sessions use it to tell the window which terminal to render.
					extra := ""
					if len(args) > 2 {
						extra, _ = args[2].(string)
					}
					area := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint()).WorkArea
					target = mygo.NewWindow(mygo.WindowOptions{Title: "Terminal · " + project, Width: 1000, Height: 500, MinWidth: 480, MinHeight: 240,
						X: area.X + (area.Width-1000)/2, Y: area.Y + (area.Height-500)/2,
						URL: "/?terminal=" + url.QueryEscape(id) + extra, BackgroundColor: "#1c1917", Page: mygo.PageOptions{DevTools: mygo.DevToolsDisabled}})
					n.terminals[id] = target
					ready := make(chan struct{})
					n.terminalReady[id] = ready
					target.Page().OnDOMReady(func() {
						select {
						case <-ready:
						default:
							close(ready)
						}
					})
					target.OnClosed(func() { delete(n.terminals, id); delete(n.terminalReady, id) })
					target.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
						if !localNavigation(e.URL) {
							e.PreventDefault()
						}
					})
					target.Page().SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
				}
				target.Restore()
				target.Show()
				target.Focus()
			}
			detached = target != nil && !target.IsDestroyed()
		})
		return detached, nil
	case "browser.open", "browser.close", "browser.maximize":
		id := firstString(args)
		if id == "" {
			return nil, fmt.Errorf("项目 ID 不能为空")
		}
		var exists bool
		mygo.RunOnMain(func() {
			if n.browsers == nil {
				n.browsers = make(map[string]*mygo.Window)
				n.browserReady = make(map[string]chan struct{})
			}
			target := n.browsers[id]
			if method == "browser.open" && (target == nil || target.IsDestroyed()) {
				area := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint()).WorkArea
				target = mygo.NewWindow(mygo.WindowOptions{Title: "浏览项目", Width: 1200, Height: 800, MinWidth: 600, MinHeight: 400, X: area.X + (area.Width-1200)/2, Y: area.Y + (area.Height-800)/2, URL: "/?browser=" + url.QueryEscape(id), BackgroundColor: "#fbfaf9", Page: mygo.PageOptions{DevTools: mygo.DevToolsDisabled}})
				n.browsers[id] = target
				ready := make(chan struct{})
				n.browserReady[id] = ready
				target.Page().OnDOMReady(func() {
					select {
					case <-ready:
					default:
						close(ready)
					}
				})
				target.OnClosed(func() { delete(n.browsers, id); delete(n.browserReady, id) })
				target.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
					if !localNavigation(e.URL) {
						e.PreventDefault()
					}
				})
				target.Page().SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
			}
			if target == nil || target.IsDestroyed() {
				return
			}
			exists = true
			switch method {
			case "browser.open":
				target.Restore()
				target.Show()
				target.Focus()
			case "browser.close":
				target.Close()
			case "browser.maximize":
				target.Maximize()
			}
		})
		return exists, nil
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
