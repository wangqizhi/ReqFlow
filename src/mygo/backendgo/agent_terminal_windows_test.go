//go:build windows

package backendgo

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Exercise the real ConPTY + PowerShell bridge with a local CLI fixture. This
// never contacts Codex or pi and starts no other Agent against the repository.
func runInteractiveAgentTerminal(t *testing.T, agent string, wantArgs []string, batch bool) {
	root, bin := t.TempDir(), t.TempDir()
	script := `[Console]::WriteLine('cwd:'+(Get-Location).Path)
[Console]::WriteLine('args:'+($args -join '|'))
$file=$args[-1].Substring($args[-1].IndexOf([char]0xff1a)+1)
[Console]::WriteLine('task:'+ [IO.File]::ReadAllText($file,[Text.Encoding]::UTF8))
$value=Read-Host 'message'
[Console]::WriteLine('reply:'+$value)
`
	if err := os.WriteFile(filepath.Join(bin, agent+".ps1"), []byte(script), 0600); err != nil {
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
	if _, err := b.desktopAgent("agent:start", args); err == nil {
		t.Fatal("disabled lab allowed")
	}
	if err := desktopAtomicJSON(filepath.Join(b.DataDir, "local-agents.json"), []any{"codex", "pi"}); err != nil {
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

func TestInteractiveBatchAgentTerminal(t *testing.T) {
	for _, agent := range []string{"codex", "pi"} {
		t.Run(agent, func(t *testing.T) { runInteractiveAgentTerminal(t, agent, nil, true) })
	}
}
