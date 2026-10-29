package backendgo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// prepareUpdateFixture puts the backend into the downloaded/ready state with a
// valid installer file and records installer/window native calls.
func prepareUpdateFixture(t *testing.T, b *Backend) chan []any {
	t.Helper()
	content := []byte("MZreqflow-update-fixture")
	directory := filepath.Join(b.DataDir, "updates")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	installer := filepath.Join(directory, "ReqFlow-Setup-9.9.9.exe")
	if err := os.WriteFile(installer, content, 0600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	hash := hex.EncodeToString(sum[:])
	b.desktopInstaller = installer
	b.desktopExpectedHash = hash
	b.desktopAsset = map[string]any{
		"name":                 "ReqFlow-Setup-9.9.9.exe",
		"browser_download_url": "https://github.com/wangqizhi/ReqFlow/releases/download/v9.9.9/ReqFlow-Setup-9.9.9.exe",
		"size":                 len(content),
	}
	b.desktopUpdateSet(map[string]any{"phase": "ready", "version": "9.9.9", "progress": 100})
	calls := make(chan []any, 8)
	b.Native = func(method string, args []any) (any, error) {
		calls <- append([]any{method}, args...)
		return "", nil
	}
	return calls
}

func claimUpdateTask(t *testing.T, b *Backend) {
	t.Helper()
	r := coreTestGet(t, b.Workspace)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	r, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": pid, "body": "更新期间执行中"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	item := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["items"])[0])
	r, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": pid, "ids": []any{item["id"]}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	batch := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["batches"])[0])
	claims := []any{map[string]any{"id": item["id"], "version": item["version"], "batchId": batch["id"], "hash": batch["hash"]}}
	if _, err := b.Workspace.Mutate(map[string]any{"op": "executionClaim", "project": pid, "claims": claims, "run": coreUUID(), "client": "codex"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateInstallConfirmsRunningTasksOnce(t *testing.T) {
	dir := t.TempDir()
	b := NewBackend(dir, dir, "9.9.8")
	calls := prepareUpdateFixture(t, b)
	claimUpdateTask(t, b)

	result, err := b.desktopUpdater(context.Background(), "update:install", []any{})
	if err != nil {
		t.Fatal(err)
	}
	state := desktopMap(result)
	if desktopString(state["phase"]) != "ready" || coreNum(state["confirmTasks"]) != 1 {
		t.Fatalf("install must ask for confirmation first: %v", state)
	}
	if b.UpdateInstallConfirmed() {
		t.Fatal("asking for confirmation must not mark the flow confirmed")
	}
	select {
	case call := <-calls:
		t.Fatalf("installer must not start before confirmation: %v", call)
	default:
	}

	result, err = b.desktopUpdater(context.Background(), "update:install", []any{true})
	if err != nil {
		t.Fatal(err)
	}
	state = desktopMap(result)
	if desktopString(state["phase"]) != "installing" || desktopString(state["step"]) == "" {
		t.Fatalf("confirmed install must enter installing state: %v", state)
	}
	if !b.UpdateInstallConfirmed() {
		t.Fatal("confirmation must be remembered for this update flow")
	}
	launched := false
	closed := false
	deadline := time.After(2 * time.Second)
	for !launched || !closed {
		select {
		case call := <-calls:
			method := desktopString(call[0])
			if method == "installer.launch" {
				if len(call) < 3 || desktopString(call[2]) != "/REQFLOW_UPDATE_CONFIRMED=1" {
					t.Fatalf("installer must receive confirmation switch: %v", call)
				}
				launched = true
			}
			if method == "window.close" {
				closed = true
			}
		case <-deadline:
			t.Fatalf("install flow incomplete: launched=%v closed=%v", launched, closed)
		}
	}

	// REQ-285：同一更新流程内再次进入安装不再检测任务或弹窗。
	b.desktopUpdateSet(map[string]any{"phase": "ready", "version": "9.9.9", "progress": 100})
	result, err = b.desktopUpdater(context.Background(), "update:install", []any{})
	if err != nil {
		t.Fatal(err)
	}
	state = desktopMap(result)
	if desktopString(state["phase"]) != "installing" || state["confirmTasks"] != nil {
		t.Fatalf("confirmed update flow must not prompt again: %v", state)
	}
}

func TestUpdateInstallWithoutRunningTasksSkipsConfirmation(t *testing.T) {
	dir := t.TempDir()
	b := NewBackend(dir, dir, "9.9.8")
	calls := prepareUpdateFixture(t, b)
	result, err := b.desktopUpdater(context.Background(), "update:install", []any{})
	if err != nil {
		t.Fatal(err)
	}
	state := desktopMap(result)
	if desktopString(state["phase"]) != "installing" || state["confirmTasks"] != nil {
		t.Fatalf("idle tasks must install without confirmation: %v", state)
	}
	if !b.UpdateInstallConfirmed() {
		t.Fatal("install without running tasks must remember the flow confirmation")
	}
	select {
	case call := <-calls:
		if desktopString(call[0]) != "installer.launch" {
			t.Fatalf("unexpected native call: %v", call)
		}
	case <-time.After(time.Second):
		t.Fatal("installer was not launched")
	}
}

func TestUpdateDownloadStartsNewFlowAndClearsConfirmation(t *testing.T) {
	dir := t.TempDir()
	b := NewBackend(dir, dir, "9.9.8")
	prepareUpdateFixture(t, b)
	b.setUpdateInstallConfirmed(true)
	b.desktopUpdateSet(map[string]any{"phase": "available", "version": "9.9.9"})
	result, err := b.desktopUpdater(context.Background(), "update:download", nil)
	if err != nil {
		t.Fatal(err)
	}
	if state := desktopMap(result); desktopString(state["phase"]) != "ready" {
		t.Fatalf("local verified installer must be reused: %v", state)
	}
	if b.UpdateInstallConfirmed() {
		t.Fatal("starting a new download flow must clear the previous confirmation")
	}
}
