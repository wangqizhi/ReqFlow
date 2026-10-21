package backendgo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Resolve only the official CLI; never substitute a similarly named npm package.
// REQFLOW_ZCODE_CLI supports a custom executable or a complete official Node bundle.
func zcodeEntry() (string, []string, error) {
	candidates := []string{os.Getenv("REQFLOW_ZCODE_CLI")}
	if candidates[0] == "" {
		if p, err := exec.LookPath("zcode"); err == nil {
			candidates = append(candidates, p)
		}
		candidates = append(candidates, filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "ZCode", "resources", "glm", "zcode.cjs"))
	}
	for _, p := range candidates {
		if p == "" {
			continue
		}
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(p), ".cjs") || strings.HasSuffix(strings.ToLower(p), ".js") {
			node, err := exec.LookPath("node")
			if err != nil {
				return "", nil, errors.New("ZCode CLI 需要 Node.js，请安装后重启 ReqFlow")
			}
			return node, []string{p}, nil
		}
		if runtime.GOOS == "windows" && (strings.HasSuffix(strings.ToLower(p), ".cmd") || strings.HasSuffix(strings.ToLower(p), ".bat") || strings.HasSuffix(strings.ToLower(p), ".ps1")) {
			// Prefer the complete official bundle over invoking shell shims with task arguments.
			continue
		}
		return p, nil, nil
	}
	return "", nil, errors.New("未找到官方 ZCode CLI；请安装 ZCode，或设置 REQFLOW_ZCODE_CLI 为官方入口绝对路径")
}

func probeZCode() map[string]any {
	program, prefix, err := zcodeEntry()
	if err != nil {
		return map[string]any{"installed": false, "error": err.Error()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, program, append(prefix, "--version")...)
	aiHideCommand(cmd)
	out := &aiLimitedOutput{limit: 16384}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if cmd.Run() != nil || out.tooLarge {
		return map[string]any{"installed": false, "error": "ZCode 入口损坏或检测超时"}
	}
	return map[string]any{"installed": true, "version": aiAgentVersion.FindString(out.String())}
}

type zcodeTask struct {
	cmd       *exec.Cmd
	reader    *io.PipeReader
	writer    *io.PipeWriter
	file      string
	done      chan struct{}
	mu        sync.Mutex
	code      uint32
	err       error
	reason    string
	closeOnce sync.Once
	cleanup   func()
}

func zcodeTaskArgs(prefix []string, root, file string) []string {
	return append(append([]string{}, prefix...), "--prompt", "请读取 UTF-8 附件任务，使用 ReqFlow Agent 插件仅领取并执行文件列出的需求 ID，完成后回写待验证。", "--attach", file, "--cwd", root, "--mode", "build", "--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode", "--output-format", "stream-json", "--no-color")
}

func startZCodeTask(root, prompt string) (agentPTY, error) {
	program, prefix, err := zcodeEntry()
	if err != nil {
		return nil, err
	}
	// Probe actual parser support without a model call, credentials access or installation.
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	check := exec.CommandContext(ctx, program, append(append([]string{}, prefix...), "--prompt", "/help", "--mode", "build", "--output-format", "stream-json", "--no-color")...)
	check.Dir = root
	aiHideCommand(check)
	check.Stdout = io.Discard
	check.Stderr = io.Discard
	err = check.Run()
	cancel()
	if err != nil {
		return nil, errors.New("ZCode CLI 能力检测失败，请检查官方安装资源与参数兼容性")
	}
	file, err := os.CreateTemp("", "reqflow-zcode-*.txt")
	if err != nil {
		return nil, err
	}
	name := file.Name()
	_, err = file.WriteString(prompt)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		os.Remove(name)
		return nil, errors.New("写入 ZCode 任务文件失败")
	}
	reader, writer := io.Pipe()
	cmd := exec.Command(program, zcodeTaskArgs(prefix, root, name)...)
	cmd.Dir = root
	aiHideCommand(cmd)
	stdout, stderr := &zcodeLogWriter{target: writer}, &zcodeLogWriter{target: writer}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	task := &zcodeTask{cmd: cmd, reader: reader, writer: writer, file: name, done: make(chan struct{})}
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		os.Remove(name)
		return nil, err
	}
	cleanup, err := containAgentProcess(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		reader.Close()
		writer.Close()
		_ = cmd.Wait()
		os.Remove(name)
		return nil, err
	}
	task.cleanup = cleanup
	timeout := 2 * time.Hour
	if v, err := time.ParseDuration(os.Getenv("REQFLOW_ZCODE_TIMEOUT")); err == nil && v >= time.Minute && v <= 24*time.Hour {
		timeout = v
	}
	go func() {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		select {
		case <-timer.C:
			task.stop("任务超时")
		case <-task.done:
		}
	}()
	go func() {
		err := cmd.Wait()
		cleanup()
		_ = stdout.flush()
		_ = stderr.flush()
		task.mu.Lock()
		task.err = err
		if err != nil {
			task.code = 1
		}
		if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() >= 0 {
			task.code = uint32(cmd.ProcessState.ExitCode())
		}
		task.mu.Unlock()
		os.Remove(name)
		writer.Close()
		close(task.done)
	}()
	return task, nil
}

