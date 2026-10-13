package backendgo

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackupRealGitRoundtripRetriesAndFastForward(t *testing.T) {
	b := aiTestBackend(t)
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	configuredURL := "https://reqflow-backup-tests.invalid/repository.git"
	// Every invocation inherits a Git URL rewrite to this local bare repository.
	// System/global Git config is isolated, so this test needs no credentials,
	// public DNS, public network, or changes to the user's Git configuration.
	globalConfig := filepath.Join(root, "empty-global-config")
	if err := os.WriteFile(globalConfig, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", globalConfig)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_COUNT", "2")
	t.Setenv("GIT_CONFIG_KEY_0", "url."+filepath.ToSlash(remote)+".insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_0", configuredURL)
	t.Setenv("GIT_CONFIG_KEY_1", "protocol.file.allow")
	t.Setenv("GIT_CONFIG_VALUE_1", "always")
	git := func(cwd string, args ...string) string {
		t.Helper()
		out, err := RunRemoteGit(args, cwd, nil)
		if err != nil {
			t.Fatalf("temporary Git command %q failed: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
	if _, err := RunRemoteGit([]string{"--version"}, root, nil); err != nil {
		t.Skip("Git not available")
	}
	git(root, "init", "--bare", "--initial-branch=main", remote)
	settings := map[string]any{"provider": "github", "url": configuredURL, "branch": "main", "sshKeyPath": "", "autoSync": false}
	if _, err := b.invokeRemote("backup:save", []any{settings}); err != nil {
		t.Fatal(err)
	}
	secret := "FAKE_PRIVATE_KEY_NOT_FOR_BACKUP"
	for _, name := range []string{"ai-settings.json", "local-agents.json", "private-ssh-key"} {
		if err := os.WriteFile(filepath.Join(b.DataDir, name), []byte(secret), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.Workspace.Get(); err != nil {
		t.Fatal(err)
	}
	sync := func() map[string]any {
		t.Helper()
		status, err := b.syncBackup()
		if err != nil {
			t.Fatalf("temporary backup failed: %v", err)
		}
		if status["running"] != false || aiString(status["lastSuccess"]) == "" {
			t.Fatal("successful backup status missing")
		}
		return status
	}
	digest := sha256.Sum256([]byte(configuredURL + "\nmain"))
	checkout := filepath.Join(b.DataDir, "backup-repos", hex.EncodeToString(digest[:])[:24])
	sync()
	first := git(remote, "rev-parse", "refs/heads/main")
	if git(remote, "rev-list", "--count", "main") != "1" {
		t.Fatal("first backup should create exactly one commit")
	}
	if git(checkout, "config", "--get", "remote.origin.url") != configuredURL {
		t.Fatal("backup replaced configured URL with its effective transport URL")
	}
	if git(checkout, "remote", "get-url", "origin") == configuredURL {
		t.Fatal("test did not exercise an insteadOf transport rewrite")
	}
	payload := git(remote, "show", "main:reqflow-backup.json")
	if strings.Contains(payload, secret) || strings.Contains(payload, "encryptedKey") || strings.Contains(payload, "apiKey") {
		t.Fatal("backup included private configuration")
	}
	var backup map[string]any
	if err := json.Unmarshal([]byte(payload), &backup); err != nil {
		t.Fatal(err)
	}
	if backup["format"] != "reqflow-backup-v1" || len(aiArray(aiMap(backup["workspace"])["projects"])) != 1 {
		t.Fatal("first backup payload differs")
	}
	sync()
	if git(remote, "rev-parse", "main") != first || git(checkout, "rev-list", "--count", "HEAD") != "1" {
		t.Fatal("unchanged backup created an unnecessary commit")
	}
	if _, err := b.Workspace.Mutate(map[string]any{"op": "project", "name": "恢复测试项目", "description": "备份后可恢复"}, nil); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(remote, "hooks", "pre-receive")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	status, err := b.syncBackup()
	if err == nil || status["running"] != false || aiString(status["error"]) == "" {
		t.Fatal("rejected push must report a stopped failure")
	}
	retained := git(checkout, "rev-parse", "HEAD")
	if retained == first || git(checkout, "rev-list", "--count", "HEAD") != "2" || git(remote, "rev-parse", "main") != first {
		t.Fatal("failed push discarded the local backup commit or changed the remote")
	}
	if err := os.Remove(hook); err != nil {
		t.Fatal(err)
	}
	sync()
	if git(remote, "rev-parse", "main") != retained || git(checkout, "rev-list", "--count", "HEAD") != "2" {
		t.Fatal("retry did not push the retained commit without duplicating it")
	}
	writer := filepath.Join(root, "remote-writer")
	git(root, "clone", "--single-branch", "--branch", "main", "--", configuredURL, writer)
	if err := os.WriteFile(filepath.Join(writer, "remote-note.txt"), []byte("remote change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	git(writer, "add", "--", "remote-note.txt")
	git(writer, "-c", "user.name=Temporary Writer", "-c", "user.email=writer@reqflow.invalid", "commit", "-m", "test remote advance")
	git(writer, "push", "origin", "main")
	advanced := git(remote, "rev-parse", "main")
	sync()
	if git(checkout, "rev-parse", "HEAD") != advanced || git(checkout, "rev-list", "--count", "HEAD") != "3" {
		t.Fatal("backup did not fast-forward the remote change cleanly")
	}
	if raw, err := os.ReadFile(filepath.Join(checkout, "remote-note.txt")); err != nil || string(raw) != "remote change\n" {
		t.Fatal("remote content was lost during fast-forward")
	}
	payload = git(remote, "show", "main:reqflow-backup.json")
	if err := json.Unmarshal([]byte(payload), &backup); err != nil {
		t.Fatal(err)
	}
	restored := NewBackend(t.TempDir(), root, "2.0.0")
	if result, err := restored.Workspace.ImportWorkspace(backup, false); err != nil || aiNumber(result["projects"]) != 2 {
		t.Fatalf("backup import failed: %v", err)
	}
	before, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	after, err := restored.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	// Import deliberately advances concurrency revisions so stale clients cannot
	// overwrite restored data; the workspace contents must otherwise roundtrip.
	beforeProjects := aiArray(aiMap(before["state"])["projects"])
	afterProjects := aiArray(aiMap(after["state"])["projects"])
	for i, value := range beforeProjects {
		prior, replacement := aiMap(value), aiMap(afterProjects[i])
		if aiNumber(replacement["revision"]) <= aiNumber(prior["revision"]) {
			t.Fatal("restoration did not invalidate stale project revisions")
		}
		delete(prior, "revision")
		delete(replacement, "revision")
	}
	beforeJSON, _ := json.Marshal(before["state"])
	afterJSON, _ := json.Marshal(after["state"])
	if !bytes.Equal(beforeJSON, afterJSON) {
		t.Fatal("restored workspace differs from backed-up projects")
	}
	// The URL rewrite is permitted, but altering the checkout's configured
	// identity must never silently route workspace contents to another remote.
	tampered := "https://reqflow-backup-tests.invalid/unexpected.git"
	git(checkout, "remote", "set-url", "origin", tampered)
	if _, err := b.syncBackup(); err == nil || !strings.Contains(err.Error(), "origin") {
		t.Fatal("tampered backup origin was accepted")
	}
	if git(checkout, "config", "--get", "remote.origin.url") != tampered || git(checkout, "rev-parse", "HEAD") != advanced {
		t.Fatal("rejected origin mismatch changed the checkout")
	}
}

func TestValidateRemoteURLsBranchesAndSSH(t *testing.T) {
	for _, url := range []string{"https://github.com/owner/repo.git", "ssh://git@gitlab.example:2222/team/repo.git", "git@github.com:owner/repo.git", ""} {
		if _, err := ValidateRemote(map[string]any{"provider": "github", "url": url, "branch": "feature/test"}); err != nil {
			t.Fatalf("valid remote rejected: %s", url)
		}
	}
	for _, url := range []string{"https://token@github.com/a.git", "https://github.com/a.git?token=x", "file:///repo", "ext::sh injected", "C:/repo"} {
		if _, err := ValidateRemote(map[string]any{"provider": "github", "url": url}); err == nil {
			t.Fatalf("unsafe remote accepted: %s", url)
		}
	}
	for _, branch := range []string{"--upload-pack=x", "../main", "main.lock", "a//b", "a@{x}", "main/", "main."} {
		if _, err := ValidateRemote(map[string]any{"provider": "gitlab", "url": "", "branch": branch}); err == nil {
			t.Fatalf("unsafe branch accepted: %s", branch)
		}
	}
	for _, key := range []string{"relative/key", `C:\test\key" & echo injected`, "C:\\test\\$key"} {
		if _, err := aiSSHCommand(map[string]any{"sshKeyPath": key}); err == nil {
			t.Fatal("unsafe SSH key accepted")
		}
	}
	key := filepath.Join(t.TempDir(), "key with spaces")
	if err := os.WriteFile(key, []byte("fake"), 0600); err != nil {
		t.Fatal(err)
	}
	command, err := aiSSHCommand(map[string]any{"sshKeyPath": key})
	if err != nil || !strings.Contains(command, `-i "`) {
		t.Fatal("SSH key quoting missing")
	}
}

func TestBackupSettingsLifecycle(t *testing.T) {
	b := aiTestBackend(t)
	b.StartAI()
	defer b.StopAI()
	result, err := b.invokeRemote("backup:get", nil)
	if err != nil || aiMap(aiMap(result)["settings"])["autoSync"] != true {
		t.Fatal("default backup settings differ")
	}
	settings := map[string]any{"provider": "gitlab", "url": "ssh://git@example.invalid/repo", "branch": "main", "sshKeyPath": "", "autoSync": false}
	if _, err = b.invokeRemote("backup:save", []any{settings}); err != nil {
		t.Fatal(err)
	}
	other := NewBackend(b.DataDir, b.AppDir, "2.0.0")
	result, err = other.invokeRemote("backup:get", nil)
	if err != nil || aiMap(aiMap(result)["settings"])["autoSync"] != false {
		t.Fatal("backup persisted settings differ")
	}
	if _, err = b.invokeRemote("backup:save", []any{map[string]any{"provider": "github", "autoSync": "false"}}); err == nil {
		t.Fatal("invalid backup settings saved")
	}
	state := b.backupState()
	state.mu.Lock()
	state.status["running"] = true
	state.mu.Unlock()
	if _, err = b.invokeRemote("backup:save", []any{settings}); err == nil {
		t.Fatal("running backup config mutated")
	}
}

func TestRemoteGitRunsDirectArgv(t *testing.T) {
	root := t.TempDir()
	out, err := RunRemoteGit([]string{"--version"}, root, nil)
	if err != nil {
		t.Skip("Git not available")
	}
	if !strings.Contains(out, "git version") {
		t.Fatal("git version output missing")
	}
	if _, err = RunRemoteGit([]string{"init"}, root, nil); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "literal & file.txt")
	if err = os.WriteFile(file, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = RunRemoteGit([]string{"add", "--", filepath.Base(file)}, root, nil); err != nil {
		t.Fatal(err)
	}
	out, err = RunRemoteGit([]string{"diff", "--cached", "--name-only"}, root, nil)
	if err != nil || !strings.Contains(out, "literal & file.txt") {
		t.Fatal("direct argv did not stage literal metacharacter name")
	}
}
