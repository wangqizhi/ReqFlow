package backendgo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func memoryTestState() map[string]any {
	item := map[string]any{"id": "i1", "number": "REQ-1", "type": "feature", "status": "pending_verification", "title": "全局记忆",
		"history": []any{map[string]any{"event": "实现完成", "time": "2026-10-30T01:00:00Z", "summary": "新增全局记忆"}}}
	running := map[string]any{"id": "i2", "number": "REQ-2", "type": "bug", "status": "in_progress", "body": "修复工具栏"}
	return map[string]any{"folders": []any{map[string]any{"id": "default", "name": "default"}},
		"projects": []any{map[string]any{"id": "p1", "name": "demo", "dir": `E:\demo`, "description": "演示项目", "items": []any{item, running}}}}
}

func TestMemoryFilesAndPrompt(t *testing.T) {
	dir := t.TempDir()
	if MemoryPromptSection(dir) != "" {
		t.Fatal("prompt section before files exist")
	}
	s := new(WorkspaceService)
	s.store = newWorkspaceStore(dir)
	if _, e := s.saveMemory(map[string]any{"enabled": true, "limitKB": 100, "recentLimit": 10, "notes": map[string]any{"ui": "使用暖色主题"}}); e != nil {
		t.Fatal(e)
	}
	if e := refreshMemoryFiles(dir, memoryTestState()); e != nil {
		t.Fatal(e)
	}
	recent, _ := os.ReadFile(filepath.Join(memoryDir(dir), "recent-work.md"))
	projects, _ := os.ReadFile(filepath.Join(memoryDir(dir), "projects.md"))
	ui, _ := os.ReadFile(filepath.Join(memoryDir(dir), "ui-design.md"))
	if !strings.Contains(string(recent), "REQ-1") || !strings.Contains(string(recent), "新增全局记忆") || !strings.Contains(string(recent), "REQ-2") {
		t.Fatal(string(recent))
	}
	if !strings.Contains(string(projects), `E:\demo`) || !strings.Contains(string(projects), "演示项目") || !strings.Contains(string(ui), "使用暖色主题") {
		t.Fatal(string(projects), string(ui))
	}
	if _, e := os.Stat(filepath.Join(memoryDir(dir), "tech-solutions.md")); !os.IsNotExist(e) {
		t.Fatal("empty manual section written")
	}
	section := MemoryPromptSection(dir)
	if !strings.Contains(section, "全局记忆") || !strings.Contains(section, filepath.Join(memoryDir(dir), "ui-design.md")) {
		t.Fatal(section)
	}
	SetMemoryDataDir(dir)
	defer SetMemoryDataDir("")
	if !strings.HasSuffix(BuildPrompt(map[string]any{"name": "demo"}, []any{}), section) {
		t.Fatal("prompt does not end with memory section")
	}
	if _, e := s.saveMemory(map[string]any{"enabled": false, "limitKB": 100, "recentLimit": 10, "notes": map[string]any{}}); e != nil {
		t.Fatal(e)
	}
	if MemoryPromptSection(dir) != "" {
		t.Fatal("disabled memory still referenced")
	}
}

func TestMemoryLimit(t *testing.T) {
	big := strings.Repeat("长", 4000) // 12 KB
	if _, e := validateMemorySettings(map[string]any{"limitKB": 10, "recentLimit": 10, "notes": map[string]any{"tech": big}}); e == nil {
		t.Fatal("oversize manual memory accepted")
	}
	for _, bad := range []map[string]any{{"limitKB": 5, "recentLimit": 10}, {"limitKB": 100, "recentLimit": 0}, {"limitKB": "100", "recentLimit": 10}} {
		if _, e := validateMemorySettings(bad); e == nil {
			t.Fatal("invalid memory settings accepted", bad)
		}
	}
	state := memoryTestState()
	items := []any{}
	for n := 0; n < 400; n++ {
		items = append(items, map[string]any{"number": "REQ-X", "status": "archived", "body": strings.Repeat("内容", 40),
			"history": []any{map[string]any{"event": "实现完成", "time": "2026-10-29", "summary": strings.Repeat("说明", 150)}}})
	}
	coreMap(coreList(state["projects"])[0])["items"] = items
	s := memorySettings{Enabled: true, LimitKB: 10, RecentLimit: 200, Notes: map[string]string{"tech": strings.Repeat("a", 4000)}}
	total := 0
	for _, text := range renderMemoryFiles(state, s) {
		total += len(text)
	}
	if total > s.limitBytes() {
		t.Fatalf("memory files %d bytes exceed limit %d", total, s.limitBytes())
	}
}
