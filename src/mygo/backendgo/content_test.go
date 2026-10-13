package backendgo

import "testing"

func TestDraftAndContextPersistence(t *testing.T) {
	dir := t.TempDir()
	service := NewWorkspaceService(dir)
	r := coreTestGet(t, service)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	mutate := func(a map[string]any) {
		t.Helper()
		if _, e := service.Mutate(a, nil); e != nil {
			t.Fatal(e)
		}
	}
	mutate(map[string]any{"op": "project", "name": "另一个项目"})
	mutate(map[string]any{"op": "requirementDraft", "project": pid, "draft": map[string]any{"body": "尚未保存的内容", "criteria": "验收条件", "type": "bug", "priority": "P0"}})
	mutate(map[string]any{"op": "contextPrompt", "title": "审查", "body": "检查改动", "tags": []any{" 开发 ", "开发", "审查"}})
	if e := service.MigrateToSQLite(); e != nil {
		t.Fatal(e)
	}
	restarted := NewWorkspaceService(dir)
	r = coreTestGet(t, restarted)
	state := coreMap(r["state"])
	projects := coreList(state["projects"])
	if coreMap(coreMap(projects[0])["requirementDraft"])["body"] != "尚未保存的内容" || coreHas(coreMap(projects[1]), "requirementDraft") {
		t.Fatal("draft was lost or leaked to another project")
	}
	prompts := coreList(state["contextPrompts"])
	if len(prompts) != 1 || len(coreList(coreMap(prompts[0])["tags"])) != 2 {
		t.Fatal("prompt persistence or tag deduplication failed")
	}
	promptID := coreMap(prompts[0])["id"]
	mutate(map[string]any{"op": "contextPrompt", "id": promptID, "title": "修改后", "body": "内容", "tags": []any{"审查"}})
	mutate(map[string]any{"op": "item", "project": pid, "body": "保存的内容", "clearDraft": true})
	state = coreMap(coreTestGet(t, restarted)["state"])
	if coreHas(coreFind(coreList(state["projects"]), pid), "requirementDraft") {
		t.Fatal("saved requirement retained draft")
	}
	if coreMap(coreList(state["contextPrompts"])[0])["title"] != "修改后" {
		t.Fatal("prompt edit not persisted")
	}
	mutate(map[string]any{"op": "deleteContextPrompt", "id": promptID})
	if len(coreList(coreMap(coreTestGet(t, restarted)["state"])["contextPrompts"])) != 0 {
		t.Fatal("prompt delete failed")
	}
}
