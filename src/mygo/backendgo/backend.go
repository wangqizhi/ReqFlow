package backendgo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Backend owns all desktop business operations. No external JavaScript runtime
// participates in requests; the frontend calls this Go service directly.
type Backend struct {
	shutdownMu   sync.Mutex
	shuttingDown bool
	agentMu      sync.Mutex
	agentRuns    map[string]*agentRun

	DataDir, AppDir, Version                               string
	Workspace                                              *WorkspaceService
	Native                                                 func(string, []any) (any, error)
	mu                                                     sync.Mutex
	aiSessions                                             map[string]string
	desktopLogMu                                           sync.Mutex
	desktopLogPending                                      []any
	desktopPublishMu                                       sync.Mutex
	desktopPublishRuns                                     map[string]*desktopPublishRun
	desktopTerminalSessions                                map[string]publishTerminalSession
	desktopUpdateMu                                        sync.Mutex
	desktopUpdate                                          map[string]any
	desktopUpdateConfirmed                                 bool // REQ-285：本次更新流程已确认忽略执行中任务
	desktopAsset                                           map[string]any
	desktopChecksum, desktopInstaller, desktopExpectedHash string
	desktopUpdateBusy                                      bool
	desktopCheckoutMu                                      sync.Mutex
	desktopCheckouts                                       map[string]bool
}

func NewBackend(dataDir, appDir, version string) *Backend {
	workspace := NewWorkspaceService(dataDir)
	workspace.completionVersion = version
	return &Backend{DataDir: dataDir, AppDir: appDir, Version: version, Workspace: workspace, desktopUpdate: map[string]any{"phase": "idle"}, desktopCheckouts: make(map[string]bool)}
}

func desktopMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}
func desktopList(v any) []any {
	switch a := v.(type) {
	case []any:
		return a
	case []string:
		r := make([]any, len(a))
		for i, s := range a {
			r[i] = s
		}
		return r
	case []map[string]any:
		r := make([]any, len(a))
		for i, m := range a {
			r[i] = m
		}
		return r
	}
	return []any{}
}
func desktopString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
func desktopInt(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		x, _ := n.Int64()
		return x
	}
	return 0
}
func desktopBool(v any) bool { b, _ := v.(bool); return b }
func desktopArg(args []any, i int) any {
	if i >= 0 && i < len(args) {
		return args[i]
	}
	return nil
}
func desktopText(args []any, i int) string { return desktopString(desktopArg(args, i)) }
func desktopResult(err error) map[string]any {
	code := "ERROR"
	var coded interface{ Code() string }
	if errors.As(err, &coded) {
		code = coded.Code()
	}
	if strings.Contains(err.Error(), "数据已被其他方式修改") || strings.Contains(err.Error(), "VERSION_CONFLICT") {
		code = "VERSION_CONFLICT"
	}
	return map[string]any{"ok": false, "error": err.Error(), "code": code}
}
func desktopOK(value map[string]any) map[string]any {
	if value == nil {
		value = map[string]any{}
	}
	value["ok"] = true
	return value
}
func desktopAtomicJSON(file string, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	return desktopAtomic(file, raw, 0600)
}
func desktopAtomic(file string, raw []byte, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(file), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(file), ".reqflow-write-*")
	if e != nil {
		return e
	}
	temp := f.Name()
	defer os.Remove(temp)
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(raw)
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(temp, file)
}
func desktopReadJSON(file string, fallback any) (any, error) {
	raw, e := os.ReadFile(file)
	if errors.Is(e, os.ErrNotExist) {
		return fallback, nil
	}
	if e != nil {
		return nil, e
	}
	var v any
	e = json.Unmarshal(raw, &v)
	return v, e
}
func desktopNative(b *Backend, method string, args ...any) (any, error) {
	if b.Native == nil {
		return nil, fmt.Errorf("系统桌面操作尚未就绪：%s", method)
	}
	return b.Native(method, args)
}
func desktopProjects(result map[string]any) []any {
	return desktopList(desktopMap(result["state"])["projects"])
}
func (b *Backend) desktopProject(id string) (map[string]any, error) {
	r, e := b.Workspace.Get()
	if e != nil {
		return nil, e
	}
	for _, p := range desktopProjects(r) {
		m := desktopMap(p)
		if desktopString(m["id"]) == id {
			return m, nil
		}
	}
	return nil, errors.New("项目不存在")
}

