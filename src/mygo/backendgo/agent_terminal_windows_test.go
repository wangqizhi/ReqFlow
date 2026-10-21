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
// never contacts Codex or starts another Agent against the user's repository.
func TestInteractiveAgentTerminal(t *testing.T) {
	root, bin := t.TempDir(), t.TempDir()
	script := `[Console]::WriteLine('cwd:'+(Get-Location).Path)
[Console]::WriteLine('args:'+($args -join '|'))
$file=$args[-1].Substring($args[-1].IndexOf([char]0xff1a)+1)
[Console]::WriteLine('task:'+ [IO.File]::ReadAllText($file,[Text.Encoding]::UTF8))
$value=Read-Host 'message'
[Console]::WriteLine('reply:'+$value)
`
	if err := os.WriteFile(filepath.Join(bin, "codex.ps1"), []byte(script), 0600); err != nil {
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
	args := []any{pid, "codex", []any{item["id"]}}
	if _, err := b.desktopAgent("agent:start", args); err == nil {
		t.Fatal("disabled lab allowed")
	}
	if err := desktopAtomicJSON(filepath.Join(b.DataDir, "local-agents.json"), []any{"codex"}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.desktopAgent("agent:start", []any{pid, "codex", []any{item["id"], item["id"]}}); err == nil {
		t.Fatal("batch experiment accepted")
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
	read := func() (string, bool) {
		value, err := b.desktopAgent("agent:read", []any{id, 0})
		if err != nil {
			t.Fatal(err)
		}
		m := desktopMap(value)
		raw, err := base64.StdEncoding.DecodeString(coreString(m["data"]))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw), coreTruthy(m["done"])
	}
	deadline := time.Now().Add(12 * time.Second)
	output := ""
	for time.Now().Before(deadline) {
		output, _ = read()
		if strings.Contains(output, "message") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(output, root) || !strings.Contains(output, "selected-task") || strings.Contains(output, "excluded-task") || !strings.Contains(output, "--no-alt-screen") {
		t.Fatal(output)
	}
	if _, err = b.desktopAgent("agent:write", []any{id, "hello-terminal\r"}); err != nil {
		t.Fatal(err)
	}
	for time.Now().Before(deadline) {
		var done bool
		output, done = read()
		if done && strings.Contains(output, "reply:hello-terminal") {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("interactive reply/exit missing", output)
}
