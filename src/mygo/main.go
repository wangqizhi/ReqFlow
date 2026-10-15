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

//go:embed ui-smoke.js
var uiSmokeScript string
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
	if len(os.Args) == 2 && os.Args[1] == "--check-notification-icon" {
		report, err := checkNotificationIcon()
		if err != nil {
			return 1, err
		}
		return 0, json.NewEncoder(os.Stdout).Encode(report)
	}
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
		// REQ-144：多屏环境下按鼠标所在屏幕居中启动（省略 X/Y 时 mygo 固定在主屏居中）
		const windowWidth, windowHeight = 1440, 900
		area := mygo.Screen.DisplayNearestPoint(mygo.Screen.CursorScreenPoint()).WorkArea
		w := mygo.NewWindow(mygo.WindowOptions{Title: "ReqFlow · 需求流", Width: windowWidth, Height: windowHeight,
			X: area.X + (area.Width-windowWidth)/2, Y: area.Y + (area.Height-windowHeight)/2,
			Frameless: true, DisableResize: true, DisableMaximize: true, URL: "/", BackgroundColor: "#f5f4f1", Page: mygo.PageOptions{DevTools: mygo.DevToolsDisabled}})
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
	versionJSON, _ := json.Marshal(appVersion)
	script := strings.ReplaceAll(uiSmokeScript, "__REQFLOW_VERSION__", string(versionJSON))
	script = strings.ReplaceAll(script, "__REQFLOW_INTERACTIONS__", fmt.Sprint(os.Getenv("REQFLOW_UI_INTERACTIONS") == "1"))
	result, err := w.Page().EvalContext(ctx, script)
	if err != nil {
		result = map[string]any{"ok": false, "error": err.Error()}
	}
	if os.Getenv("REQFLOW_UI_NOTIFICATION") == "1" {
		check := checkNotificationDelivery(w)
		if report, ok := result.(map[string]any); ok {
			report["notification"] = check
			if check["ok"] != true {
				report["ok"] = false
			}
		}
	}
	if e := writeReport(path, result); e != nil {
		log.Printf("write UI smoke report: %v", e)
	}
	if os.Getenv("REQFLOW_UI_INTERACTIONS") == "1" {
		if png, e := w.CapturePage(); e == nil {
			_ = os.WriteFile(path+".png", png, 0600)
		}
		w.SetSize(1440, 720)
		time.Sleep(150 * time.Millisecond)
		compact, e := w.Page().EvalContext(ctx, `(()=>{const buttons=[...document.querySelectorAll('.editor-footer button')];return {ok:buttons.length===2&&buttons.every(button=>button.getBoundingClientRect().bottom<innerHeight),height:innerHeight};})()`)
		if e != nil {
			compact = map[string]any{"ok": false, "error": e.Error()}
		}
		_ = writeReport(path+".compact.json", compact)
		if png, e := w.CapturePage(); e == nil {
			_ = os.WriteFile(path+".compact.png", png, 0600)
		}
		schedule, e := w.Page().EvalContext(ctx, `(async()=>{
          const waitFor=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Compact layout timeout');await new Promise(r=>setTimeout(r,40));}};
          await waitFor(()=>!document.querySelector('.requirement-dialog [aria-label="关闭"]')?.disabled);
          document.querySelector('.requirement-dialog [aria-label="关闭"]')?.click();
          await waitFor(()=>!document.querySelector('.overlay'));
          [...document.querySelectorAll('.navtab')].find(b=>b.textContent.startsWith('排期')).click();
          await waitFor(()=>document.querySelector('.workspace-toolbar'));
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const panel=document.querySelector('.workspace-toolbar');const buttons=[...panel.querySelectorAll('button')];
          return {ok:panel.getBoundingClientRect().top>=document.querySelector('.list-scroll').getBoundingClientRect().bottom&&buttons.every(b=>b.getBoundingClientRect().bottom<=innerHeight)&&!document.querySelector('.page-foot')&&!document.querySelector('.overlay'),height:innerHeight,bottom:panel.getBoundingClientRect().bottom};
        })()`)
		if e != nil {
			schedule = map[string]any{"ok": false, "error": e.Error()}
		}
		_ = writeReport(path+".schedule.json", schedule)
		if png, e := w.CapturePage(); e == nil {
			_ = os.WriteFile(path+".schedule.png", png, 0600)
		}
		// Capture the changed surfaces at the standard and lower window height.
		for _, height := range []int{900, 720} {
			w.SetSize(1440, height)
			time.Sleep(150 * time.Millisecond)
			for _, surface := range []string{"projects", "guide", "ssh"} {
				code := `(async()=>{
                  document.querySelector('.overlay')?.click();
                  await new Promise(r=>setTimeout(r,80));
                  const projects=SURFACE==='projects',ssh=SURFACE==='ssh';
                  const trigger=projects?document.querySelector('[aria-label="管理项目"]'):[...document.querySelectorAll('button')].find(b=>b.textContent===(ssh?'新建项目':'编辑设置'));
                  trigger.click();await new Promise(r=>setTimeout(r,100));
                  if(ssh){[...document.querySelectorAll('button')].find(b=>b.textContent==='连接远程服务器').click();await new Promise(r=>setTimeout(r,80));}
                  else if(!projects){document.querySelector('.guidance-view').click();await new Promise(r=>setTimeout(r,80));}
                  const dialog=document.querySelector(projects?'.project-manager':ssh?'.ssh-directory':'.project-guide-dialog');
                  const rect=dialog.getBoundingClientRect();
                  const list=dialog.querySelector(projects?'.project-manager-list':ssh?'.ssh-connection-fields':'.settings-body');
                  const footer=dialog.querySelector(projects||ssh?'.dialog-foot':'.settings-footer').getBoundingClientRect();
                  const input=dialog.querySelector('.guidance-input-wrap textarea');
                  return {ok:rect.top>=0&&rect.bottom<=innerHeight+1&&footer.bottom<=innerHeight+1&&(!input||Math.abs(input.getBoundingClientRect().width-input.parentElement.getBoundingClientRect().width)<1),height:innerHeight,scrollable:list.scrollHeight>=list.clientHeight};
                })()`
				code = strings.ReplaceAll(code, "SURFACE", fmt.Sprintf("%q", surface))
				report, err := w.Page().EvalContext(ctx, code)
				if err != nil {
					report = map[string]any{"ok": false, "error": err.Error()}
				}
				name := fmt.Sprintf("%s.%s-%d", path, surface, height)
				_ = writeReport(name+".json", report)
				if png, err := w.CapturePage(); err == nil {
					_ = os.WriteFile(name+".png", png, 0600)
				}
			}
			for _, surface := range []string{"settings-api", "settings-cli", "settings-data"} {
				code := `(async()=>{
                  const pause=()=>new Promise(r=>setTimeout(r,100));
                  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
                  document.querySelector('[aria-label="关闭远程目录"]')?.click();await pause();
                  document.querySelector('.overlay')?.click();await pause();
                  if(!document.querySelector('.settings-page')) { button('设置').click();await pause(); }
                  const nav=document.querySelector('[aria-label="设置功能菜单"]');
                  const data=SURFACE==='settings-data';
                  [...nav.querySelectorAll('button')].find(b=>b.textContent===(data?'数据':'AI 供应商')).click();await pause();
                  if(!data){button(SURFACE==='settings-cli'?'本地 CLI':'API 服务').click();await pause();}
                  const page=document.querySelector('.settings-page');const rect=page.getBoundingClientRect();
                  const footer=page.querySelector('.settings-footer').getBoundingClientRect();
                  const body=page.querySelector('.settings-body');
                  const ok=rect.top>=0&&rect.bottom<=innerHeight+1&&footer.bottom<=innerHeight+1&&footer.top>=body.getBoundingClientRect().bottom-1&&nav.querySelectorAll('button').length===6&&!document.querySelector('.overlay')&&page.clientWidth===document.querySelector('.main').clientWidth;
                  return {ok,height:innerHeight,scrollable:body.scrollHeight>body.clientHeight};
                })()`
				code = strings.ReplaceAll(code, "SURFACE", fmt.Sprintf("%q", surface))
				report, err := w.Page().EvalContext(ctx, code)
				if err != nil {
					report = map[string]any{"ok": false, "error": err.Error()}
				}
				name := fmt.Sprintf("%s.%s-%d", path, surface, height)
				_ = writeReport(name+".json", report)
				if png, err := w.CapturePage(); err == nil {
					_ = os.WriteFile(name+".png", png, 0600)
				}
			}
			_, _ = w.Page().EvalContext(ctx, `(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent==='返回项目菜单').click();await new Promise(r=>setTimeout(r,100));[...document.querySelectorAll('button')].find(b=>b.textContent==='放弃更改')?.click()})()`)
			time.Sleep(100 * time.Millisecond)
		}
	}
	mygo.App.Quit()
}
func portableExecutable(name string) bool {
	return strings.HasPrefix(strings.ToLower(filepath.Base(name)), "reqflow-portable-")
}
