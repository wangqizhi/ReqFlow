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
	"sync"
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
	// 性能优化：缓存最近一次读取/写入的 SQLite 内容与各行 JSON，按文件修改时间与大小校验；
	// 其他进程（CLI）写入后文件戳变化即重新读取，写入时只更新内容有变化的行。
	mu    sync.Mutex
	cache *storeCache
}

type fileStamp struct{ mod, size int64 }
type sqlRow struct {
	position int
	data     string
}
type retainedKey struct{ project, scope, id string }
type sqlRows struct {
	projects map[string]sqlRow
	reqs     map[retainedKey]sqlRow
	record   string
}
type storeCache struct {
	stamp  fileStamp
	record map[string]any
	rows   *sqlRows
}

func coreFileStamp(p string) (fileStamp, bool) {
	info, e := os.Stat(p)
	if e != nil {
		return fileStamp{}, false
	}
	return fileStamp{info.ModTime().UnixNano(), info.Size()}, true
}

// loadSQLLocked 返回当前 SQLite 内容（缓存对象，调用方不得修改）；需持有 s.mu。
func (s *workspaceStore) loadSQLLocked() (*storeCache, error) {
	stamp, ok := coreFileStamp(s.sqlitePath())
	if ok && s.cache != nil && s.cache.stamp == stamp {
		return s.cache, nil
	}
	record, rows, e := coreReadSQLRows(s.sqlitePath())
	if e != nil {
		s.cache = nil
		return nil, e
	}
	if record == nil {
		s.cache = nil
		return &storeCache{}, nil
	}
	s.cache = &storeCache{stamp: stamp, record: record, rows: rows}
	return s.cache, nil
}
func (s *workspaceStore) invalidate() {
	s.mu.Lock()
	s.cache = nil
	s.mu.Unlock()
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
		s.mu.Lock()
		defer s.mu.Unlock()
		c, e := s.loadSQLLocked()
		if e != nil {
			return nil, e
		}
		if c.record == nil {
			return nil, errors.New("SQLite 工作区数据缺失")
		}
		return coreMap(coreDeepCopy(c.record)), nil
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
		// Windows can report ACCESS_DENIED while another writer's lock
		// directory is being removed (delete-pending), rather than EEXIST.
		// Treat this as bounded lock contention, preserving CAS below.
		if !errors.Is(e, os.ErrExist) && !errors.Is(e, os.ErrPermission) {
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
		defer s.invalidate()
		return coreWriteSQL(s.sqlitePath(), record)
	}
	return coreAtomicWrite(s.jsonPath(), []byte(coreJSON(record)))
}

// writeSQL 在写入锁内以缓存为基准做版本校验与增量写入（只写变化的行）。
func (s *workspaceStore) writeSQL(record map[string]any, expected *int64, dirty map[string]bool) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, e := s.loadSQLLocked()
	if e != nil {
		return nil, e
	}
	current := c.record
	if expected != nil && (current == nil || coreNum(current["version"]) != *expected) {
		return nil, &VersionConflictError{}
	}
	next := int64(0)
	if current != nil {
		next = coreNum(current["version"]) + 1
	}
	record["version"] = next
	if c.rows == nil {
		dirty = nil
	}
	rows, e := coreWriteSQLRowsScoped(s.sqlitePath(), record, c.rows, dirty)
	if e != nil {
		s.cache = nil
		return nil, e
	}
	if stamp, ok := coreFileStamp(s.sqlitePath()); ok {
		s.cache = &storeCache{stamp: stamp, record: coreMap(coreDeepCopy(record)), rows: rows}
	} else {
		s.cache = nil
	}
	return current, nil
}
func (s *workspaceStore) write(record map[string]any, expected *int64) (map[string]any, error) {
	return s.writeScoped(record, expected, nil)
}

