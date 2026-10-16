package backendgo

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var desktopPublishExtensions = []string{"mjs", "js", "cjs", "bat", "cmd", "ps1", "sh", "py"}
var desktopTerminalID = regexp.MustCompile(`^[a-zA-Z0-9-]{8,80}$`)
var desktopANSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var desktopBearer = regexp.MustCompile(`(?i)(Bearer\s+)\S+`)
var desktopSecrets = regexp.MustCompile(`(?i)((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s'"&]+`)
var desktopURLAuth = regexp.MustCompile(`(?i)(https?://)[^\s/@]+:[^\s/@]+@`)

func desktopCleanLog(s string) string {
	s = desktopANSI.ReplaceAllString(s, "")
	s = desktopBearer.ReplaceAllString(s, "${1}[已隐藏]")
	s = desktopSecrets.ReplaceAllString(s, "${1}[已隐藏]")
	s = desktopURLAuth.ReplaceAllString(s, "${1}[已隐藏]@")
	r := []rune(s)
	if len(r) > 4096 {
		s = string(r[:4096])
	}
	return s
}
func desktopRequestID() string {
	raw := make([]byte, 4)
	_, _ = rand.Read(raw)
	return hex.EncodeToString(raw)
}
func (b *Backend) desktopAppendLog(entry map[string]any) {
	for _, key := range []string{"stage", "project", "script", "text"} {
		if s, ok := entry[key].(string); ok {
			entry[key] = desktopCleanLog(s)
		}
	}
	settings, _ := desktopReadJSON(filepath.Join(b.DataDir, "publish-log-settings.json"), map[string]any{"enabled": true})
	if enabled, ok := desktopMap(settings)["enabled"].(bool); ok && !enabled {
		return
	}
	b.desktopLogMu.Lock()
	b.desktopLogPending = append(b.desktopLogPending, entry)
	if len(b.desktopLogPending) > 2000 {
		b.desktopLogPending = b.desktopLogPending[len(b.desktopLogPending)-2000:]
	}
	b.desktopLogMu.Unlock()
}
func (b *Backend) desktopFlushLogs() ([]any, error) {
	b.desktopLogMu.Lock()
	defer b.desktopLogMu.Unlock()
	value, e := desktopReadJSON(filepath.Join(b.DataDir, "publish-request-log.json"), []any{})
	if e != nil {
		return nil, e
	}
	entries := append(desktopList(value), b.desktopLogPending...)
	if len(entries) > 2000 {
		entries = entries[len(entries)-2000:]
	}
	size := 0
	start := len(entries)
	for i := len(entries) - 1; i >= 0; i-- {
		raw, _ := json.Marshal(entries[i])
		if size+len(raw) > 512*1024 {
			break
		}
		size += len(raw)
		start = i
	}
	entries = entries[start:]
	if len(b.desktopLogPending) > 0 {
		if e := desktopAtomicJSON(filepath.Join(b.DataDir, "publish-request-log.json"), entries); e != nil {
			return nil, e
		}
		b.desktopLogPending = nil
	}
	return entries, nil
}

type desktopPublishRun struct {
	b                                         *Backend
	mu                                        sync.Mutex
	start                                     time.Time
	requestID, project, script, stage, output string
	outputBytes                               int64
	done                                      bool
}

func (r *desktopPublishRun) entry(phase, text string, duration any) {
	r.mu.Lock()
	entry := map[string]any{"requestId": r.requestID, "project": r.project, "script": r.script, "time": desktopNow(), "phase": phase, "stage": r.stage, "elapsedMs": time.Since(r.start).Milliseconds()}
	if text != "" {
		entry["text"] = text
	}
	if duration != nil {
		entry["durationMs"] = duration
	}
	r.mu.Unlock()
	r.b.desktopAppendLog(entry)
}
func (r *desktopPublishRun) line(line string) {
	plain := strings.TrimRight(desktopANSI.ReplaceAllString(line, ""), "\r\n\t ")
	if strings.TrimSpace(plain) == "" {
		return
	}
	if strings.HasPrefix(plain, "@@REQFLOW_PUBLISH ") {
		var event map[string]any
		if json.Unmarshal([]byte(strings.TrimPrefix(plain, "@@REQFLOW_PUBLISH ")), &event) == nil {
			stage := desktopString(event["stage"])
			phase := desktopString(event["phase"])
			if stage != "" && len([]rune(stage)) <= 120 && (phase == "start" || phase == "complete" || phase == "error") {
				r.mu.Lock()
				r.stage = stage
				r.mu.Unlock()
				p := map[string]string{"start": "stage_start", "complete": "stage_complete", "error": "error"}[phase]
				r.entry(p, "", event["elapsedMs"])
				return
			}
		}
	}
	r.entry("output", plain, nil)
}