func (t *zcodeTask) Read(p []byte) (int, error)  { return t.reader.Read(p) }
func (t *zcodeTask) Write(p []byte) (int, error) { return 0, errors.New("ZCode 仅支持任务日志") }
func (t *zcodeTask) Resize(int, int) error       { return nil }
func (t *zcodeTask) stop(reason string) {
	t.closeOnce.Do(func() {
		t.mu.Lock()
		t.reason = reason
		t.mu.Unlock()
		t.cleanup()
	})
}
func (t *zcodeTask) Close() error {
	select {
	case <-t.done:
	default:
		t.stop("用户停止")
	}
	return nil
}
func (t *zcodeTask) Wait(ctx context.Context) (uint32, error) {
	select {
	case <-ctx.Done():
		t.stop("任务取消")
		<-t.done
	case <-t.done:
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.reason != "" {
		return t.code, errors.New(t.reason)
	}
	return t.code, t.err
}

// Validate each event independently; unknown fields and non-JSON diagnostics remain visible.
func zcodeLogLine(line []byte) []byte {
	var event map[string]any
	if json.Unmarshal(line, &event) != nil {
		return line
	}
	redactZCodeEvent(event)
	data, err := json.Marshal(event)
	if err != nil {
		return line
	}
	return data
}
func redactZCodeEvent(v any) {
	switch x := v.(type) {
	case map[string]any:
		for k, value := range x {
			key := strings.ToLower(k)
			if key == "authorization" || key == "apikey" || key == "api_key" || key == "access_token" || key == "refresh_token" {
				x[k] = "[redacted]"
			} else {
				redactZCodeEvent(value)
			}
		}
	case []any:
		for _, value := range x {
			redactZCodeEvent(value)
		}
	}
}

// Each stream has its own bounded framing buffer; pipe output is serialized by io.Pipe.
type zcodeLogWriter struct {
	target  io.Writer
	pending []byte
}

func (w *zcodeLogWriter) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		end := bytes.IndexByte(p, '\n')
		take := len(p)
		if end >= 0 {
			take = end + 1
		}
		if len(w.pending)+take > 64*1024 {
			w.pending = nil
			if _, err := io.WriteString(w.target, "[ZCode 日志行过长，已截断]\r\n"); err != nil {
				return 0, err
			}
			p = p[take:]
			continue
		}
		w.pending = append(w.pending, p[:take]...)
		p = p[take:]
		if end >= 0 {
			if err := w.flush(); err != nil {
				return 0, err
			}
		}
	}
	return n, nil
}
func (w *zcodeLogWriter) flush() error {
	if len(w.pending) == 0 {
		return nil
	}
	line := append(zcodeLogLine(bytes.TrimSpace(w.pending)), '\r', '\n')
	w.pending = nil
	_, err := w.target.Write(line)
	return err
}