func (b *Backend) Invoke(ctx context.Context, channel string, args []any) (result any, err error) {
	defer func() {
		if p := recover(); p != nil {
			result = desktopResult(fmt.Errorf("操作失败：%v", p))
			err = nil
		}
		if err != nil {
			result = desktopResult(err)
			err = nil
		}
	}()
	if value, handled, e := b.InvokeAI(channel, args); handled {
		return value, e
	}
	if strings.HasPrefix(channel, "server:") {
		return b.invokeServerAgents(channel, args)
	}
	if channel == "ssh:list" || channel == "ssh:status" || (strings.HasPrefix(channel, "fs:") && strings.HasPrefix(desktopText(args, 0), "ssh://")) {
		return b.desktopSSH(ctx, channel, args)
	}
	if strings.HasPrefix(channel, "git:") || channel == "dir:prepare" {
		return b.desktopGit(ctx, channel, args)
	}
	if strings.HasPrefix(channel, "fs:") {
		return b.desktopFiles(channel, args)
	}
	if strings.HasPrefix(channel, "agent:") {
		return b.desktopAgent(channel, args)
	}
	if strings.HasPrefix(channel, "publish:") {
		return b.desktopPublish(ctx, channel, args)
	}
	if strings.HasPrefix(channel, "data:") {
		return b.desktopArchive(channel, args)
	}
	if strings.HasPrefix(channel, "update:") {
		return b.desktopUpdater(ctx, channel, args)
	}
	switch channel {
	case "lab:terminal:get", "lab:terminal:save":
		file := filepath.Join(b.DataDir, "lab-terminal.json")
		if channel == "lab:terminal:save" {
			enabled, ok := desktopArg(args, 0).(bool)
			if !ok {
				return nil, errors.New("Terminal 设置无效")
			}
			if e := desktopAtomicJSON(file, map[string]any{"enabled": enabled}); e != nil {
				return nil, e
			}
		}
		value, e := desktopReadJSON(file, nil)
		if e != nil {
			return nil, e
		}
		return desktopOK(map[string]any{"settings": value}), nil
	case "lab:assign:get", "lab:assign:save":
		file := filepath.Join(b.DataDir, "lab-assign.json")
		if channel == "lab:assign:save" {
			enabled, ok := desktopArg(args, 0).(bool)
			if !ok {
				return nil, errors.New("指派设置无效")
			}
			if e := desktopAtomicJSON(file, map[string]any{"enabled": enabled}); e != nil {
				return nil, e
			}
		}
		value, e := desktopReadJSON(file, nil)
		if e != nil {
			return nil, e
		}
		return desktopOK(map[string]any{"settings": value}), nil
	case "context:settings:get":
		return b.Workspace.contextSettings()
	case "context:settings:save":
		return b.Workspace.moveContexts(desktopText(args, 0))
	case "workspace:get":
		r, e := b.Workspace.Get()
		if e != nil {
			return nil, e
		}
		return desktopOK(r), nil
	case "workspace:local":
		// 浏览窗口先读本地备份即可显示，不等待 Server Agent 网络刷新。
		r, e := b.Workspace.localService().Get()
		if e != nil {
			return nil, e
		}
		return desktopOK(r), nil
	case "workspace:apply":
		return b.desktopApply(desktopMap(desktopArg(args, 0)))
	case "storage:status":
		return desktopOK(map[string]any{"backend": b.Workspace.StorageStatus()}), nil
	case "storage:migrate":
		e := b.Workspace.MigrateToSQLite()
		if e != nil {
			return nil, e
		}
		return desktopOK(map[string]any{"backend": b.Workspace.StorageStatus()}), nil
	case "app:info":
		return map[string]any{"version": b.Version, "dataFile": b.Workspace.DataFile(), "platform": map[string]string{"windows": "win32"}[runtime.GOOS], "backend": "go", "runtime": "mygo"}, nil
	case "app:openConfigDir":
		if e := os.MkdirAll(b.DataDir, 0700); e != nil {
			return nil, e
		}
		v, e := desktopNative(b, "shell.openPath", b.DataDir)
		if e == nil && desktopString(v) != "" {
			e = errors.New(desktopString(v))
		}
		return desktopOK(nil), e
	case "app:showDataFile":
		_, e := desktopNative(b, "showItemInFolder", b.Workspace.DataFile())
		return desktopOK(nil), e
	case "browser:open", "browser:close", "browser:maximize":
		id := desktopText(args, 0)
		if id == "" {
			return nil, errors.New("项目 ID 不能为空")
		}
		if channel == "browser:open" {
			if _, err := b.desktopProject(id); err != nil {
				return nil, err
			}
		}
		value, err := desktopNative(b, strings.Replace(channel, ":", ".", 1), id)
		if err != nil {
			return nil, err
		}
		if value != true {
			return nil, errors.New("浏览窗口不可用")
		}
		return desktopOK(nil), nil
	case "window:control":
		action := desktopText(args, 0)
		if action != "minimize" && action != "close" {
			return nil, errors.New("窗口操作无效")
		}
		return desktopNative(b, "window."+action)
	case "dir:pick", "ssh:pick", "file:pickProgram":
		opts := map[string]any{"title": "选择项目目录", "properties": []string{"openDirectory", "createDirectory"}}
		if channel == "ssh:pick" {
			home, _ := os.UserHomeDir()
			opts = map[string]any{"title": "选择 SSH 私钥文件", "properties": []string{"openFile"}, "defaultPath": filepath.Join(home, ".ssh")}
		}
		if channel == "file:pickProgram" {
			opts = map[string]any{"title": "选择验证程序", "properties": []string{"openFile"}, "filters": []map[string]any{{"name": "可执行程序", "extensions": []string{"exe", "bat", "cmd", "lnk"}}}}
		}
		value, e := desktopNative(b, "openDialog", opts)
		if e != nil {
			return nil, e
		}
		picked := desktopMap(value)
		file := ""
		if files := desktopList(picked["filePaths"]); !desktopBool(picked["canceled"]) && len(files) > 0 {
			file = desktopString(files[0])
		}
		key := "path"
		if channel == "dir:pick" {
			key = "dir"
		}
		return desktopOK(map[string]any{key: file}), nil
	case "shell:openExternal":
		value := desktopText(args, 0)
		if !strings.HasPrefix(strings.ToLower(value), "https://") && !strings.HasPrefix(strings.ToLower(value), "http://") {
			return nil, errors.New("仅支持 http(s) 网页地址")
		}
		_, e := desktopNative(b, "openExternal", value)
		return desktopOK(nil), e
	case "shell:openCodexDeepLink":
		value := desktopText(args, 0)
		lower := strings.ToLower(value)
		if lower != "codex://threads" && !strings.HasPrefix(lower, "codex://threads/") && !strings.HasPrefix(lower, "codex://threads?") {
			return nil, errors.New("仅支持 codex://threads 链接")
		}
		_, e := desktopNative(b, "openExternal", value)
		return desktopOK(nil), e
	case "dir:terminal":
		r, err := b.Workspace.localService().Get()
		if err != nil {
			return nil, err
		}
		p := coreFind(coreList(coreMap(r["state"])["projects"]), desktopText(args, 0))
		if p == nil {
			return nil, errors.New("项目不存在")
		}
		root := coreString(p["dir"])
		info, err := os.Stat(root)
		if err != nil {
			return nil, err
		}
		if !filepath.IsAbs(root) || !info.IsDir() {
			return nil, errors.New("项目目录无效")
		}
		err = openProjectTerminal(root, coreString(p["terminalCli"]), p["terminalFullAccess"] != false)
		return desktopOK(nil), err
	case "dir:open":
		// REQ-146：从资源管理器打开项目目录；仅允许绝对路径下的目录。
		value := desktopText(args, 0)
		if !filepath.IsAbs(value) {
			return nil, errors.New("目录路径无效")
		}
		info, e := os.Stat(value)
		if e != nil {
			return nil, e
		}
		if !info.IsDir() {
			return nil, errors.New("路径不是目录")
		}
		r, e := desktopNative(b, "shell.openPath", value)
		if e == nil && desktopString(r) != "" {
			e = errors.New(desktopString(r))
		}
		return desktopOK(nil), e
	case "verify:open":
		source := desktopMap(desktopArg(args, 0))
		value := strings.TrimSpace(desktopString(source["value"]))
		if value == "" {
			return nil, errors.New("未配置验证源")
		}
		switch desktopString(source["kind"]) {
		case "url":
			return b.Invoke(ctx, "shell:openExternal", []any{value})
		case "exe":
			if !filepath.IsAbs(value) {
				return nil, errors.New("请配置可执行程序的绝对路径")
			}
			if _, e := os.Stat(value); e != nil {
				return nil, e
			}
			r, e := desktopNative(b, "shell.openPath", value)
			if e == nil && desktopString(r) != "" {
				e = errors.New(desktopString(r))
			}
			return desktopOK(nil), e
		}
		return nil, errors.New("验证源类型无效")
	}
	return nil, fmt.Errorf("未知桌面接口：%s", channel)
}

