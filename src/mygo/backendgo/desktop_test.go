package backendgo

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func desktopTestCall(t *testing.T, b *Backend, channel string, args ...any) map[string]any {
	t.Helper()
	value, e := b.Invoke(context.Background(), channel, args)
	if e != nil {
		t.Fatal(e)
	}
	m := desktopMap(value)
	if m["ok"] == false {
		t.Fatalf("%s: %v", channel, m["error"])
	}
	return m
}
func TestPublishResultRequestsAudibleNotification(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	for _, success := range []bool{true, false} {
		called := false
		b.Native = func(method string, args []any) (any, error) {
			called = true
			if method != "notification" || desktopMap(args[0])["silent"] != false {
				t.Fatal(method, args)
			}
			return nil, nil
		}
		desktopTestCall(t, b, "publish:notice", map[string]any{"ok": success, "project": "通知测试"})
		if !called {
			t.Fatal("notification missing")
		}
	}
}

func TestDesktopFilesNativeAndBounds(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.0.0")
	root, outside := t.TempDir(), t.TempDir()
	file := filepath.Join(root, "中文 &文档.txt")
	if e := os.WriteFile(file, []byte("original"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0600); e != nil {
		t.Fatal(e)
	}
	result := desktopTestCall(t, b, "fs:read", root, filepath.Base(file))
	if result["content"] != "original" {
		t.Fatal("read failed")
	}
	desktopTestCall(t, b, "fs:write", root, filepath.Base(file), "updated")
	raw, _ := os.ReadFile(file)
	if string(raw) != "updated" {
		t.Fatal("write failed")
	}
	_, e := DesktopSafePath(root, filepath.Join("..", filepath.Base(outside), "secret.txt"))
	if e == nil {
		t.Fatal("path traversal accepted")
	}
	link := filepath.Join(root, "junction")
	cmd := desktopCommand(context.Background(), "cmd.exe", []string{"/d", "/c", "mklink", "/J", link, outside}, root)
	if output, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("junction fixture: %s %v", output, e)
	}
	if _, e := DesktopSafePath(root, "junction/secret.txt"); e == nil {
		t.Fatal("junction escape accepted")
	}
	b.Native = func(method string, args []any) (any, error) {
		if method == "openDialog" {
			return map[string]any{"canceled": false, "filePaths": []string{root}}, nil
		}
		return nil, nil
	}
	if desktopTestCall(t, b, "dir:pick")["dir"] != root {
		t.Fatal("direct Go native []string result lost")
	}
	pixel := []byte{1, 2, 3}
	os.WriteFile(filepath.Join(root, "test.png"), pixel, 0600)
	image := desktopTestCall(t, b, "fs:readImage", root, "test.png")
	if image["dataUrl"] != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(pixel) {
		t.Fatal("image mismatch")
	}
	binary := filepath.Join(root, "binary")
	os.WriteFile(binary, []byte{0, 1}, 0600)
	value, _ := b.Invoke(context.Background(), "fs:read", []any{root, "binary"})
	if desktopMap(value)["ok"] != false {
		t.Fatal("binary text accepted")
	}
	info := desktopTestCall(t, b, "app:info")
	if info["backend"] != "go" || info["version"] != "2.0.0" {
		t.Fatal("Go runtime identification missing")
	}
}
func TestDesktopGitUnicodeAndLiteralArguments(t *testing.T) {
	if _, e := exec.LookPath("git"); e != nil {
		t.Skip("Git not installed")
	}
	b := NewBackend(t.TempDir(), t.TempDir(), "2.0.0")
	root := t.TempDir()
	desktopTestCall(t, b, "git:init", root)
	run := func(args ...string) {
		t.Helper()
		if out, e := desktopCommand(context.Background(), "git", args, root).CombinedOutput(); e != nil {
			t.Fatalf("git %v: %s %v", args, out, e)
		}
	}
	run("config", "user.name", "ReqFlow Test")
	run("config", "user.email", "test@reqflow.local")
	name := "中文 & literal.txt"
	os.WriteFile(filepath.Join(root, name), []byte("one"), 0600)
	status := desktopTestCall(t, b, "git:status", root)
	changes := desktopList(status["changes"])
	if len(changes) != 1 || desktopMap(changes[0])["path"] != name {
		t.Fatalf("literal filename lost: %#v", status)
	}
	desktopTestCall(t, b, "git:stage", root, "stage", []any{name})
	desktopTestCall(t, b, "git:commit", root, "feat: preserve Unicode & arguments")
	desktopTestCall(t, b, "git:branchCreate", root, "feature/test")
	status = desktopTestCall(t, b, "git:status", root)
	if status["branch"] != "feature/test" || len(desktopList(status["log"])) != 1 {
		t.Fatal("branch/history differ")
	}
	os.Rename(filepath.Join(root, name), filepath.Join(root, "renamed 名称.txt"))
	desktopTestCall(t, b, "git:stage", root, "stage", []any{})
	status = desktopTestCall(t, b, "git:status", root)
	changes = desktopList(status["changes"])
	if len(changes) != 1 || desktopMap(changes[0])["path"] != "renamed 名称.txt" {
		t.Fatal("rename parser uses wrong destination")
	}
	value, _ := b.Invoke(context.Background(), "git:branchCreate", []any{root, "-bad"})
	if desktopMap(value)["ok"] != false {
		t.Fatal("bad branch accepted")
	}
	if _, e := b.desktopCheckout(root, map[string]any{}, true); e == nil || !strings.Contains(e.Error(), "未提交") {
		t.Fatal("dirty pull must leave changes intact")
	}
}
func TestDesktopPublishStreamingRedactionAndNodeDependency(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.0.0")
	root := filepath.Join(t.TempDir(), "发布 & 空格")
	os.MkdirAll(filepath.Join(root, "scripts"), 0700)
	file := filepath.Join(root, "scripts", "publish.ps1")
	script := "Write-Output '@@REQFLOW_PUBLISH {\"stage\":\"打包\",\"phase\":\"start\"}'; Write-Output 'Bearer secret-value token=hidden'; Write-Output '完成'; exit 0"
	os.WriteFile(file, []byte(script), 0600)
	detect := desktopTestCall(t, b, "publish:detect", root)
	if detect["script"] != "scripts/publish.ps1" {
		t.Fatal("publisher discovery failed")
	}
	r := desktopTestCall(t, b, "publish:run", root, "scripts/publish.ps1")
	if !strings.Contains(desktopString(r["output"]), "完成") {
		t.Fatal("publisher output lost")
	}
	logs := desktopTestCall(t, b, "publish:logs:get")
	bytes, _ := json.Marshal(logs)
	if strings.Contains(string(bytes), "secret-value") || strings.Contains(string(bytes), "token=hidden") {
		t.Fatal("publish log leaked secrets")
	}
	if !strings.Contains(string(bytes), "stage_start") || !strings.Contains(string(bytes), "complete") {
		t.Fatal("publish phases lost")
	}
	disabled := map[string]any{"enabled": false}
	desktopTestCall(t, b, "publish:logs:settings:save", disabled)
	before, _ := os.ReadFile(filepath.Join(b.DataDir, "publish-request-log.json"))
	desktopTestCall(t, b, "publish:run", root, "scripts/publish.ps1")
	after, _ := os.ReadFile(filepath.Join(b.DataDir, "publish-request-log.json"))
	if string(before) != string(after) {
		t.Fatal("disabled logger wrote entries")
	}
	t.Setenv("PATH", t.TempDir())
	if _, e := desktopPublishCommand(context.Background(), filepath.Join(root, "publish.mjs")); e == nil || !strings.Contains(e.Error(), "自身不依赖 Node") {
		t.Fatal("project Node requirement missing")
	}
}
func TestDesktopArchiveDurabilityAndInFlightReferences(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.0.0")
	r, e := b.Workspace.Get()
	if e != nil {
		t.Fatal(e)
	}
	state := desktopMap(r["state"])
	p := desktopMap(desktopList(state["projects"])[0])
	p["items"] = []any{map[string]any{"id": "archived", "status": "archived", "history": []any{map[string]any{"event": "归档", "time": "2020-01-01T00:00:00Z"}}}, map[string]any{"id": "live", "status": "in_progress", "history": []any{}}}
	p["batches"] = []any{map[string]any{"id": "old", "time": "2019-01-01T00:00:00Z", "items": []any{map[string]any{"id": "archived"}}}, map[string]any{"id": "flight", "time": "2019-01-01T00:00:00Z", "items": []any{map[string]any{"id": "live"}}}}
	if _, e = b.Workspace.WriteState(state, desktopInt(r["version"])); e != nil {
		t.Fatal(e)
	}
	preview := desktopTestCall(t, b, "data:archivePreview", "2021-01-01")
	if desktopInt(preview["items"]) != 1 || desktopInt(preview["batches"]) != 1 {
		t.Fatal("archival cutoff/reference mismatch")
	}
	target := filepath.Join(t.TempDir(), "archive.json")
	b.Native = func(method string, args []any) (any, error) {
		if method != "saveDialog" {
			return nil, errors.New("unexpected native operation")
		}
		return map[string]any{"canceled": false, "filePath": target}, nil
	}
	exported := desktopTestCall(t, b, "data:archiveExport", "2021-01-01")
	if exported["file"] != target {
		t.Fatal("export output missing")
	}
	r, e = b.Workspace.Get()
	if e != nil || len(desktopList(desktopMap(desktopProjects(r)[0])["items"])) != 2 {
		t.Fatal("export unexpectedly cleared workspace")
	}
	b.Native = func(method string, args []any) (any, error) {
		t.Fatal("clear must not open export dialog")
		return nil, nil
	}
	archived := desktopTestCall(t, b, "data:archiveClear", "2021-01-01")
	if archived["file"] != "" {
		t.Fatal("clear unexpectedly exported a file")
	}
	raw, e := os.ReadFile(target)
	if e != nil || !strings.Contains(string(raw), "reqflow-archive-v1") {
		t.Fatal("archive not persisted")
	}
	r, e = b.Workspace.Get()
	if e != nil {
		t.Fatal(e)
	}
	p = desktopMap(desktopProjects(r)[0])
	if len(desktopList(p["items"])) != 1 || desktopMap(desktopList(p["batches"])[0])["id"] != "flight" {
		t.Fatal("archive removed live requirements")
	}
}
func TestGitMilestonesFeed(t *testing.T) {
	if _, e := exec.LookPath("git"); e != nil {
		t.Skip("git unavailable")
	}
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	root := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("git %v: %s: %v", args, out, e)
		}
	}
	git("init")
	write := func(name, text string) {
		t.Helper()
		if e := os.WriteFile(filepath.Join(root, name), []byte(text), 0600); e != nil {
			t.Fatal(e)
		}
	}
	write("a.txt", "first")
	git("add", ".")
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feat: 初始化项目")
	write("b.txt", "second")
	git("add", ".")
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fix: 修复里程碑", "-m", "详细说明第二行")

	r := desktopTestCall(t, b, "git:milestones", root, 120)
	if r["repo"] != true || coreNum(r["total"]) != 2 || len(desktopList(r["commits"])) != 2 {
		t.Fatalf("unexpected milestone feed: %v", r)
	}
	newest := desktopMap(desktopList(r["commits"])[0])
	if newest["subject"] != "fix: 修复里程碑" || newest["short"] == "" || !strings.Contains(desktopString(newest["body"]), "详细说明") {
		t.Fatalf("newest commit fields missing: %v", newest)
	}
	hasHead := false
	for _, ref := range desktopList(newest["refs"]) {
		if strings.Contains(desktopString(ref), "HEAD") {
			hasHead = true
		}
	}
	if !hasHead {
		t.Fatalf("HEAD decoration missing: %v", newest["refs"])
	}
	plain := t.TempDir()
	r = desktopTestCall(t, b, "git:milestones", plain, 120)
	if r["repo"] != false || len(desktopList(r["commits"])) != 0 {
		t.Fatalf("non-repository should return an empty feed: %v", r)
	}
}

