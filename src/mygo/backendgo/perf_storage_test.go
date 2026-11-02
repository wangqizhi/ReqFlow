package backendgo

import (
	"os"
	"strings"
	"testing"
)

const testPixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

func perfTestProjects(t *testing.T, s *WorkspaceService) (string, string) {
	t.Helper()
	r := coreTestGet(t, s)
	first := coreString(coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"])
	if _, e := s.Mutate(map[string]any{"op": "project", "name": "第二个项目"}, nil); e != nil {
		t.Fatal(e)
	}
	r = coreTestGet(t, s)
	second := coreString(coreMap(coreList(coreMap(r["state"])["projects"])[1])["id"])
	return first, second
}

// 图片外置：保存后只保留 path，界面可读取、编辑保留、导出与远程回填 dataUrl。
func TestAttachmentsStoredOutsideWorkspace(t *testing.T) {
	s := NewWorkspaceService(t.TempDir())
	s.localOnly = true
	pid, _ := perfTestProjects(t, s)
	attachment := map[string]any{"id": "img-1", "label": "图片1", "name": "a.png", "dataUrl": testPixel}
	r, e := s.Mutate(map[string]any{"op": "item", "project": pid, "body": "带图需求", "attachments": []any{attachment}}, nil)
	if e != nil {
		t.Fatal(e)
	}
	item := coreMap(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), pid)["items"])[0])
	stored := coreMap(coreList(item["attachments"])[0])
	if _, has := stored["dataUrl"]; has || !coreExists(coreString(stored["path"])) {
		t.Fatalf("attachment not externalized: %v", stored)
	}
	if data, e := readAttachmentDataURL(s.imagesDir(), coreString(stored["path"])); e != nil || data != testPixel {
		t.Fatalf("attachment read failed: %v", e)
	}
	if _, e := readAttachmentDataURL(s.imagesDir(), "C:/Windows/win.ini"); e == nil {
		t.Fatal("arbitrary file read allowed")
	}
	// 编辑需求时附件只带 path，可正常保存，并留下不含图片字节的历史快照。
	if _, e = s.Mutate(map[string]any{"op": "item", "project": pid, "id": item["id"], "body": "带图需求（修改）", "attachments": []any{stored}}, nil); e != nil {
		t.Fatal(e)
	}
	raw, _ := s.store.read()
	if strings.Contains(coreJSON(raw), "base64,") {
		t.Fatal("image bytes still stored inline")
	}
	exported := coreDeepCopy(raw)
	s.hydrateImages(exported)
	if !strings.Contains(coreJSON(exported), testPixel) {
		t.Fatal("export not hydrated")
	}
	payload := s.remotePayload(coreFind(coreList(coreMap(raw["data"])["projects"]), pid))
	if !strings.Contains(coreJSON(payload), testPixel) || strings.Contains(coreJSON(payload), `"path"`) {
		t.Fatal("remote payload must carry image bytes without local paths")
	}
	// 旧数据（内联 dataUrl）读写一次后迁移为外置。
	legacy := NewWorkspaceService(t.TempDir())
	legacy.localOnly = true
	lp, _ := perfTestProjects(t, legacy)
	record, _ := legacy.store.read()
	p := coreFind(coreList(coreMap(record["data"])["projects"]), lp)
	p["requirementDraft"] = map[string]any{"body": "草稿", "attachments": []any{map[string]any{"id": "img-2", "label": "图片1", "name": "b.png", "dataUrl": testPixel}}}
	version := coreNum(record["version"])
	if _, e = legacy.store.write(record, &version); e != nil {
		t.Fatal(e)
	}
	if _, e = legacy.Mutate(map[string]any{"op": "guidance", "project": lp, "text": "引导"}, nil); e != nil {
		t.Fatal(e)
	}
	raw, _ = legacy.store.read()
	if strings.Contains(coreJSON(raw), "base64,") {
		t.Fatal("legacy inline image not migrated")
	}
}