func (b *Backend) desktopApply(action map[string]any) (any, error) {
	if coreString(action["op"]) == "executionRelease" {
		b.shutdownMu.Lock()
		defer b.shutdownMu.Unlock()
		if b.shuttingDown {
			return nil, errors.New("ReqFlow 正在关闭，执行中任务将保留")
		}
	}
	var expected *int64
	if v, ok := action["expectedVersion"]; ok {
		n := desktopInt(v)
		expected = &n
	}
	if desktopString(action["op"]) == "projectDir" && strings.HasPrefix(desktopString(action["dir"]), "ssh://") {
		if _, e := b.desktopSSH(context.Background(), "ssh:status", []any{action["dir"]}); e != nil {
			return nil, e
		}
	}
	if desktopString(action["op"]) == "project" {
		if strings.TrimSpace(desktopString(action["name"])) == "" {
			return nil, errors.New("请填写项目名称")
		}
		if remote, ok := action["remote"]; ok {
			if _, e := ValidateRemote(remote); e != nil {
				return nil, e
			}
		}
		current, e := b.Workspace.Get()
		if e != nil {
			return nil, e
		}
		if expected != nil && *expected != desktopInt(current["version"]) {
			return nil, errors.New("数据已被其他方式修改，请刷新后重试。")
		}
		folders := desktopList(desktopMap(current["state"])["folders"])
		if v, ok := action["newFolderName"]; ok {
			name := strings.TrimSpace(desktopString(v))
			if name == "" {
				return nil, errors.New("请填写文件夹名称")
			}
			for _, f := range folders {
				if desktopString(desktopMap(f)["name"]) == name {
					return nil, errors.New("文件夹名称已存在")
				}
			}
		} else if v, ok := action["folderId"]; ok {
			found := false
			for _, f := range folders {
				if desktopMap(f)["id"] == v {
					found = true
				}
			}
			if !found {
				return nil, errors.New("文件夹不存在")
			}
		}
		if dir := desktopString(action["dir"]); dir != "" {
			if strings.HasPrefix(dir, "ssh://") {
				if _, e := b.desktopSSH(context.Background(), "ssh:status", []any{dir}); e != nil {
					return nil, e
				}
				if desktopString(desktopMap(action["remote"])["url"]) != "" {
					return nil, errors.New("远程目录暂不支持本地 Git 仓库拉取")
				}
			} else {
				prepared, e := desktopPrepareDirectory(dir, desktopBool(action["createDirectory"]))
				if e != nil {
					return nil, e
				}
				action["dir"] = prepared
			}
		}
	}
	r, e := b.Workspace.Mutate(action, expected)
	if e != nil {
		return nil, e
	}
	if desktopString(action["op"]) == "project" && desktopString(desktopMap(action["remote"])["url"]) != "" {
		ps := desktopProjects(r)
		p := desktopMap(ps[len(ps)-1])
		remote, e := ValidateRemote(p["remote"])
		summary := ""
		if e == nil {
			summary, e = b.desktopCheckout(desktopString(p["dir"]), remote, false)
		}
		latest, readErr := b.Workspace.Get()
		if readErr != nil {
			return nil, readErr
		}
		latest["createdProjectId"] = p["id"]
		if e != nil {
			latest["warning"] = "项目已保存，但远程文件未拉取，请调整配置后重试：" + e.Error()
		} else {
			latest["summary"] = summary
		}
		return desktopOK(latest), nil
	}
	return desktopOK(r), nil
}

func desktopNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
