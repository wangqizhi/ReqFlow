package backendgo

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAIMemoryFillUsesRelatedGitLog(t *testing.T) {
	b := aiTestBackend(t)
	workspace, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	id := aiString(aiMap(aiArray(aiMap(workspace["state"])["projects"])[0])["id"])
	repo := t.TempDir()
	if _, err = RunRemoteGit([]string{"init"}, repo, nil); err != nil {
		t.Skip("Git not available")
	}
	for _, config := range [][]string{{"config", "user.email", "t@example.com"}, {"config", "user.name", "tester"}} {
		if _, err = RunRemoteGit(config, repo, nil); err != nil {
			t.Fatal(err)
		}
	}
	for n, msg := range []string{"update: 调整按钮配色与深色主题", "feat: 新增导出接口"} {
		if err = os.WriteFile(filepath.Join(repo, "f.txt"), []byte{byte('a' + n)}, 0600); err != nil {
			t.Fatal(err)
		}
		for _, args := range [][]string{{"add", "--", "f.txt"}, {"commit", "-m", msg}} {
			if _, err = RunRemoteGit(args, repo, nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err = os.MkdirAll(filepath.Join(repo, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(repo, "docs", "ui-guidelines.md"), []byte("按钮使用 .btn"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": id, "dir": repo}, nil); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		messages := aiArray(payload["messages"])
		var context map[string]any
		if len(messages) != 2 || json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context) != nil {
			t.Error("AI memory context missing")
			return
		}
		if aiMap(context["section"])["title"] != "UI 设计要求" || context["current"] != "旧内容" || aiMap(context["otherSections"])["经验与踩坑"] != "草稿经验" {
			t.Error("AI memory section/current/otherSections differ")
		}
		project := aiMap(aiArray(context["projects"])[0])
		log := aiString(project["gitLog"])
		if !strings.Contains(log, "按钮配色") || strings.Contains(log, "导出接口") {
			t.Errorf("AI memory should only include related commits: %q", log)
		}
		if files := aiArray(project["files"]); len(files) != 1 || aiMap(files[0])["name"] != "docs/ui-guidelines.md" {
			t.Error("AI memory omitted section files")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```\n# UI 设计要求\n\n- 按钮复用 .btn\n```"}}}})
	}))
	defer server.Close()
	if _, err = b.saveAISettings(aiTestSettings(server.URL)); err != nil {
		t.Fatal(err)
	}
	value, handled, err := b.InvokeAI("ai:memory:fill", []any{"ui", "旧内容", map[string]any{"lessons": "草稿经验"}})
	if err != nil || !handled || aiMap(value)["ok"] != true || aiMap(value)["text"] != "- 按钮复用 .btn" {
		t.Fatalf("memory fill failed: %v %v", value, err)
	}
	for _, key := range []string{"recent", "unknown"} {
		if _, _, err = b.InvokeAI("ai:memory:fill", []any{key, ""}); err == nil {
			t.Fatalf("section %s must be rejected", key)
		}
	}
}