// 增量回传：界面持有的 revision 未变化的项目与工作区级字段不再回传；视图精简历史快照。
func TestWorkspaceResponseDelta(t *testing.T) {
	s := NewWorkspaceService(t.TempDir())
	s.localOnly = true
	first, second := perfTestProjects(t, s)
	r := coreTestGet(t, s)
	full := workspaceResponse(desktopOK(r), nil)
	view := coreMap(full["state"])
	known := map[string]any{"revisions": map[string]any{}}
	for _, p := range coreList(view["projects"]) {
		known["revisions"].(map[string]any)[coreString(coreMap(p)["id"])] = coreMap(p)["revision"]
	}
	base := map[string]any{}
	for k, v := range view {
		if k != "projects" {
			base[k] = v
		}
	}
	known["baseHash"] = coreHash(coreJSON(base))
	if _, e := s.Mutate(map[string]any{"op": "item", "project": first, "body": "原始正文"}, nil); e != nil {
		t.Fatal(e)
	}
	r = coreTestGet(t, s)
	item := coreMap(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), first)["items"])[0])
	next, e := s.Mutate(map[string]any{"op": "item", "project": first, "id": item["id"], "body": "修改正文"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	delta := coreMap(workspaceResponse(desktopOK(next), known)["delta"])
	changed := coreMap(delta["projects"])
	if changed[first] == nil || changed[second] != nil || delta["base"] != nil || len(coreList(delta["order"])) != 2 {
		t.Fatalf("unexpected delta: %v", coreJSON(delta))
	}
	history := coreList(coreMap(coreList(coreMap(changed[first])["items"])[0])["history"])
	snapshot := coreMap(coreMap(history[0])["snapshot"])
	if snapshot["body"] != "原始正文" || snapshot["history"] != nil || snapshot["flowEvents"] != nil || len(snapshot) > 4 {
		t.Fatalf("history snapshot not reduced to view: %v", snapshot)
	}
	// 界面基于视图计算的校验值与后端一致，可继续提交。
	viewProject := coreMap(changed[first])
	stored := coreFind(coreList(coreMap(next["state"])["projects"]), first)
	if projectContentToken(viewProject) != ProjectConcurrencyToken(stored) {
		t.Fatal("view token mismatch")
	}
}

// 存储缓存与增量写入：其他进程写入后能读到最新数据；只改一个项目时其他项目原样保留。
func TestStoreCacheAndScopedWrite(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	s.localOnly = true
	first, second := perfTestProjects(t, s)
	if _, e := s.Mutate(map[string]any{"op": "guidance", "project": second, "text": "第二个项目引导"}, nil); e != nil {
		t.Fatal(e)
	}
	other := NewWorkspaceService(dir) // 模拟 CLI 等其他进程
	other.localOnly = true
	if _, e := other.Mutate(map[string]any{"op": "guidance", "project": first, "text": "其他进程写入"}, nil); e != nil {
		t.Fatal(e)
	}
	r := coreTestGet(t, s)
	if coreFind(coreList(coreMap(r["state"])["projects"]), first)["guidance"] != "其他进程写入" {
		t.Fatal("stale cache after external write")
	}
	if _, e := s.Mutate(map[string]any{"op": "guidance", "project": first, "text": "本进程写入"}, nil); e != nil {
		t.Fatal(e)
	}
	fresh, e := coreReadSQL(other.store.sqlitePath())
	if e != nil {
		t.Fatal(e)
	}
	projects := coreList(coreMap(fresh["data"])["projects"])
	if coreFind(projects, first)["guidance"] != "本进程写入" || coreFind(projects, second)["guidance"] != "第二个项目引导" {
		t.Fatal("scoped write lost data")
	}
	if _, e := s.Mutate(map[string]any{"op": "deleteProject", "project": first}, nil); e != nil {
		t.Fatal(e)
	}
	fresh, _ = coreReadSQL(other.store.sqlitePath())
	if len(coreList(coreMap(fresh["data"])["projects"])) != 1 {
		t.Fatal("deleted project still stored")
	}
	if _, e := os.Stat(s.store.sqlitePath()); e != nil {
		t.Fatal(e)
	}
}