type desktopPublishWriter struct {
	r       *desktopPublishRun
	pending string
}

func (w *desktopPublishWriter) Write(raw []byte) (int, error) {
	text := string(raw)
	w.r.mu.Lock()
	w.r.output += text
	w.r.outputBytes += int64(len(raw))
	if len(w.r.output) > 200*1024 {
		w.r.output = w.r.output[len(w.r.output)-200*1024:]
	}
	w.r.mu.Unlock()
	w.pending += text
	for {
		index := strings.IndexAny(w.pending, "\r\n")
		if index < 0 {
			break
		}
		line := w.pending[:index]
		w.pending = w.pending[index+1:]
		w.r.line(line)
	}
	if len(w.pending) > 8192 {
		w.r.line(w.pending)
		w.pending = ""
	}
	return len(raw), nil
}
func desktopPublishCommand(ctx context.Context, file string) (*exec.Cmd, error) {
	ext := strings.ToLower(filepath.Ext(file))
	program := ""
	args := []string{}
	switch ext {
	case ".mjs", ".js", ".cjs":
		var e error
		program, e = exec.LookPath("node")
		if e != nil {
			return nil, errors.New("该项目发布脚本需要 Node.js，请在开发环境安装 Node 并加入 PATH；ReqFlow 2.0 自身不依赖 Node")
		}
		args = []string{file}
	case ".bat", ".cmd":
		program = "cmd.exe"
		args = []string{"/d", "/c", file}
	case ".ps1":
		program = "powershell.exe"
		args = []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file}
	case ".sh":
		program = "bash"
		args = []string{file}
	case ".py":
		program = "python"
		args = []string{"-u", file}
	default:
		return nil, errors.New("不支持的发布脚本类型：" + ext)
	}
	return desktopCommand(ctx, program, args, filepath.Dir(file)), nil
}