func TestDesktopInstallerVerification(t *testing.T) {
	file := filepath.Join(t.TempDir(), "setup.exe")
	raw := []byte("MZfixture Go installer")
	os.WriteFile(file, raw, 0600)
	sum := sha256.Sum256(raw)
	asset := map[string]any{"name": "ReqFlow-Setup-2.0.1.exe", "size": len(raw), "browser_download_url": "https://github.com/wangqizhi/ReqFlow/releases/download/v2.0.1/ReqFlow-Setup-2.0.1.exe"}
	hash := hex.EncodeToString(sum[:])
	if !desktopValidAsset(asset, "2.0.1") || !desktopVerifyInstaller(file, asset, hash) {
		t.Fatal("valid hashed installer rejected")
	}
	os.WriteFile(file, []byte("MZtampered"), 0600)
	if desktopVerifyInstaller(file, asset, hash) {
		t.Fatal("tampered installer accepted")
	}
	if desktopTrustedDownload("https://github.com.evil/wangqizhi/ReqFlow/releases/download/x") || desktopTrustedDownload("https://github.com/user/other/releases/download/x") {
		t.Fatal("untrusted download accepted")
	}
	if !desktopNewer("2.0.1", "2.0.0") || desktopNewer("1.11.9", "2.0.0") {
		t.Fatal("version comparison")
	}
}