// writeScoped 写入工作区；dirty 非空时只有其中的项目可能有变化，其余项目沿用已存储的行，
// 不再重新序列化（dirty 为 nil 表示全部比对）。
func (s *workspaceStore) writeScoped(record map[string]any, expected *int64, dirty map[string]bool) (map[string]any, error) {
	return s.commit(func() (map[string]any, error) {
		var current map[string]any
		var e error
		if s.backend() == "sqlite" {
			if current, e = s.writeSQL(record, expected, dirty); e != nil {
				return nil, e
			}
		} else {
			current, e = s.read()
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
		}
		oldContexts, newContexts := coreMap(coreMap(current)["data"])["contextPrompts"], coreMap(record["data"])["contextPrompts"]
		if coreJSON(oldContexts) != coreJSON(newContexts) {
			service := &WorkspaceService{store: s}
			if syncErr := service.syncContexts(coreMap(record["data"])); syncErr != nil {
				record["contextWarning"] = "上下文已保存，但目录或 Git 同步失败：" + syncErr.Error()
			}
		}
		// REQ-294：全局记忆随工作区更新，失败不影响本次保存。
		_ = refreshMemoryFiles(s.dir, coreMap(record["data"]))
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
	defer s.invalidate()
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
	defer s.invalidate()
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
	record, _, e := coreReadSQLRows(file)
	return record, e
}

// coreReadSQLRows 读取完整工作区，同时返回各行原始 JSON 供增量写入比对。
func coreReadSQLRows(file string) (map[string]any, *sqlRows, error) {
	db, e := coreOpenSQL(file)
	if e != nil {
		return nil, nil, e
	}
	defer db.Close()
	tx, e := db.Begin()
	if e != nil {
		return nil, nil, e
	}
	defer tx.Rollback()
	var text string
	e = tx.QueryRow("SELECT value FROM workspace WHERE key=?", "record").Scan(&text)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil, nil
	}
	if e != nil {
		return nil, nil, e
	}
	rows := &sqlRows{projects: map[string]sqlRow{}, reqs: map[retainedKey]sqlRow{}, record: text}
	var record map[string]any
	if e = json.Unmarshal([]byte(text), &record); e != nil {
		return nil, nil, e
	}
	data := coreMap(record["data"])
	projects := []any{}
	byID := map[string]map[string]any{}
	result, e := tx.Query("SELECT id,position,data FROM projects ORDER BY position")
	if e != nil {
		return nil, nil, e
	}
	for result.Next() {
		var id string
		var position int
		if e = result.Scan(&id, &position, &text); e != nil {
			result.Close()
			return nil, nil, e
		}
		var p map[string]any
		if e = json.Unmarshal([]byte(text), &p); e != nil {
			result.Close()
			return nil, nil, e
		}
		rows.projects[id] = sqlRow{position, text}
		p["items"] = []any{}
		byID[id] = p
		projects = append(projects, p)
	}
	e = result.Err()
	result.Close()
	if e != nil {
		return nil, nil, e
	}
	scopes := map[string]map[string][]any{}
	result, e = tx.Query("SELECT project_id,scope,id,position,data FROM requirements ORDER BY project_id,scope,position")
	if e != nil {
		return nil, nil, e
	}
	for result.Next() {
		var k retainedKey
		var position int
		if e = result.Scan(&k.project, &k.scope, &k.id, &position, &text); e != nil {
			result.Close()
			return nil, nil, e
		}
		rows.reqs[k] = sqlRow{position, text}
		var item map[string]any
		if e = json.Unmarshal([]byte(text), &item); e != nil {
			result.Close()
			return nil, nil, e
		}
		if scopes[k.project] == nil {
			scopes[k.project] = map[string][]any{}
		}
		scopes[k.project][k.scope] = append(scopes[k.project][k.scope], item)
	}
	e = result.Err()
	result.Close()
	if e != nil {
		return nil, nil, e
	}
	for id, p := range byID {
		own := scopes[id]
		if items := own[""]; items != nil {
			p["items"] = items
		}
		for _, bv := range coreList(p["batches"]) {
			b := coreMap(bv)
			values := own[coreString(b["id"])]
			if values == nil {
				values = []any{}
			}
			b["items"] = values
		}
	}
	data["projects"] = projects
	record["data"] = data
	if e = tx.Commit(); e != nil {
		return nil, nil, e
	}
	return record, rows, nil
}
func coreWriteSQL(file string, record map[string]any) error {
	_, e := coreWriteSQLRows(file, record, nil)
	return e
}

// coreWriteSQLRows 只写入与 prev（数据库当前各行 JSON）不同的行；prev 为空时先从数据库读取。
func coreWriteSQLRows(file string, record map[string]any, prev *sqlRows) (*sqlRows, error) {
	return coreWriteSQLRowsScoped(file, record, prev, nil)
}
func coreWriteSQLRowsScoped(file string, record map[string]any, prev *sqlRows, dirty map[string]bool) (*sqlRows, error) {
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
	if prev == nil {
		if prev, e = coreLoadSQLRows(tx); e != nil {
			return nil, e
		}
	}
	next := &sqlRows{projects: map[string]sqlRow{}, reqs: map[retainedKey]sqlRow{}}
	data := coreMap(record["data"])
	var prevByProject map[string][]retainedKey
	if dirty != nil {
		prevByProject = map[string][]retainedKey{}
		for k := range prev.reqs {
			prevByProject[k.project] = append(prevByProject[k.project], k)
		}
	}
	for position, v := range coreList(data["projects"]) {
		p := coreMap(v)
		id := coreString(p["id"])
		if old, ok := prev.projects[id]; ok && dirty != nil && !dirty[id] {
			// 未改动的项目：沿用已存储的行（位置变化时只更新位置）。
			next.projects[id] = sqlRow{position, old.data}
			if old.position != position {
				if _, e = tx.Exec("UPDATE projects SET position=? WHERE id=?", position, id); e != nil {
					return nil, e
				}
			}
			for _, k := range prevByProject[id] {
				next.reqs[k] = prev.reqs[k]
			}
			continue
		}
		config := make(map[string]any, len(p))
		for k, value := range p {
			if k != "items" {
				config[k] = value
			}
		}
		batches := []any{}
		for _, bv := range coreList(p["batches"]) {
			b := coreMap(bv)
			copied := make(map[string]any, len(b))
			for k, value := range b {
				if k != "items" {
					copied[k] = value
				}
			}
			batches = append(batches, copied)
		}
		config["batches"] = batches
		row := sqlRow{position, coreJSON(config)}
		next.projects[id] = row
		if old, ok := prev.projects[id]; !ok || old != row {
			if _, e = tx.Exec("INSERT INTO projects(id,position,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET position=excluded.position,data=excluded.data", p["id"], position, row.data); e != nil {
				return nil, e
			}
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
				k := retainedKey{id, scope.id, coreString(i["id"])}
				row := sqlRow{n, coreJSON(i)}
				next.reqs[k] = row
				if old, ok := prev.reqs[k]; !ok || old != row {
					if _, e = tx.Exec("INSERT INTO requirements(project_id,scope,id,position,data) VALUES(?,?,?,?,?) ON CONFLICT(project_id,scope,id) DO UPDATE SET position=excluded.position,data=excluded.data", p["id"], scope.id, i["id"], n, row.data); e != nil {
						return nil, e
					}
				}
			}
		}
	}
	for k := range prev.reqs {
		if _, ok := next.reqs[k]; !ok {
			if _, e = tx.Exec("DELETE FROM requirements WHERE project_id=? AND scope=? AND id=?", k.project, k.scope, k.id); e != nil {
				return nil, e
			}
		}
	}
	for id := range prev.projects {
		if _, ok := next.projects[id]; !ok {
			if _, e = tx.Exec("DELETE FROM projects WHERE id=?", id); e != nil {
				return nil, e
			}
		}
	}
	saved := make(map[string]any, len(record))
	for k, value := range record {
		saved[k] = value
	}
	savedData := make(map[string]any, len(data))
	for k, value := range data {
		if k != "projects" {
			savedData[k] = value
		}
	}
	saved["data"] = savedData
	next.record = coreJSON(saved)
	if next.record != prev.record {
		if _, e = tx.Exec("INSERT INTO workspace(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", "record", next.record); e != nil {
			return nil, e
		}
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return next, nil
}

// coreLoadSQLRows 读取各行原始 JSON（不解析），用于无缓存时的增量比对。
func coreLoadSQLRows(tx *sql.Tx) (*sqlRows, error) {
	rows := &sqlRows{projects: map[string]sqlRow{}, reqs: map[retainedKey]sqlRow{}}
	e := tx.QueryRow("SELECT value FROM workspace WHERE key=?", "record").Scan(&rows.record)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return nil, e
	}
	result, e := tx.Query("SELECT id,position,data FROM projects")
	if e != nil {
		return nil, e
	}
	for result.Next() {
		var id string
		var row sqlRow
		if e = result.Scan(&id, &row.position, &row.data); e != nil {
			result.Close()
			return nil, e
		}
		rows.projects[id] = row
	}
	if e = result.Err(); e != nil {
		result.Close()
		return nil, e
	}
	result.Close()
	result, e = tx.Query("SELECT project_id,scope,id,position,data FROM requirements")
	if e != nil {
		return nil, e
	}
	defer result.Close()
	for result.Next() {
		var k retainedKey
		var row sqlRow
		if e = result.Scan(&k.project, &k.scope, &k.id, &row.position, &row.data); e != nil {
			return nil, e
		}
		rows.reqs[k] = row
	}
	return rows, result.Err()
}
