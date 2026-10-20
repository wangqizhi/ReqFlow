package backendgo

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinkedContextsPromptMigrationAndGit(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	initial := coreMap(coreTestGet(t, s)["state"])
	pid := coreString(coreMap(coreList(initial["projects"])[0])["id"])
	file := filepath.Join(t.TempDir(), "feature.md")
	if e := os.WriteFile(file, []byte("# 架构\n参考 src/renderer/App.tsx，遵守项目约束。"), 0600); e != nil {
		t.Fatal(e)
	}
	r := coreTestCLI(t, dir, "context", "put", "--project", pid, "--feature", "排期", "--title", "排期功能", "--file", file)
	if r["warning"] != nil {
		t.Fatal(r["warning"])
	}
	state := coreMap(r["state"])
	p := coreFind(coreList(state["projects"]), pid)
	id := coreString(coreMap(coreList(state["contextPrompts"])[0])["id"])
	if !strings.Contains(coreString(p["contextRules"]), "排期功能") || !strings.Contains(BuildPrompt(p, []any{}), "src/renderer/App.tsx") {
		t.Fatal("linked context missing from rules or prompt")
	}
	source := filepath.Join(dir, "contexts")
	if _, e := os.Stat(filepath.Join(source, "index.json")); e != nil {
		t.Fatal(e)
	}
	history := func(folder string) string {
		t.Helper()
		cmd := exec.Command("git", "-C", folder, "rev-parse", "HEAD")
		raw, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("git: %s: %v", raw, e)
		}
		return strings.TrimSpace(string(raw))
	}
	gitAvailable := false
	if _, e := exec.LookPath("git"); e == nil {
		gitAvailable = true
	}
	before := ""
	if gitAvailable {
		before = history(source)
	}
	// Saving the same document must not create duplicate Git revisions.
	coreTestCLI(t, dir, "context", "put", "--id", id, "--project", pid, "--feature", "排期", "--title", "排期功能", "--file", file)
	if gitAvailable && history(source) != before {
		t.Fatal("unchanged context created a commit")
	}
	target := filepath.Join(t.TempDir(), "library")
	coreTestCLI(t, dir, "context", "migrate", "--dir", target)
	if gitAvailable && history(target) != before {
		t.Fatal("migration lost history")
	}
	coreTestCLI(t, dir, "context", "put", "--id", id, "--project", pid, "--feature", "排期", "--title", "更新", "--body", "更新后的约束")
	if gitAvailable && history(target) == before {
		t.Fatal("context edit did not create Git revision")
	}
	raw, e := os.ReadFile(filepath.Join(target, "contexts.md"))
	if e != nil || !strings.Contains(string(raw), "更新后的约束") {
		t.Fatal("new directory did not receive update", e)
	}
	old, _ := os.ReadFile(filepath.Join(source, "contexts.md"))
	if strings.Contains(string(old), "更新后的约束") {
		t.Fatal("migration kept writing old directory")
	}
	if _, e = s.moveContexts(source); e == nil {
		t.Fatal("non-empty target was overwritten")
	}
	if got, _ := s.contextDir(); got != target {
		t.Fatal("failed migration changed configuration")
	}
	if _, e = s.Mutate(map[string]any{"op": "deleteContextPrompt", "id": id}, nil); e != nil {
		t.Fatal(e)
	}
	p = coreFind(coreList(coreMap(coreTestGet(t, NewWorkspaceService(dir))["state"])["projects"]), pid)
	if coreString(p["contextRules"]) != "" || strings.Contains(BuildPrompt(p, []any{}), "更新后的约束") {
		t.Fatal("deleted context remained in prompt")
	}
}

func TestContextRulesAreConciseAndLimited(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	initial := coreMap(coreTestGet(t, s)["state"])
	pid := coreString(coreMap(coreList(initial["projects"])[0])["id"])
	body := strings.Repeat("这段说明只描述功能与上下文的联系。", 120)
	r := coreTestCLI(t, dir, "context", "put", "--project", pid, "--feature", "排期", "--title", "排期功能", "--body", body)
	p := coreFind(coreList(coreMap(r["state"])["projects"]), pid)
	rules := coreString(p["contextRules"])
	if n := len([]rune(rules)); n > DefaultContextRulesLimit {
		t.Fatalf("default context rules kept %d runes, want <= %d", n, DefaultContextRulesLimit)
	}
	if !strings.Contains(rules, "排期") || !strings.Contains(rules, "…") {
		t.Fatalf("truncated rules lost the feature or truncation mark: %q", rules)
	}
	prompt := BuildPrompt(p, []any{})
	if !strings.Contains(prompt, "## 项目守则（自动生成）") || !strings.Contains(prompt, rules) {
		t.Fatal("scheduling prompt did not include the limited context rules")
	}
	// 上限可在项目设置中调整，并且同样严格约束守则长度。
	r, e := s.Mutate(map[string]any{"op": "guidance", "project": pid, "text": coreString(p["guidance"]), "contextRulesLimit": int64(120)}, nil)
	if e != nil {
		t.Fatal(e)
	}
	p = coreFind(coreList(coreMap(r["state"])["projects"]), pid)
	rules = coreString(p["contextRules"])
	if n := len([]rune(rules)); n > 120 {
		t.Fatalf("custom context rules kept %d runes, want <= 120", n)
	}
	if coreFind(coreList(coreMap(r["state"])["projects"]), pid)["contextRulesLimit"] == nil {
		t.Fatal("custom limit was not persisted")
	}
	if _, e := s.Mutate(map[string]any{"op": "guidance", "project": pid, "text": coreString(p["guidance"]), "contextRulesLimit": int64(10)}, nil); e == nil {
		t.Fatal("out-of-range limit was accepted")
	}
}

func TestTerminalSettingSurvivesRestartAndSeparateTestData(t *testing.T) {
	dir := t.TempDir()
	app := NewBackend(dir, t.TempDir(), "test")
	desktopTestCall(t, app, "lab:terminal:save", true)
	isolated := NewBackend(t.TempDir(), t.TempDir(), "test")
	desktopTestCall(t, isolated, "lab:terminal:save", false)
	restarted := NewBackend(dir, t.TempDir(), "test")
	r := desktopTestCall(t, restarted, "lab:terminal:get")
	if desktopMap(r["settings"])["enabled"] != true {
		t.Fatal("isolated test or restart changed user's setting")
	}
}