func (b *Backend) desktopPublish(ctx context.Context, channel string, args []any) (any, error) {
	if strings.HasPrefix(channel, "publish:terminal:") {
		return b.desktopPublishTerminal(channel, args)
	}
	switch channel {
	case "publish:output":
		b.desktopPublishMu.Lock()
		r := b.desktopPublishRuns[desktopText(args, 0)]
		b.desktopPublishMu.Unlock()
		if r == nil {
			return desktopOK(map[string]any{"data": "", "offset": 0, "done": false, "started": false}), nil
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		base := r.outputBytes - int64(len(r.output))
		offset := desktopInt(desktopArg(args, 1))
		truncated := offset < base
		if offset < base || offset > r.outputBytes {
			offset = base
		}
		// Send bytes so UTF-8 characters split across pipe writes decode correctly in xterm.
		data := base64.StdEncoding.EncodeToString([]byte(r.output[offset-base:]))
		return desktopOK(map[string]any{"data": data, "offset": r.outputBytes, "truncated": truncated, "done": r.done, "started": true}), nil
	case "publish:logs:get":
		entries, e := b.desktopFlushLogs()
		return desktopOK(map[string]any{"entries": entries}), e
	case "publish:logs:settings:get":
		value, e := desktopReadJSON(filepath.Join(b.DataDir, "publish-log-settings.json"), map[string]any{"enabled": true})
		return desktopOK(map[string]any{"settings": value}), e
	case "publish:logs:settings:save":
		settings := desktopMap(desktopArg(args, 0))
		if _, ok := settings["enabled"].(bool); !ok {
			return nil, errors.New("发布日志设置无效")
		}
		return desktopOK(nil), desktopAtomicJSON(filepath.Join(b.DataDir, "publish-log-settings.json"), map[string]any{"enabled": settings["enabled"]})
	case "publish:notice":
		notice := desktopMap(desktopArg(args, 0))
		title := "发布失败"
		if desktopBool(notice["ok"]) {
			title = "发布完成"
		}
		if project := desktopString(notice["project"]); project != "" {
			title += " · " + project
		}
		body := desktopString(notice["detail"])
		if strings.TrimSpace(body) == "" {
			body = "发布流程已结束，点击查看发布输出。"
		}
		runes := []rune(body)
		if len(runes) > 180 {
			body = string(runes[:180])
		}
		_, e := desktopNative(b, "notification", map[string]any{"title": title, "body": body, "silent": false})
		return desktopOK(nil), e
	case "publish:detect":
		root := desktopText(args, 0)
		if strings.TrimSpace(root) == "" {
			return desktopOK(map[string]any{"script": ""}), nil
		}
		for _, ext := range desktopPublishExtensions {
			for _, rel := range []string{"scripts/publish." + ext, "publish." + ext} {
				file, e := DesktopSafePath(root, rel)
				if e != nil {
					continue
				}
				if info, e := os.Stat(file); e == nil && info.Mode().IsRegular() {
					return desktopOK(map[string]any{"script": rel}), nil
				}
			}
		}
		return desktopOK(map[string]any{"script": ""}), nil
	case "publish:run":
		root, rel := desktopText(args, 0), desktopText(args, 1)
		r := &desktopPublishRun{b: b, start: time.Now(), requestID: desktopRequestID(), project: filepath.Base(root), script: rel, stage: "执行发布脚本"}
		if id := desktopText(args, 2); id != "" {
			if !desktopTerminalID.MatchString(id) {
				return nil, errors.New("发布终端标识无效")
			}
			b.desktopPublishMu.Lock()
			if b.desktopPublishRuns == nil {
				b.desktopPublishRuns = make(map[string]*desktopPublishRun)
			}
			if b.desktopPublishRuns[id] != nil {
				b.desktopPublishMu.Unlock()
				return nil, errors.New("发布终端标识已使用")
			}
			// Keep recent completed sessions for switching projects and reopening the dock.
			for key, previous := range b.desktopPublishRuns {
				previous.mu.Lock()
				remove := previous.done && (time.Since(previous.start) > 30*time.Minute || len(b.desktopPublishRuns) >= 20)
				previous.mu.Unlock()
				if remove {
					delete(b.desktopPublishRuns, key)
				}
			}
			if len(b.desktopPublishRuns) >= 20 {
				b.desktopPublishMu.Unlock()
				return nil, errors.New("同时执行的发布任务过多")
			}
			b.desktopPublishRuns[id] = r
			b.desktopPublishMu.Unlock()
			defer func() { r.mu.Lock(); r.done = true; r.mu.Unlock() }()
		}
		r.entry("request", "开始发布", nil)
		defer func() { _, _ = b.desktopFlushLogs() }()
		result := func(e error) (any, error) {
			r.mu.Lock()
			out := r.output
			if r.outputBytes > int64(len(out)) {
				out = "…（前文已截断）…\n" + out
			}
			r.mu.Unlock()
			if e != nil {
				r.entry("error", e.Error(), nil)
				return map[string]any{"ok": false, "error": e.Error(), "output": out}, nil
			}
			r.entry("complete", "发布成功", nil)
			return desktopOK(map[string]any{"output": out}), nil
		}
		if rel == "" {
			return result(errors.New("发布脚本路径无效"))
		}
		file, e := DesktopSafePath(root, rel)
		if e != nil {
			return result(e)
		}
		info, e := os.Stat(file)
		if e != nil {
			return result(e)
		}
		if !info.Mode().IsRegular() {
			return result(errors.New("发布脚本不存在"))
		}
		runCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		cmd, e := desktopPublishCommand(runCtx, file)
		if e != nil {
			return result(e)
		}
		stdout, stderr := &desktopPublishWriter{r: r}, &desktopPublishWriter{r: r}
		cmd.Stdout, cmd.Stderr = stdout, stderr
		done := make(chan struct{})
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					r.entry("progress", "仍在执行", nil)
					_, _ = b.desktopFlushLogs()
				}
			}
		}()
		e = cmd.Run()
		close(done)
		stdout.r.line(stdout.pending)
		stderr.r.line(stderr.pending)
		if runCtx.Err() != nil {
			e = errors.New("发布脚本超时或窗口已关闭，已终止")
		}
		if e != nil {
			r.mu.Lock()
			lines := strings.Split(strings.TrimSpace(r.output), "\n")
			r.mu.Unlock()
			if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
				e = fmt.Errorf("发布脚本执行失败：%s", strings.TrimSpace(lines[len(lines)-1]))
			}
		}
		return result(e)
	}
	return nil, errors.New("未知发布操作")
}

var _ io.Writer = (*desktopPublishWriter)(nil)
