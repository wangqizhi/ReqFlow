package backendgo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBackupImportRealGitPreservesLocalAndNeverPushes(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	url := "https://reqflow-import-tests.invalid/repository.git"
	config := filepath.Join(root, "gitconfig")
	if err := os.WriteFile(config, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_COUNT", "2")
	t.Setenv("GIT_CONFIG_KEY_0", "url."+filepath.ToSlash(remote)+".insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_0", url)
	t.Setenv("GIT_CONFIG_KEY_1", "protocol.file.allow")
	t.Setenv("GIT_CONFIG_VALUE_1", "always")
	git := func(cwd string, args ...string) string {
		t.Helper()
		out, err := RunRemoteGit(args, cwd, nil)
		if err != nil {
			t.Fatalf("git %q: %v", args, err)
		}
		return strings.TrimSpace(out)
	}
	git(root, "init", "--bare", "--initial-branch=main", remote)
	source := aiTestBackend(t)
	state, err := source.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	p := desktopMap(desktopList(desktopMap(state["state"])["projects"])[0])
	p["items"] = []any{map[string]any{"id": "remote-item", "number": "REQ-001", "body": "远端正文", "version": 1, "status": "in_progress", "history": []any{}, "attachments": []any{}, "aiExecution": map[string]any{"runId": "remote-run"}}}
	p["nextNumber"] = 2
	if _, err = source.Workspace.WriteState(desktopMap(state["state"]), desktopInt(state["version"])); err != nil {
		t.Fatal(err)
	}
	settings := map[string]any{"provider": "github", "url": url, "branch": "main", "sshKeyPath": "", "autoSync": false}
	if _, err = source.invokeRemote("backup:save", []any{settings}); err != nil {
		t.Fatal(err)
	}
	if _, err = source.syncBackup(); err != nil {
		t.Fatal(err)
	}
	head := git(remote, "rev-parse", "main")
	target := aiTestBackend(t)
	if _, err = target.Workspace.Get(); err != nil {
		t.Fatal(err)
	}
	result, err := target.Invoke(context.Background(), "backup:import", []any{settings})
	if err != nil || desktopMap(result)["ok"] != true || desktopMap(result)["projects"] != 1 || desktopMap(result)["items"] != 1 {
		t.Fatalf("import: %v %v", result, err)
	}
	loaded, err := target.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	projects := desktopList(desktopMap(loaded["state"])["projects"])
	if len(projects) != 2 {
		t.Fatal("import lost local project")
	}
	imported := coreFind(projects, p["id"])
	i := desktopMap(desktopList(imported["items"])[0])
	if i["aiExecution"] != nil || i["body"] != "远端正文" {
		t.Fatal("remote item or execution identity differs")
	}
	if _, err = os.Stat(filepath.Join(target.DataDir, "before-remote-import.json")); err != nil {
		t.Fatal("missing recovery copy")
	}
	// Local changes and an active local run survive a subsequent import.
	i["body"] = "本机修改"
	i["aiExecution"] = map[string]any{"runId": "local-run"}
	if _, err = target.Workspace.WriteState(desktopMap(loaded["state"]), desktopInt(loaded["version"])); err != nil {
		t.Fatal(err)
	}
	before, _ := target.Workspace.Get()
	result, err = target.Invoke(context.Background(), "backup:import", nil)
	if err != nil || desktopMap(result)["ok"] != true || desktopMap(result)["items"] != 0 {
		t.Fatalf("repeat import: %v %v", result, err)
	}
	after, _ := target.Workspace.Get()
	if coreJSON(before) != coreJSON(after) {
		t.Fatal("repeat import overwrote local contents or changed version")
	}
	if git(remote, "rev-parse", "main") != head {
		t.Fatal("import uploaded local data")
	}
	settings["branch"] = "missing"
	if _, err = target.invokeRemote("backup:save", []any{settings}); err != nil {
		t.Fatal(err)
	}
	result, err = target.Invoke(context.Background(), "backup:import", nil)
	if err != nil || desktopMap(result)["ok"] != false {
		t.Fatalf("missing branch import accepted: %v %v", result, err)
	}
	after, _ = target.Workspace.Get()
	if coreJSON(before) != coreJSON(after) {
		t.Fatal("failed fetch changed workspace")
	}
	s := target.backupState()
	s.mu.Lock()
	s.status["running"] = true
	s.mu.Unlock()
	if _, err = target.importBackup(); err == nil {
		t.Fatal("concurrent backup operation accepted")
	}
}

func TestBackupMergeRejectsMalformedAndMaintainsRequirementNumbers(t *testing.T) {
	local := MakeProject("local", "")
	local["items"] = []any{map[string]any{"id": "local", "number": "REQ-001"}}
	remote := desktopMap(coreClone(local))
	remote["items"] = []any{map[string]any{"id": "remote", "number": "REQ-001"}, map[string]any{"id": "remote-sparse", "number": "REQ-050"}}
	state, counts, err := mergeBackupWorkspace(map[string]any{"projects": []any{local}}, map[string]any{"projects": []any{remote}})
	if err != nil || counts["items"] != 2 {
		t.Fatalf("merge: %v %v", counts, err)
	}
	p := desktopMap(desktopList(state["projects"])[0])
	items := desktopList(p["items"])
	if desktopMap(items[0])["number"] == desktopMap(items[1])["number"] || desktopInt(p["nextNumber"]) != 51 {
		t.Fatal("colliding or sparse numbers broke nextNumber")
	}
	for _, bad := range []map[string]any{{}, {"projects": []any{map[string]any{"id": "broken"}}}, {"projects": []any{remote, remote}}} {
		if _, _, err = mergeBackupWorkspace(map[string]any{"projects": []any{local}}, bad); err == nil {
			t.Fatal("malformed backup accepted")
		}
	}
}
