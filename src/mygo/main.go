package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/egoist/mygo"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"reqflow/mygo/backendgo"
	"strings"
	"sync"
	"time"
)

//go:embed all:frontend
var frontend embed.FS
var appVersion = "2.0.0"

type ReqFlow struct{ backend *backendgo.Backend }

func (r *ReqFlow) Invoke(ctx context.Context, channel string, args []any) (any, error) {
	return r.backend.Invoke(ctx, channel, args)
}
func main() {
	code, err := run()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		if len(os.Args) <= 1 {
			showStartupError(err.Error())
		}
		code = 1
	}
	if code != 0 {
		os.Exit(code)
	}
}
func run() (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 1, err
	}
	appDir := filepath.Dir(exe)
	if value := os.Getenv("REQFLOW_APP_DIR"); value != "" {
		appDir = value
	}
	dataDir, err := resolveDataDir(appDir)
	if err != nil {
		return 1, err
	}
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--cli" {
		return backendgo.RunCLI(args[1:], appVersion, dataDir, os.Stdout), nil
	}
	backend := backendgo.NewBackend(dataDir, appDir, appVersion)
	// An explicit local harness exercises the compiled Go backend without a GUI.
	if len(args) > 0 && args[0] == "--test-invoke" {
		decoder := json.NewDecoder(os.Stdin)
		encoder := json.NewEncoder(os.Stdout)
		for {
			var request struct {
				Channel string `json:"channel"`
				Args    []any  `json:"args"`
			}
			if e := decoder.Decode(&request); e != nil {
				break
			}
			result, e := backend.Invoke(context.Background(), request.Channel, request.Args)
			if e != nil {
				result = map[string]any{"ok": false, "error": e.Error()}
			}
			if e := encoder.Encode(result); e != nil {
				return 1, e
			}
		}
		return 0, nil
	}
	if len(args) > 0 && args[0] == "--smoke" {
		report := map[string]any{"ok": true, "backend": "go", "version": appVersion}
		for _, channel := range []string{"workspace:get", "ai:settings:get", "storage:status"} {
			value, e := backend.Invoke(context.Background(), channel, []any{})
			m, _ := value.(map[string]any)
			valid := e == nil && m["ok"] == true
			report[channel] = valid
			if !valid {
				report["ok"] = false
			}
			if channel == "workspace:get" {
				state, _ := m["state"].(map[string]any)
				ps, _ := state["projects"].([]any)
				report["projects"] = len(ps)
			}
		}
		_ = json.NewEncoder(os.Stdout).Encode(report)
		if report["ok"] != true {
			return 1, errors.New("Go backend smoke failed")
		}
		return 0, nil
	}
	var reportPath string
	if len(args) > 1 && args[0] == "--smoke-ui" {
		reportPath = args[1]
	}
	logDir := filepath.Join(dataDir, "logs")
	_ = os.MkdirAll(logDir, 0700)
	if file, e := os.OpenFile(filepath.Join(logDir, "reqflow.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); e == nil {
		defer file.Close()
		log.SetOutput(file)
	}
	mygo.App.SetName("ReqFlow")
	mygo.App.SetVersion(appVersion)
	webviewDir := os.Getenv("REQFLOW_WEBVIEW_DIR")
	if webviewDir == "" {
		webviewDir = filepath.Join(dataDir, "webview2")
	}
	mygo.App.SetPath(mygo.PathUserData, webviewDir)
	assets, e := fs.Sub(frontend, "frontend")
	if e != nil {
		return 1, e
	}
	mygo.SetFrontend(assets)
	mygo.Bind(&ReqFlow{backend: backend})
	native := &nativeHost{}
	backend.Native = native.call
	backend.StartAI()
	defer backend.StopAI()
	mygo.App.WhenReady(func() {
		w := mygo.NewWindow(mygo.WindowOptions{Title: "ReqFlow · 需求流", Width: 1440, Height: 900, Frameless: true, DisableResize: true, DisableMaximize: true, URL: "/", BackgroundColor: "#f5f4f1", Page: mygo.PageOptions{DevTools: mygo.DevToolsDisabled}})
		if icon, e := fs.ReadFile(assets, "app-icon.png"); e == nil {
			_ = w.SetIcon(icon)
		}
		native.window.Store(w)
		w.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
			if !localNavigation(e.URL) {
				e.PreventDefault()
				if allowedExternal(e.URL) {
					go mygo.Shell.OpenExternal(e.URL)
				}
			}
		})
		w.Page().SetWindowOpenHandler(func(req mygo.WindowOpenRequest) *mygo.WindowOptions {
			if allowedExternal(req.URL) {
				go mygo.Shell.OpenExternal(req.URL)
			}
			return nil
		})
		var once sync.Once
		if reportPath != "" {
			w.Page().OnDOMReady(func() { once.Do(func() { go smokeUI(w, reportPath) }) })
			go func() {
				time.Sleep(45 * time.Second)
				once.Do(func() {
					_ = writeReport(reportPath, map[string]any{"ok": false, "error": "frontend DOM ready timeout"})
					mygo.App.Quit()
				})
			}()
		}
	})
	mygo.App.OnWindowAllClosed(func() { mygo.App.Quit() })
	return 0, mygo.App.Run()
}
func writeReport(path string, value any) error {
	raw, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	return os.WriteFile(path, raw, 0600)
}
func smokeUI(w *mygo.Window, path string) {
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	script := `(async()=>{
  let deadline=Date.now()+25000;while(Date.now()<deadline){if(document.querySelector('#root')?.children.length)break;await new Promise(r=>setTimeout(r,100));}
  let checks={};for(const channel of ['app:info','workspace:get','ai:settings:get','storage:status']){try{let r=await window.mygo.call('ReqFlow.Invoke',channel,[]);checks[channel]={ok:!!r&&r.ok!==false};if(channel==='app:info'){checks[channel].ok=r?.version===__REQFLOW_VERSION__&&r?.backend==='go';checks[channel].backend=r?.backend;checks[channel].version=r?.version;}if(channel==='workspace:get')checks[channel].count=r?.state?.projects?.length||0;}catch(e){checks[channel]={ok:false};}}
  let expected=checks['workspace:get']?.count;let until=Date.now()+5000;while(Date.now()<until&&document.querySelectorAll('.side-project[role="button"]').length!==expected){await new Promise(r=>setTimeout(r,100));}
  let sidebarProjects=document.querySelectorAll('.side-project[role="button"]').length;let controls=document.querySelectorAll('.window-controls button').length;let bar=document.querySelector('.window-bar');let dragRegion=bar?getComputedStyle(bar).getPropertyValue('--app-region').trim():'';let control=document.querySelector('.window-controls');let controlsDragRegion=control?getComputedStyle(control).getPropertyValue('--app-region').trim():'';
  return {ok:document.querySelector('#root')?.children.length>0&&Object.values(checks).every(x=>x.ok)&&sidebarProjects===expected&&controls===2&&dragRegion==='drag'&&controlsDragRegion==='no-drag',title:document.title,bodyTextLength:document.body?.innerText?.length||0,sidebarProjects,controls,dragRegion,controlsDragRegion,checks};
 })()`
	versionJSON, _ := json.Marshal(appVersion)
	result, err := w.Page().EvalContext(ctx, strings.ReplaceAll(script, "__REQFLOW_VERSION__", string(versionJSON)))
	if err != nil {
		result = map[string]any{"ok": false, "error": err.Error()}
	}
	if e := writeReport(path, result); e != nil {
		log.Printf("write UI smoke report: %v", e)
	}
	mygo.App.Quit()
}
func portableExecutable(name string) bool {
	return strings.HasPrefix(strings.ToLower(filepath.Base(name)), "reqflow-portable-")
}
