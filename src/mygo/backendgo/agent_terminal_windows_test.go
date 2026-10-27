//go:build windows

package backendgo

import (
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Exercise the real ConPTY + PowerShell bridge with a local CLI fixture. This
// never contacts Codex or pi and starts no other Agent against the repository.
func runInteractiveAgentTerminal(t *testing.T, agent string, wantArgs []string, batch bool) {
	root, bin := t.TempDir(), t.TempDir()
	// REQ-216：Agent 标识与命令行不一定相同（claude-code → claude），
	// fixture 以实际命令名注册本地脚本，避免误用本机已安装的同名 CLI。
	command := agent
	if agent == "claude-code" {
		command = "claude"
	}
	script := `[Console]::WriteLine('cwd:'+(Get-Location).Path)
[Console]::WriteLine('args:'+($args -join '|'))
$file=$args[-1].Substring($args[-1].IndexOf([char]0xff1a)+1)
[Console]::WriteLine('task:'+ [IO.File]::ReadAllText($file,[Text.Encoding]::UTF8))
$value=Read-Host 'message'
[Console]::WriteLine('reply:'+$value)
`
	if err := os.WriteFile(filepath.Join(bin, command+".ps1"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	b := NewBackend(t.TempDir(), root, "test")
	state := coreTestGet(t, b.Workspace)
	pid := coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"]
	mutate := func(a map[string]any) map[string]any {
		a["project"] = pid
		r, e := b.Workspace.Mutate(a, nil)
		if e != nil {
			t.Fatal(e)
		}
		return coreMap(coreList(coreMap(r["state"])["projects"])[0])
	}
	mutate(map[string]any{"op": "projectDir", "dir": root})
	p := mutate(map[string]any{"op": "item", "body": "selected-task 中文引号 \" $()", "title": "selected"})
	item := coreMap(coreList(p["items"])[0])
	mutate(map[string]any{"op": "item", "body": "excluded-task", "title": "other"})
	mutate(map[string]any{"op": "generate", "ids": []any{item["id"]}})
	ids := []any{item["id"]}
	if batch {
		p = mutate(map[string]any{"op": "item", "body": "second-selected-task", "title": "second"})
		for _, value := range coreList(p["items"]) {
			second := coreMap(value)
			if coreString(second["title"]) == "second" {
				ids = append(ids, second["id"])
			}
		}
		mutate(map[string]any{"op": "generate", "ids": ids})
	}
	args := []any{pid, agent, ids}
	if _, err := b.desktopAgent("agent:start", args); agent != "codex" && err == nil {
		t.Fatal("disabled lab allowed")
	}
	if err := desktopAtomicJSON(filepath.Join(b.DataDir, "local-agents.json"), []any{"codex", "pi", "claude-code", "dsh"}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.desktopAgent("agent:start", []any{pid, "opencode", []any{item["id"]}}); err == nil {
		t.Fatal("unsupported agent accepted")
	}
	if _, err := b.desktopAgent("agent:start", []any{pid, agent, []any{item["id"], item["id"]}}); err == nil {
		t.Fatal("duplicate requirement accepted")
	}
	value, err := b.desktopAgent("agent:start", args)
	if err != nil {
		t.Fatal(err)
	}
	id := coreString(desktopMap(value)["runId"])
	defer b.agentRuns[id].close()
	other := "pi"
	if agent == "pi" {
		other = "codex"
	}
	if _, err := b.desktopAgent("agent:start", []any{pid, other, ids}); err == nil {
		t.Fatal("same requirements reused across different agents")
	}
	again, err := b.desktopAgent("agent:start", args)
	if err != nil || desktopMap(again)["runId"] != id {
		t.Fatal("duplicate launch", again, err)
	}
	if _, err = b.desktopAgent("agent:resize", []any{id, 100, 28}); err != nil {
		t.Fatal(err)
	}
	read := func() (string, bool, int64) {
		value, err := b.desktopAgent("agent:read", []any{id, 0})
		if err != nil {
			t.Fatal(err)
		}
		m := desktopMap(value)
		raw, err := base64.StdEncoding.DecodeString(coreString(m["data"]))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw), coreTruthy(m["done"]), desktopInt(m["idleMs"])
	}
	deadline := time.Now().Add(12 * time.Second)
	output := ""
	for time.Now().Before(deadline) {
		output, _, _ = read()
		if strings.Contains(output, "message") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, want := range append([]string{root, "selected-task"}, wantArgs...) {
		if !strings.Contains(output, want) {
			t.Fatalf("output missing %q:\n%s", want, output)
		}
	}
	if batch && !strings.Contains(output, "second-selected-task") {
		t.Fatal("combined prompt missing second requirement", output)
	}
	if strings.Contains(output, "excluded-task") {
		t.Fatal(output)
	}
	if status, err := b.desktopAgent("agent:status", []any{id}); err != nil || desktopInt(desktopMap(status)["idleMs"]) < 0 {
		t.Fatal("agent status missing", status, err)
	}
	if _, err = b.desktopAgent("agent:write", []any{id, "hello-terminal\r"}); err != nil {
		t.Fatal(err)
	}
	for time.Now().Before(deadline) {
		var done bool
		output, done, _ = read()
		if done && strings.Contains(output, "reply:hello-terminal") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("interactive reply/exit missing", output)
}

func TestInteractiveCodexTerminal(t *testing.T) {
	// REQ-205：指派 Codex 以完全控制模式启动，绕过沙箱权限限制。
	runInteractiveAgentTerminal(t, "codex", []string{"--no-alt-screen", "--sandbox", "danger-full-access"}, false)
}

func TestInteractivePiTerminal(t *testing.T) {
	// REQ-206：pi 与 Codex 使用同样的交互终端指派；--approve 自动信任项目目录，
	// 启动不再停在文件夹信任确认上。
	runInteractiveAgentTerminal(t, "pi", []string{"--approve"}, false)
}

func TestInteractiveClaudeCodeTerminal(t *testing.T) {
	// REQ-216：Claude Code 以 --dangerously-skip-permissions 启动，
	// 与 Codex 一样在项目目录保持完全控制，不会突然弹权限确认。
	runInteractiveAgentTerminal(t, "claude-code", []string{"--dangerously-skip-permissions"}, false)
}

func TestDshChatInvocation(t *testing.T) {
	// REQ-216 后续：DeepSeek Harness 没有自带 TUI，由嵌入的聊天客户端驱动 headless
	// profile；任务正文走临时文件，命令行只保留固定参数与路径。
	command := dshChatInvocation(`C:\Program Files\nodejs\node.exe`, `C:\Temp\reqflow-dsh\dsh-chat.mjs`, `C:\Temp\reqflow-dsh-task-1.txt`, `C:\work\需求 项目`, `演示"项目`, dshPermissionMode())
	for _, want := range []string{`node.exe`, `dsh-chat.mjs`, `--task-file`, `reqflow-dsh-task-1.txt`, `--cwd`, `--profile headless`, `--permission`, `danger-full-access`, `--label`, `需求 项目`} {
		if !strings.Contains(command, want) {
			t.Fatalf("invocation missing %q: %s", want, command)
		}
	}
	if strings.Contains(command, "selected-task") {
		t.Fatalf("task text leaked into the command line: %s", command)
	}
	if !strings.Contains(string(dshChatScript), "--patch") || !strings.Contains(string(dshRuntimeScript), "agent.followup") {
		t.Fatal("embedded client must keep the headless runtime and agent alive")
	}
	if !strings.Contains(string(dshChatScript), "DSH_PERMISSION_MODE") {
		t.Fatal("embedded client must forward the permission mode to dsh")
	}
}

func TestDshPermissionMode(t *testing.T) {
	// ReqFlow 启动的 DSH 默认完全访问，与 Codex 的 danger-full-access 对齐。
	t.Setenv("REQFLOW_DSH_PERMISSION_MODE", "")
	if got := dshPermissionMode(); got != "danger-full-access" {
		t.Fatalf("default permission = %q", got)
	}
	t.Setenv("REQFLOW_DSH_PERMISSION_MODE", "workspace-write")
	if got := dshPermissionMode(); got != "workspace-write" {
		t.Fatalf("override permission = %q", got)
	}
}

// TestDshChatPTY 端到端驱动真实的 ConPTY + 嵌入客户端 + 本地假 dsh，
// 校验首轮任务执行后还能在同一终端继续对话（真实模型调用不在测试范围内）。
func TestDshChatPTY(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	root := t.TempDir()
	fake := filepath.Join(root, "fake-dsh.mjs")
	script := `import process from 'node:process';
import { createInterface } from 'node:readline';
let round = 0, session = 1;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
out({ type: 'ready' });
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'prompt') return;
  if (request.fresh) { session++; round = 0; }
  out({ type: 'session', sessionId: 'session-test-' + session });
  out({ type: 'text', text: '权限：' + (process.env.DSH_PERMISSION_MODE || '') });
  out({ type: 'text', text: (++round > 1 ? '继续：' : '开始：') + request.task.trim() });
  out({ type: 'text', text: '实例轮次：' + round + '，会话：' + session });
  out({ type: 'final', text: '' });
});
`
	if err := os.WriteFile(fake, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REQFLOW_DSH_BIN", fake)
	pty, err := startDshChatPTY(root, "第一条任务", "测试项目")
	if err != nil {
		t.Fatal(err)
	}
	defer pty.Close()
	var mu sync.Mutex
	output := ""
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, err := pty.Read(buffer)
			if n > 0 {
				mu.Lock()
				output += string(buffer[:n])
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	waitFor := func(want string) {
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			seen := strings.Contains(output, want)
			mu.Unlock()
			if seen {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		mu.Lock()
		captured := output
		mu.Unlock()
		t.Fatalf("output missing %q:\n%s", want, captured)
	}
	waitFor("权限：danger-full-access")
	waitFor("开始：第一条任务")
	if _, err := pty.Write([]byte("第二条任务\r")); err != nil {
		t.Fatal(err)
	}
	waitFor("继续：第二条任务")
	waitFor("实例轮次：2，会话：1")
	if _, err := pty.Write([]byte("/new\r第三条任务\r")); err != nil {
		t.Fatal(err)
	}
	waitFor("开始：第三条任务")
	waitFor("实例轮次：1，会话：2")
	if err := queueDshPrompt(&agentRun{pty: pty}, "追加指派第一行\n追加指派第二行"); err != nil {
		t.Fatal(err)
	}
	waitFor("继续：追加指派第一行")
	waitFor("追加指派第二行")
	waitFor("实例轮次：2，会话：2")
	// Reassign after completion through the real desktop API, preserving the PTY.
	b := NewBackend(t.TempDir(), root, "test")
	state := coreTestGet(t, b.Workspace)
	pid := coreString(coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"])
	mutate := func(action map[string]any) map[string]any {
		action["project"] = pid
		result, err := b.Workspace.Mutate(action, nil)
		if err != nil {
			t.Fatal(err)
		}
		return coreMap(coreList(coreMap(result["state"])["projects"])[0])
	}
	mutate(map[string]any{"op": "projectDir", "dir": root})
	p := mutate(map[string]any{"op": "item", "body": "上一批"})
	old := coreString(coreMap(coreList(p["items"])[0])["id"])
	mutate(map[string]any{"op": "generate", "ids": []any{old}})
	mutate(map[string]any{"op": "complete", "id": old, "summary": "已完成"})
	p = mutate(map[string]any{"op": "item", "body": "复用指派任务"})
	var next string
	for _, value := range coreList(p["items"]) {
		item := coreMap(value)
		if coreString(item["body"]) == "复用指派任务" {
			next = coreString(item["id"])
		}
	}
	mutate(map[string]any{"op": "generate", "ids": []any{next}})
	if err := desktopAtomicJSON(filepath.Join(b.DataDir, "local-agents.json"), []any{"dsh"}); err != nil {
		t.Fatal(err)
	}
	b.agentRuns = map[string]*agentRun{"existing-dsh": {pty: pty, project: pid, agent: "dsh", items: []string{old}, assignments: map[string]agentAssignment{old: {version: 1}}}}
	result, err := b.desktopAgent("agent:start", []any{pid, "dsh", []any{next}})
	if err != nil {
		t.Fatal(err)
	}
	if desktopMap(result)["runId"] != "existing-dsh" || len(b.agentRuns) != 1 {
		t.Fatal("reassignment restarted the runtime", result)
	}
	waitFor("复用指派任务")
	waitFor("实例轮次：3，会话：2")
	if dshAssignmentsFinished(p, []string{next}) {
		t.Fatal("unfinished assignment allowed another batch")
	}
}

func TestInteractiveBatchAgentTerminal(t *testing.T) {
	for _, agent := range []string{"codex", "pi"} {
		t.Run(agent, func(t *testing.T) { runInteractiveAgentTerminal(t, agent, nil, true) })
	}
}

func TestProjectShellStartsInProjectDirectory(t *testing.T) {
	root := t.TempDir()
	b := NewBackend(t.TempDir(), root, "test")
	state := coreTestGet(t, b.Workspace)
	pid := coreString(coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"])
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": pid, "dir": root}, nil); err != nil {
		t.Fatal(err)
	}
	result := desktopTestCall(t, b, "agent:shell:start", pid)
	id := coreString(result["runId"])
	if id == "" {
		t.Fatal(result)
	}
	defer desktopTestCall(t, b, "agent:stop", id)
	desktopTestCall(t, b, "agent:write", id, "[Console]::WriteLine('SHELL-CWD:'+(Get-Location).Path)\r")
	deadline := time.Now().Add(15 * time.Second)
	var output string
	var offset int64
	for time.Now().Before(deadline) {
		response := desktopTestCall(t, b, "agent:read", id, offset)
		raw, err := base64.StdEncoding.DecodeString(coreString(response["data"]))
		if err != nil {
			t.Fatal(err)
		}
		output += string(raw)
		offset = coreNum(response["offset"])
		if strings.Contains(output, "SHELL-CWD:"+root) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("shell did not report project directory: %s", output)
}
