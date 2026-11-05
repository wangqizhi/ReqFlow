package backendgo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestPublishCancellationKillsScriptTree(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.17.4")
	root := t.TempDir()
	// The wrapper waits on its child, just like a build/publish launcher.
	child := filepath.Join(root, "child.ps1")
	if err := os.WriteFile(child, []byte("[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'child.pid'), [string]$PID); Start-Sleep -Seconds 60"), 0600); err != nil {
		t.Fatal(err)
	}
	script := "& powershell.exe -NoProfile -File (Join-Path $PSScriptRoot 'child.ps1')"
	if err := os.WriteFile(filepath.Join(root, "publish.ps1"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	id := coreUUID()
	desktopTestCall(t, b, "publish:prepare", root, "publish.ps1", id)
	done := make(chan map[string]any, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go func() {
		value, _ := b.Invoke(ctx, "publish:run", []any{root, "publish.ps1", id})
		done <- desktopMap(value)
	}()
	var pid int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ := os.ReadFile(filepath.Join(root, "child.pid"))
		pid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		if pid > 0 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if pid == 0 {
		t.Fatal("script child did not start")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	desktopTestCall(t, b, "publish:stop", id)
	select {
	case result := <-done:
		if result["ok"] != false || result["error"] != "发布已中断" {
			t.Fatal(result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancel did not stop publish promptly")
	}
	if state, err := windows.WaitForSingleObject(handle, 3000); err != nil || state != windows.WAIT_OBJECT_0 {
		t.Fatal(fmt.Sprintf("script child survived cancellation: %d, %v", state, err))
	}
	if desktopTestCall(t, b, "publish:output", id, 0)["done"] != true {
		t.Fatal("cancelled terminal did not finish")
	}
	// Repeated stops are harmless and cannot change the terminal result.
	desktopTestCall(t, b, "publish:stop", id)
}

func TestPublishCancelledBeforeScriptStarts(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.17.4")
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "publish.ps1"), []byte("Set-Content (Join-Path $PSScriptRoot 'unexpected') 'ran'"), 0600); err != nil {
		t.Fatal(err)
	}
	id := coreUUID()
	desktopTestCall(t, b, "publish:prepare", root, "publish.ps1", id)
	desktopTestCall(t, b, "publish:stop", id)
	value, err := b.Invoke(context.Background(), "publish:run", []any{root, "publish.ps1", id})
	if err != nil || desktopMap(value)["ok"] != false || desktopMap(value)["error"] != "发布已中断" {
		t.Fatal(value, err)
	}
	if _, err := os.Stat(filepath.Join(root, "unexpected")); !os.IsNotExist(err) {
		t.Fatal("cancelled script was executed")
	}
}
