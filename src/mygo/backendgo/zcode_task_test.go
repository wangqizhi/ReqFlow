//go:build windows

package backendgo

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestZCodeTaskFileAndLifecycle(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node fixture unavailable")
	}
	root := t.TempDir()
	file := filepath.Join(root, "official fixture 中文.cjs")
	script := `const fs=require('node:fs'); const a=process.argv.slice(2);
if(a.includes('--version')) { console.log('0.17.0'); process.exit(0); }
if(a[a.indexOf('--prompt')+1]==='/help') process.exit(0);
const file=a[a.indexOf('--attach')+1];
console.log(JSON.stringify({type:'result',sessionId:'sess_fixture',response:fs.readFileSync(file,'utf8'),args:a,api_key:'secret'}));`
	if err := os.WriteFile(file, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REQFLOW_ZCODE_CLI", file)
	if probeZCode()["installed"] != true {
		t.Fatal("custom bundle not detected")
	}
	prompt := "仅处理 ID selected-id\n中文 \" ' $() & ` <other>" + strings.Repeat("任务", 8000)
	task, err := startZCodeTask(root, prompt)
	if err != nil {
		t.Fatal(err)
	}
	defer task.Close()
	output, err := io.ReadAll(task)
	if err != nil {
		t.Fatal(err)
	}
	code, err := task.Wait(context.Background())
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	if bytes.Contains(output, []byte("secret")) || !bytes.Contains(output, []byte("selected-id")) || !bytes.Contains(output, []byte("--attach")) {
		t.Fatal("lost task or exposed credential")
	}
	z := task.(*zcodeTask)
	if _, err := os.Stat(z.file); !os.IsNotExist(err) {
		t.Fatal("task file leaked")
	}
	if _, err := task.Write([]byte("unsafe")); err == nil {
		t.Fatal("headless accepted input")
	}
}

func TestZCodeMissingAndArguments(t *testing.T) {
	t.Setenv("REQFLOW_ZCODE_CLI", filepath.Join(t.TempDir(), "missing.cjs"))
	if probeZCode()["installed"] != false {
		t.Fatal("missing custom entry silently replaced")
	}
	args := zcodeTaskArgs([]string{"bundle.cjs"}, `C:\中文 path`, `C:\task ' &.txt`)
	joined := strings.Join(args, "|")
	if !strings.Contains(joined, "--mode|build") || !strings.Contains(joined, "--output-format|stream-json") || strings.Contains(joined, "--print") {
		t.Fatal(args)
	}
}

func TestZCodeLogFraming(t *testing.T) {
	var out bytes.Buffer
	w := &zcodeLogWriter{target: &out}
	for _, fragment := range []string{`{"type":"unknown","authorization":"`, "secret\"}\nplain error\n", strings.Repeat("x", 70000) + "\n", `{"type":"result"}`} {
		if _, err := w.Write([]byte(fragment)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.flush(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "secret") || !strings.Contains(out.String(), "plain error") || !strings.Contains(out.String(), "result") || out.Len() > 1000 {
		t.Fatal("framing/redaction failed")
	}
}

func TestZCodeStop(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node fixture unavailable")
	}
	file := filepath.Join(t.TempDir(), "wait.cjs")
	os.WriteFile(file, []byte(`if(process.argv.includes('/help'))process.exit(0); setInterval(()=>{},1000);`), 0600)
	t.Setenv("REQFLOW_ZCODE_CLI", file)
	task, err := startZCodeTask(t.TempDir(), "selected only")
	if err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, task)
	task.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := task.Wait(ctx); err == nil {
		t.Fatal("cancellation reported success")
	}
}

func TestZCodeAssignmentScopeAndState(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node fixture unavailable")
	}
	root := t.TempDir()
	file := filepath.Join(t.TempDir(), "zcode.cjs")
	script := `const fs=require('node:fs'); const a=process.argv.slice(2); if(a.includes('/help'))process.exit(0); console.log(fs.readFileSync(a[a.indexOf('--attach')+1],'utf8'));`
	if err := os.WriteFile(file, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REQFLOW_ZCODE_CLI", file)
	b := NewBackend(t.TempDir(), root, "test")
	state := coreTestGet(t, b.Workspace)
	pid := coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"]
	mutate := func(a map[string]any) map[string]any {
		a["project"] = pid
		result, err := b.Workspace.Mutate(a, nil)
		if err != nil {
			t.Fatal(err)
		}
		return coreMap(coreList(coreMap(result["state"])["projects"])[0])
	}
	mutate(map[string]any{"op": "projectDir", "dir": root})
	p := mutate(map[string]any{"op": "item", "body": "selected-zcode-task"})
	id := coreMap(coreList(p["items"])[0])["id"]
	mutate(map[string]any{"op": "item", "body": "excluded-zcode-task"})
	mutate(map[string]any{"op": "generate", "ids": []any{id}})
	args := []any{pid, "zcode", []any{id}}
	if _, err := b.desktopAgent("agent:start", args); err == nil {
		t.Fatal("disabled ZCode started")
	}
	if _, err := b.invokeAgents("agents:save", []any{[]any{"zcode"}}); err != nil {
		t.Fatal(err)
	}
	result, err := b.desktopAgent("agent:start", args)
	if err != nil {
		t.Fatal(err)
	}
	run := b.agentRuns[coreString(desktopMap(result)["runId"])]
	defer run.close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		run.mu.Lock()
		done := run.done
		output := string(run.output)
		run.mu.Unlock()
		if done {
			if !strings.Contains(output, "selected-zcode-task") || strings.Contains(output, "excluded-zcode-task") {
				t.Fatal(output)
			}
			p, err := b.desktopProject(coreString(pid))
			if err != nil {
				t.Fatal(err)
			}
			item := coreFind(coreList(p["items"]), id)
			if ActiveAIExecution(item) != nil || item["status"] == "pending_verification" {
				t.Fatal("process startup/exit fabricated claim or completion")
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("ZCode assignment did not exit")
}

func TestZCodeExitCleansBackgroundChild(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node fixture unavailable")
	}
	file := filepath.Join(t.TempDir(), "child.cjs")
	script := `if(process.argv.includes('/help'))process.exit(0); const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); c.unref(); console.log('parent-exit');`
	if err := os.WriteFile(file, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REQFLOW_ZCODE_CLI", file)
	task, err := startZCodeTask(t.TempDir(), "selected")
	if err != nil {
		t.Fatal(err)
	}
	defer task.Close()
	drained := make(chan struct{})
	go func() { io.Copy(io.Discard, task); close(drained) }()
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		task.Close()
		t.Fatal("background child retained stdout after parent exit")
	}
	if code, err := task.Wait(context.Background()); err != nil || code != 0 {
		t.Fatal(code, err)
	}
}
