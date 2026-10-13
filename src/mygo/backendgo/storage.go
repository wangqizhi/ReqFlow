package backendgo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"reflect"
	"time"
)

type VersionConflictError struct{}

func (*VersionConflictError) Error() string {
	return "数据已被其他方式修改（可能是另一个窗口或 CLI）。请保留当前输入，刷新数据后重试。"
}
func (*VersionConflictError) Code() string { return "VERSION_CONFLICT" }

type workspaceStore struct {
	dir         string
	lockTimeout time.Duration
}

func newWorkspaceStore(dir string) *workspaceStore {
	return &workspaceStore{dir: dir, lockTimeout: 15 * time.Second}
}
func (s *workspaceStore) jsonPath() string   { return filepath.Join(s.dir, "workspace.json") }
func (s *workspaceStore) sqlitePath() string { return filepath.Join(s.dir, "requirements.sqlite") }
func coreExists(p string) bool               { _, e := os.Stat(p); return e == nil }
func (s *workspaceStore) backend() string {
	if coreExists(s.sqlitePath()) {
		return "sqlite"
	}
	if coreExists(s.jsonPath()) {
		return "json"
	}
	return "sqlite"
}
func (s *workspaceStore) read() (map[string]any, error) {
	if coreExists(s.sqlitePath()) {
		r, e := coreReadSQL(s.sqlitePath())
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, errors.New("SQLite 工作区数据缺失")
		}
		return r, nil
	}
	b, e := os.ReadFile(s.jsonPath())
	if errors.Is(e, os.ErrNotExist) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var r map[string]any
	if json.Unmarshal(b, &r) != nil || !coreSafeInt(r["version"]) {
		return nil, errors.New("工作区数据文件损坏：" + s.jsonPath())
	}
	if _, ok := coreMap(r["data"])["projects"].([]any); !ok {
		return nil, errors.New("工作区数据文件损坏：" + s.jsonPath())
	}
	return r, nil
}
func (s *workspaceStore) commit(operation func() (map[string]any, error)) (result map[string]any, err error) {
	if err = os.MkdirAll(s.dir, 0700); err != nil {
		return nil, err
	}
	lock := s.jsonPath() + ".lock"
	started := time.Now()
	for {
		e := os.Mkdir(lock, 0700)
		if e == nil {
			if e = os.WriteFile(filepath.Join(lock, "owner.json"), []byte(coreJSON(map[string]any{"pid": os.Getpid()})), 0600); e != nil {
				_ = os.Remove(lock)
				return nil, e
			}
			break
		}
		if !errors.Is(e, os.ErrExist) {
			return nil, e
		}
		if time.Since(started) > s.lockTimeout {
			return nil, errors.New("工作区写入锁等待超时，请稍后重试；若进程异常退出，请确认所有 ReqFlow/CLI 已停止后检查 workspace.json.lock。未覆盖当前输入")
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer func() {
		e := os.Remove(filepath.Join(lock, "owner.json"))
		if e == nil || errors.Is(e, os.ErrNotExist) {
			e = os.Remove(lock)
		}
		if err == nil && e != nil {
			err = e
		}
	}()
	return operation()
}
func coreAtomicWrite(file string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(file), 0700); e != nil {
		return e
	}
	temp := file + "." + coreUUID() + ".tmp"
	defer os.Remove(temp)
	f, e := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return coreRename(temp, file)
}
func coreRename(from, to string) error {
	var e error
	for n := 0; n < 50; n++ {
		e = os.Rename(from, to)
		if e == nil {
			return nil
		}
		if !errors.Is(e, os.ErrPermission) {
			return e
		}
		time.Sleep(25 * time.Millisecond)
	}
	return e
}
func (s *workspaceStore) replace(record map[string]any) error {
	if s.backend() == "sqlite" {
		return coreWriteSQL(s.sqlitePath(), record)
	}
	return coreAtomicWrite(s.jsonPath(), []byte(coreJSON(record)))
}
func (s *workspaceStore) write(record map[string]any, expected *int64) (map[string]any, error) {
	return s.commit(func() (map[string]any, error) {
		current, e := s.read()
		if e != nil {
			return nil, e
		}
		if expected != nil && (current == nil || coreNum(current["version"]) != *expected) {
			return nil, &VersionConflictError{}
		}
		next := int64(0)
		if current != nil {
			next = coreNum(current["version"]) + 1
		}
		record["version"] = next
		if e = s.replace(record); e != nil {
			return nil, e
		}
		return record, nil
	})
}
func (s *workspaceStore) initialize(data map[string]any) (map[string]any, error) {
	return s.commit(func() (map[string]any, error) {
		current, e := s.read()
		if e != nil {
			return nil, e
		}
		if current != nil {
			return current, nil
		}
		record := map[string]any{"id": "local_electron", "version": time.Now().UnixMilli(), "data": data}
		if e = s.createDatabase(record); e != nil {
			return nil, e
		}
		return record, nil
	})
}
func (s *workspaceStore) createDatabase(record map[string]any) error {
	temp := s.sqlitePath() + "." + coreUUID() + ".tmp"
	defer os.Remove(temp)
	if e := coreWriteSQL(temp, record); e != nil {
		return e
	}
	return coreRename(temp, s.sqlitePath())
}
func (s *workspaceStore) overwrite(data map[string]any) (map[string]any, error) {
	return s.commit(func() (map[string]any, error) {
		current, e := s.read()
		if e != nil {
			return nil, e
		}
		replacement := coreMap(coreClone(data))
		now := time.Now().UnixMilli()
		currentVersion := coreNum(current["version"])
		for _, v := range coreList(replacement["projects"]) {
			p := coreMap(v)
			prior := coreFind(coreList(coreMap(current["data"])["projects"]), p["id"])
			revision := max(now, currentVersion, coreNum(prior["revision"]))
			if coreSafeInt(p["revision"]) {
				revision = max(revision, coreNum(p["revision"]))
			}
			p["revision"] = revision + 1
		}
		record := map[string]any{"id": "local_electron", "version": max(now, currentVersion+1), "data": replacement}
		if current == nil {
			e = s.createDatabase(record)
		} else {
			e = s.replace(record)
		}
		return record, e
	})
}
func (s *workspaceStore) migrate() error {
	_, e := s.commit(func() (map[string]any, error) {
		if s.backend() == "sqlite" && coreExists(s.sqlitePath()) {
			return nil, nil
		}
		record, e := s.read()
		if e != nil {
			return nil, e
		}
		if record == nil {
			return nil, errors.New("请先初始化工作区")
		}
		temp := s.sqlitePath() + "." + coreUUID() + ".tmp"
		defer os.Remove(temp)
		if e = coreWriteSQL(temp, record); e != nil {
			return nil, e
		}
		r, e := coreReadSQL(temp)
		if e != nil {
			return nil, e
		}
		if !reflect.DeepEqual(coreClone(record), coreClone(r)) {
			return nil, errors.New("数据库迁移校验失败")
		}
		original, e := os.ReadFile(s.jsonPath())
		if e != nil {
			return nil, e
		}
		if e = coreAtomicWrite(fmt.Sprintf("%s.pre-sqlite-%d.bak", s.jsonPath(), time.Now().UnixMilli()), original); e != nil {
			return nil, e
		}
		return nil, coreRename(temp, s.sqlitePath())
	})
	return e
}

const coreSchema = `PRAGMA busy_timeout=15000;
 CREATE TABLE IF NOT EXISTS workspace (key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY,position INTEGER NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS requirements (project_id TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,scope,id));
 CREATE INDEX IF NOT EXISTS requirements_project ON requirements(project_id,scope,position);`

func coreOpenSQL(file string) (*sql.DB, error) {
	db, e := sql.Open("sqlite", file)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	if _, e = db.Exec(coreSchema); e != nil {
		db.Close()
		return nil, e
	}
	return db, nil
}
func coreReadSQL(file string) (map[string]any, error) {
	db, e := coreOpenSQL(file)
	if e != nil {
		return nil, e
	}
	defer db.Close()
	tx, e := db.Begin()
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	var text string
	e = tx.QueryRow("SELECT value FROM workspace WHERE key=?", "record").Scan(&text)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var record map[string]any
	if e = json.Unmarshal([]byte(text), &record); e != nil {
		return nil, e
	}
	data := coreMap(record["data"])
	projects := []any{}
	rows, e := tx.Query("SELECT data FROM projects ORDER BY position")
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		if e = rows.Scan(&text); e != nil {
			rows.Close()
			return nil, e
		}
		var p map[string]any
		if e = json.Unmarshal([]byte(text), &p); e != nil {
			rows.Close()
			return nil, e
		}
		projects = append(projects, p)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for _, v := range projects {
		p := coreMap(v)
		scopes := map[string][]any{"": {}}
		rows, e = tx.Query("SELECT scope,data FROM requirements WHERE project_id=? ORDER BY position", p["id"])
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var scope string
			if e = rows.Scan(&scope, &text); e != nil {
				rows.Close()
				return nil, e
			}
			var item map[string]any
			if e = json.Unmarshal([]byte(text), &item); e != nil {
				rows.Close()
				return nil, e
			}
			scopes[scope] = append(scopes[scope], item)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
		p["items"] = scopes[""]
		for _, bv := range coreList(p["batches"]) {
			b := coreMap(bv)
			values := scopes[coreString(b["id"])]
			if values == nil {
				values = []any{}
			}
			b["items"] = values
		}
	}
	data["projects"] = projects
	record["data"] = data
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return record, nil
}
func coreWriteSQL(file string, record map[string]any) error {
	db, e := coreOpenSQL(file)
	if e != nil {
		return e
	}
	defer db.Close()
	tx, e := db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	type retainedKey struct{ project, scope, id string }
	retained := map[retainedKey]bool{}
	retainedProjects := map[string]bool{}
	data := coreMap(record["data"])
	for position, v := range coreList(data["projects"]) {
		p := coreMap(v)
		retainedProjects[coreString(p["id"])] = true
		config := coreMap(coreClone(p))
		delete(config, "items")
		batches := []any{}
		for _, bv := range coreList(p["batches"]) {
			b := coreMap(coreClone(bv))
			delete(b, "items")
			batches = append(batches, b)
		}
		config["batches"] = batches
		if _, e = tx.Exec("INSERT INTO projects(id,position,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,data=excluded.data WHERE position<>excluded.position OR data<>excluded.data", p["id"], position, coreJSON(config)); e != nil {
			return e
		}
		scopes := []struct {
			id    string
			items []any
		}{{"", coreList(p["items"])}}
		for _, bv := range coreList(p["batches"]) {
			b := coreMap(bv)
			scopes = append(scopes, struct {
				id    string
				items []any
			}{coreString(b["id"]), coreList(b["items"])})
		}
		for _, scope := range scopes {
			for n, iv := range scope.items {
				i := coreMap(iv)
				retained[retainedKey{coreString(p["id"]), scope.id, coreString(i["id"])}] = true
				if _, e = tx.Exec("INSERT INTO requirements(project_id,scope,id,position,data) VALUES(?,?,?,?,?) ON CONFLICT(project_id,scope,id) DO UPDATE SET position=excluded.position,data=excluded.data WHERE position<>excluded.position OR data<>excluded.data", p["id"], scope.id, i["id"], n, coreJSON(i)); e != nil {
					return e
				}
			}
		}
	}
	rows, e := tx.Query("SELECT project_id,scope,id FROM requirements")
	if e != nil {
		return e
	}
	removed := []retainedKey{}
	for rows.Next() {
		var k retainedKey
		if e = rows.Scan(&k.project, &k.scope, &k.id); e != nil {
			rows.Close()
			return e
		}
		if !retained[k] {
			removed = append(removed, k)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, k := range removed {
		if _, e = tx.Exec("DELETE FROM requirements WHERE project_id=? AND scope=? AND id=?", k.project, k.scope, k.id); e != nil {
			return e
		}
	}
	rows, e = tx.Query("SELECT id FROM projects")
	if e != nil {
		return e
	}
	removedProjects := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		if !retainedProjects[id] {
			removedProjects = append(removedProjects, id)
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range removedProjects {
		if _, e = tx.Exec("DELETE FROM projects WHERE id=?", id); e != nil {
			return e
		}
	}
	saved := coreMap(coreClone(record))
	savedData := coreMap(saved["data"])
	delete(savedData, "projects")
	if _, e = tx.Exec("INSERT INTO workspace(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "record", coreJSON(saved)); e != nil {
		return e
	}
	return tx.Commit()
}
