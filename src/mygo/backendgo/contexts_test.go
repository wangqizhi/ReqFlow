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

func TestContextCodeExcerptsAreVersionedAndRemovable(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	state := coreMap(coreTestGet(t, s)["state"])
	pid := coreString(coreMap(coreList(state["projects"])[0])["id"])
	codeFile := filepath.Join(t.TempDir(), "code.md")
	code := "### src/core/domain.ts\n\n```ts\nexport function apply() {}\n```"
	if e := os.WriteFile(codeFile, []byte(code), 0600); e != nil {
		t.Fatal(e)
	}
	r := coreTestCLI(t, dir, "context", "put", "--project", pid, "--feature", "排期", "--title", "排期功能", "--body", "上下文说明",
		"--code", codeFile, "--files", "src/renderer/App.tsx, ./src/core/domain.ts")
	prompt := coreMap(coreList(coreMap(r["state"])["contextPrompts"])[0])
	if !strings.Contains(coreString(prompt["code"]), "export function apply") {
		t.Fatal("code excerpt was not stored")
	}
	if files := coreList(prompt["files"]); len(files) != 2 || files[0] != "src/renderer/App.tsx" || files[1] != "src/core/domain.ts" {
		t.Fatalf("related files were not normalized: %v", files)
	}
	source := filepath.Join(dir, "contexts")
	raw, e := os.ReadFile(filepath.Join(source, "contexts.md"))
	if e != nil || !strings.Contains(string(raw), "### 相关代码") || !strings.Contains(string(raw), "src/core/domain.ts") {
		t.Fatal("contexts.md did not include code excerpts", e)
	}
	codePath := filepath.Join(source, "code", coreString(prompt["id"])+".md")
	if snapshot, e := os.ReadFile(codePath); e != nil || !strings.Contains(string(snapshot), "export function apply") {
		t.Fatal("code snapshot file missing", e)
	}
	index, _ := os.ReadFile(filepath.Join(source, "index.json"))
	if !strings.Contains(string(index), "export function apply") {
		t.Fatal("index.json did not include the code excerpt")
	}
	if _, e := exec.LookPath("git"); e == nil {
		cmd := exec.Command("git", "-C", source, "log", "--oneline")
		if out, e := cmd.CombinedOutput(); e != nil || strings.TrimSpace(string(out)) == "" {
			t.Fatal("code update was not committed", e, string(out))
		}
	}
	// Clearing the excerpt removes the managed snapshot instead of leaving stale code behind.
	coreTestCLI(t, dir, "context", "put", "--id", coreString(prompt["id"]), "--title", "排期功能", "--body", "上下文说明", "--code", "", "--files", "")
	if _, e := os.Stat(codePath); !os.IsNotExist(e) {
		t.Fatal("cleared code left a stale snapshot", e)
	}
	raw, _ = os.ReadFile(filepath.Join(source, "contexts.md"))
	if strings.Contains(string(raw), "### 相关代码") {
		t.Fatal("cleared code remained in contexts.md")
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

func TestDeleteContextRulesPersistsAndCanRegenerate(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	state := coreMap(coreTestGet(t, s)["state"])
	pid := coreString(coreMap(coreList(state["projects"])[0])["id"])
	coreTestCLI(t, dir, "context", "put", "--project", pid, "--feature", "排期", "--title", "保留文档", "--body", "关联上下文")
	for _, disabled := range []bool{true, false} {
		state = coreMap(coreTestGet(t, s)["state"])
		p := coreFind(coreList(state["projects"]), pid)
		if _, err := s.Mutate(map[string]any{"op": "guidance", "project": pid, "text": p["guidance"], "contextRulesDisabled": disabled}, nil); err != nil {
			t.Fatal(err)
		}
		s = NewWorkspaceService(dir)
		state = coreMap(coreTestGet(t, s)["state"])
		p = coreFind(coreList(state["projects"]), pid)
		if (coreString(p["contextRules"]) == "") != disabled {
			t.Fatalf("rules disabled=%v did not survive reload", disabled)
		}
		if strings.Contains(BuildPrompt(p, []any{}), "## 项目守则（自动生成）") == disabled {
			t.Fatal("prompt did not respect rule deletion")
		}
		if len(coreList(state["contextPrompts"])) != 1 {
			t.Fatal("deleting rules changed context documents")
		}
	}
}
