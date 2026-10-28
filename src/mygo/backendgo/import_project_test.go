package backendgo

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestImportProjectCloneAndDetect(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.13.9")
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	git := func(dir string, args ...string) string {
		t.Helper()
		out, err := desktopGitRun(context.Background(), args, dir)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	git(root, "init", "--bare", remote)
	seed := filepath.Join(root, "seed")
	git(root, "clone", remote, seed)
	git(seed, "checkout", "-b", "develop")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	git(seed, "add", ".")
	git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed")
	git(seed, "push", "origin", "develop")
	git(remote, "symbolic-ref", "HEAD", "refs/heads/develop")
	url := "https://github.com/test/import.git"
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(root, "no-config"))
	t.Setenv("GIT_CONFIG_COUNT", "2")
	t.Setenv("GIT_CONFIG_KEY_0", "url."+filepath.ToSlash(remote)+".insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_0", url)
	t.Setenv("GIT_CONFIG_KEY_1", "protocol.file.allow")
	t.Setenv("GIT_CONFIG_VALUE_1", "always")
	target := t.TempDir()
	settings := map[string]any{"provider": "github", "url": url, "branch": "main", "sshKeyPath": ""}
	value, err := b.desktopGit(context.Background(), "git:import", []any{target, settings})
	if err != nil {
		t.Fatal(err)
	}
	result := desktopMap(value)
	if result["name"] != "import" || desktopMap(result["remote"])["branch"] != "develop" {
		t.Fatalf("bad import: %v", value)
	}
	if raw, err := os.ReadFile(filepath.Join(target, "README.md")); err != nil || string(raw) != "keep" {
		t.Fatalf("clone failed: %s %v", raw, err)
	}
	value, err = b.desktopGit(context.Background(), "git:import", []any{target, nil, true})
	if err != nil || desktopMap(value)["name"] != "import" {
		t.Fatalf("detect failed: %v %v", value, err)
	}
	// Failed read authentication must leave the selected directory untouched.
	missing := map[string]any{"provider": "github", "url": "https://github.com/test/missing.git", "branch": "main", "sshKeyPath": ""}
	t.Setenv("GIT_CONFIG_COUNT", "3")
	t.Setenv("GIT_CONFIG_KEY_2", "url."+filepath.ToSlash(filepath.Join(root, "missing.git"))+".insteadOf")
	t.Setenv("GIT_CONFIG_VALUE_2", "https://github.com/test/missing.git")
	untouched := t.TempDir()
	if _, err := b.desktopGit(context.Background(), "git:import", []any{untouched, missing}); err == nil {
		t.Fatal("missing clone access must fail")
	}
	entries, _ := os.ReadDir(untouched)
	if len(entries) != 0 {
		t.Fatal("failed permission check modified destination")
	}
	occupied := t.TempDir()
	os.WriteFile(filepath.Join(occupied, "keep.txt"), []byte("keep"), 0600)
	value, err = b.desktopGit(context.Background(), "git:import", []any{occupied, settings})
	if err != nil || !coreTruthy(desktopMap(value)["needsConfirmation"]) {
		t.Fatal("must confirm occupied directory", value, err)
	}
	value, err = b.desktopGit(context.Background(), "git:import", []any{occupied, settings, true})
	if err != nil {
		t.Fatal(err)
	}
	backup := coreString(desktopMap(value)["backup"])
	if raw, err := os.ReadFile(filepath.Join(backup, "keep.txt")); err != nil || string(raw) != "keep" {
		t.Fatal("backup lost", err)
	}
	if _, err := os.Stat(filepath.Join(occupied, "README.md")); err != nil {
		t.Fatal(err)
	}
}

func TestCompletionDoesNotUseHostVersion(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.13.9")
	r := coreTestGet(t, b.Workspace)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	r, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": pid, "body": "no project version"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(r["state"])["projects"]), pid)
	id := coreMap(coreList(p["items"])[0])["id"]
	if _, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": pid, "ids": []any{id}}, nil); err != nil {
		t.Fatal(err)
	}
	r, err = b.Workspace.Mutate(map[string]any{"op": "complete", "project": pid, "id": id}, nil)
	if err != nil {
		t.Fatal(err)
	}
	i := coreFind(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), pid)["items"]), id)
	if coreString(i["verificationVersion"]) != "" {
		t.Fatalf("host version leaked: %v", i)
	}
}

func TestConfiguredProjectVersion(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "99.0.0")
	r := coreTestGet(t, b.Workspace)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"version":"1.0.0"}`), 0600)
	os.WriteFile(filepath.Join(root, "VERSION"), []byte("3.2.1\n"), 0600)
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": pid, "dir": root}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectRuntime", "project": pid, "cli": "pi", "fullAccess": false, "versionFile": "VERSION"}, nil); err != nil {
		t.Fatal(err)
	}
	if got := b.Workspace.projectVersion(coreString(pid)); got != "3.2.1" {
		t.Fatal(got)
	}
	os.Remove(filepath.Join(root, "VERSION"))
	if got := b.Workspace.projectVersion(coreString(pid)); got != "" {
		t.Fatal("missing explicit source must not fallback", got)
	}
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectRuntime", "project": pid, "cli": "pi", "versionFile": "../VERSION"}, nil); err == nil {
		t.Fatal("traversal accepted")
	}
}
