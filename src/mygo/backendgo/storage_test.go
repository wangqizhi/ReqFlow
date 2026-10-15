package backendgo

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestProjectManagementPersistsWithoutChangingRequirements(t *testing.T) {
	dir := t.TempDir()
	svc := NewWorkspaceService(dir)
	state := coreMap(coreTestGet(t, svc)["state"])
	first := coreMap(coreList(state["projects"])[0])["id"]
	mutate := func(a map[string]any) {
		t.Helper()
		if _, err := svc.Mutate(a, nil); err != nil {
			t.Fatal(err)
		}
	}
	mutate(map[string]any{"op": "item", "project": first, "body": "隐藏项目后保留的需求"})
	mutate(map[string]any{"op": "folder", "name": "其他组"})
	state = coreMap(coreTestGet(t, svc)["state"])
	folder := coreMap(coreList(state["folders"])[1])["id"]
	mutate(map[string]any{"op": "project", "name": "跨组项目", "folderId": folder})
	mutate(map[string]any{"op": "project", "name": "同组项目"})
	state = coreMap(coreTestGet(t, svc)["state"])
	third := coreMap(coreList(state["projects"])[2])["id"]
	mutate(map[string]any{"op": "projectVisibility", "project": first, "hidden": true})
	mutate(map[string]any{"op": "projectMove", "project": first, "direction": "down"})
	// Reopen the real SQLite store: array order and hidden state survive a restart.
	svc = NewWorkspaceService(dir)
	state = coreMap(coreTestGet(t, svc)["state"])
	projects := coreList(state["projects"])
	if coreMap(projects[0])["id"] != third || coreMap(projects[1])["folderId"] != folder || coreMap(projects[2])["id"] != first {
		t.Fatal("group reorder lost or moved a different group", projects)
	}
	p := coreFind(projects, first)
	if p["hidden"] != true || len(coreList(p["items"])) != 1 || coreMap(coreList(p["items"])[0])["status"] != "ready" {
		t.Fatal("hidden state lost or requirements changed", p)
	}
	for _, a := range []map[string]any{
		{"op": "projectVisibility", "project": first, "hidden": "true"},
		{"op": "projectMove", "project": first, "direction": "invalid"},
		{"op": "projectFolder", "project": first, "folderId": "missing"},
	} {
		if _, err := svc.Mutate(a, nil); err == nil {
			t.Fatal("invalid action accepted", a)
		}
	}
	mutate(map[string]any{"op": "projectMove", "project": first, "direction": "down"}) // boundary is a no-op
	mutate(map[string]any{"op": "projectVisibility", "project": first, "hidden": false})
	mutate(map[string]any{"op": "projectFolder", "project": first, "folderId": folder})
	state = coreMap(coreTestGet(t, NewWorkspaceService(dir))["state"])
	p = coreFind(coreList(state["projects"]), first)
	if p["hidden"] != false || p["folderId"] != folder {
		t.Fatal("restore or grouping not persisted", p)
	}
}

func TestCoreSQLiteWritesOnlyChangedRows(t *testing.T) {
	s := NewWorkspaceService(t.TempDir())
	r := coreTestGet(t, s)
	p := coreMap(coreList(coreMap(r["state"])["projects"])[0])
	pid := p["id"]
	for _, title := range []string{"A", "B"} {
		if _, e := s.Mutate(map[string]any{"op": "item", "project": pid, "title": title}, nil); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := s.Mutate(map[string]any{"op": "project", "name": "Other"}, nil); e != nil {
		t.Fatal(e)
	}
	// As in the original service, newly created projects receive derived default
	// fields on the next normalization; persist those before measuring delta writes.
	if _, e := s.Mutate(map[string]any{"op": "globalBaselineTemplate", "text": ""}, nil); e != nil {
		t.Fatal(e)
	}
	record, e := s.store.read()
	if e != nil {
		t.Fatal(e)
	}
	db, e := sql.Open("sqlite", s.store.sqlitePath())
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if _, e = db.Exec(`CREATE TABLE audit(kind TEXT,id TEXT); CREATE TRIGGER audit_project AFTER UPDATE ON projects BEGIN INSERT INTO audit VALUES('project',NEW.id); END; CREATE TRIGGER audit_item AFTER UPDATE ON requirements BEGIN INSERT INTO audit VALUES('item',NEW.id); END; CREATE TRIGGER audit_project_delete AFTER DELETE ON projects BEGIN INSERT INTO audit VALUES('project-delete',OLD.id); END; CREATE TRIGGER audit_item_delete AFTER DELETE ON requirements BEGIN INSERT INTO audit VALUES('item-delete',OLD.id); END;`); e != nil {
		t.Fatal(e)
	}
	if e = s.store.replace(record); e != nil {
		t.Fatal(e)
	}
	var count int
	if e = db.QueryRow("SELECT COUNT(*) FROM audit").Scan(&count); e != nil {
		t.Fatal(e)
	}
	if count != 0 {
		t.Fatalf("unchanged write modified %d rows", count)
	}
	p = coreMap(coreList(coreMap(record["data"])["projects"])[0])
	i := coreMap(coreList(p["items"])[0])
	iid := i["id"]
	if _, e = s.Mutate(map[string]any{"op": "item", "project": pid, "id": iid, "title": "only one change"}, nil); e != nil {
		t.Fatal(e)
	}
	rows, e := db.Query("SELECT kind,id FROM audit")
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	updated := map[string]int{}
	for rows.Next() {
		var kind, id string
		if e = rows.Scan(&kind, &id); e != nil {
			t.Fatal(e)
		}
		updated[kind+":"+id]++
	}
	if len(updated) != 2 || updated["project:"+coreString(pid)] != 1 || updated["item:"+coreString(iid)] != 1 {
		t.Fatalf("unrelated rows changed: %v", updated)
	}
}

func coreTestGet(t *testing.T, s *WorkspaceService) map[string]any {
	t.Helper()
	r, e := s.Get()
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func TestCoreSQLiteMigrationPreservesUnknownFields(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	state, p := coreTestState()
	p["id"] = "project"
	p["custom"] = map[string]any{"nested": "<>&", "number": int64(12)}
	state["unknown"] = []any{"extension"}
	coreTestApply(t, state, map[string]any{"op": "item", "project": "project", "body": "image", "attachments": []any{map[string]any{"id": "img-1", "label": "图片1", "name": "a.png", "dataUrl": "data:image/png;base64,AA=="}}})
	i := coreMap(coreList(p["items"])[0])
	i["unknownFlag"] = "keep"
	coreTestApply(t, state, map[string]any{"op": "generate", "project": "project", "ids": []any{i["id"]}})
	record := map[string]any{"id": "local_electron", "version": int64(7), "data": state, "extension": "root"}
	if e := os.WriteFile(filepath.Join(dir, "workspace.json"), []byte(coreJSON(record)), 0600); e != nil {
		t.Fatal(e)
	}
	if s.StorageStatus() != "json" {
		t.Fatal("old JSON not detected")
	}
	if e := s.MigrateToSQLite(); e != nil {
		t.Fatal(e)
	}
	if s.StorageStatus() != "sqlite" {
		t.Fatal("migration failed")
	}
	read, e := s.store.read()
	if e != nil {
		t.Fatal(e)
	}
	if coreJSON(coreClone(read)) != coreJSON(coreClone(record)) {
		t.Fatal("unknown field or batch lost")
	}
	before := ProjectConcurrencyToken(p)
	r := coreTestGet(t, s)
	rp := coreMap(coreList(coreMap(r["state"])["projects"])[0])
	if ProjectConcurrencyToken(rp) != before {
		t.Fatal("materialized path changed signature")
	}
	imagePath := coreString(coreMap(coreList(coreMap(coreList(rp["batches"])[0])["items"])[0])["attachments"])
	_ = imagePath
	images, e := os.ReadDir(filepath.Join(dir, "images"))
	if e != nil || len(images) != 1 {
		t.Fatal("image not materialized", e)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "workspace.json.pre-sqlite-*.bak"))
	if len(matches) != 1 {
		t.Fatal("migration backup missing")
	}
}
func TestCoreWorkspaceConcurrentAndScopedMutations(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	initial := coreTestGet(t, s)
	if s.StorageStatus() != "sqlite" {
		t.Fatal("new workspace must use SQLite")
	}
	version := coreNum(initial["version"])
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, name := range []string{"A", "B"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			_, e := NewWorkspaceService(dir).Mutate(map[string]any{"op": "project", "name": name}, &version)
			results <- e
		}(name)
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for e := range results {
		if e == nil {
			ok++
		} else {
			var c *VersionConflictError
			if errors.As(e, &c) {
				conflicts++
			} else {
				t.Fatal(e)
			}
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("ok %d conflicts %d", ok, conflicts)
	}
	r := coreTestGet(t, s)
	projects := coreList(coreMap(r["state"])["projects"])
	p, q := coreMap(projects[0]), coreMap(projects[1])
	version = coreNum(r["version"])
	revision := coreNum(p["revision"])
	signature := ProjectConcurrencyToken(p)
	if _, e := s.Mutate(map[string]any{"op": "projectDescription", "project": q["id"], "description": "other project"}, nil); e != nil {
		t.Fatal(e)
	}
	action := map[string]any{"op": "item", "project": p["id"], "body": "scoped edit", "expectedProjectVersions": map[string]any{coreString(p["id"]): revision}, "expectedProjectSignatures": map[string]any{coreString(p["id"]): signature}}
	if _, e := s.Mutate(action, &version); e != nil {
		t.Fatal("unrelated project update should rebase", e)
	}
	if _, e := s.Mutate(action, &version); e == nil {
		t.Fatal("same project stale token accepted")
	}
}
func TestCoreOldWriterSignatureAndImportReplacement(t *testing.T) {
	s := NewWorkspaceService(t.TempDir())
	r := coreTestGet(t, s)
	p := coreMap(coreList(coreMap(r["state"])["projects"])[0])
	id := coreString(p["id"])
	rev := coreNum(p["revision"])
	sig := ProjectConcurrencyToken(p)
	raw, e := s.store.read()
	if e != nil {
		t.Fatal(e)
	}
	coreMap(coreList(coreMap(raw["data"])["projects"])[0])["description"] = "legacy writer edit"
	if e = s.store.replace(raw); e != nil {
		t.Fatal(e)
	}
	a := map[string]any{"op": "item", "project": id, "body": "should conflict", "expectedProjectVersions": map[string]any{id: rev}, "expectedProjectSignatures": map[string]any{id: sig}}
	if _, e = s.Mutate(a, nil); e == nil {
		t.Fatal("older writer evaded signature")
	}
	state := coreMap(r["state"])
	if _, e = s.ImportWorkspace(state, false); e == nil {
		t.Fatal("import overwrote without replace")
	}
	if _, e = s.ImportWorkspace(map[string]any{"format": "reqflow-backup-v1", "workspace": state}, true); e != nil {
		t.Fatal(e)
	}
	r = coreTestGet(t, s)
	p = coreMap(coreList(coreMap(r["state"])["projects"])[0])
	if coreNum(p["revision"]) <= rev {
		t.Fatal("replacement retained previous tokens")
	}
}
func TestCoreLockNeverStolenAndWriteStateOptimistic(t *testing.T) {
	s := NewWorkspaceService(t.TempDir())
	r := coreTestGet(t, s)
	lock := s.store.jsonPath() + ".lock"
	if e := os.Mkdir(lock, 0700); e != nil {
		t.Fatal(e)
	}
	s.store.lockTimeout = 30 * time.Millisecond
	_, e := s.Mutate(map[string]any{"op": "project", "name": "blocked"}, nil)
	if e == nil || !coreExists(lock) {
		t.Fatal("lock stolen")
	}
	if e = os.Remove(lock); e != nil {
		t.Fatal(e)
	}
	state := coreMap(r["state"])
	p := coreMap(coreList(state["projects"])[0])
	priorRev := coreNum(p["revision"])
	p["description"] = "archive/report update"
	next, e := s.WriteState(state, coreNum(r["version"]))
	if e != nil {
		t.Fatal(e)
	}
	np := coreMap(coreList(coreMap(next["state"])["projects"])[0])
	if coreNum(np["revision"]) != priorRev+1 {
		t.Fatal("WriteState did not invalidate revision")
	}
	if _, e = s.WriteState(state, coreNum(r["version"])); e == nil {
		t.Fatal("WriteState stale version accepted")
	}
}
