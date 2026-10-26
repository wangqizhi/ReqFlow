package backendgo

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func syncOpenStore(file string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", file)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA busy_timeout=15000;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS remote_projects (id TEXT PRIMARY KEY, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS remote_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, event TEXT NOT NULL, time TEXT NOT NULL);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(file, 0600)
	return db, nil
}

func syncConfigSQLitePath(file string) string {
	if strings.HasSuffix(strings.ToLower(file), ".json") {
		return strings.TrimSuffix(file, filepath.Ext(file)) + ".sqlite"
	}
	return file
}

func syncReadConfigSQL(file string) (*syncServerConfig, error) {
	if !coreExists(file) {
		return nil, os.ErrNotExist
	}
	db, err := syncOpenStore(file)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	var raw string
	if err = db.QueryRow("SELECT value FROM settings WHERE key='config'").Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	var cfg syncServerConfig
	err = json.Unmarshal([]byte(raw), &cfg)
	return &cfg, err
}

func syncWriteConfigSQL(file string, cfg *syncServerConfig) error {
	db, err := syncOpenStore(syncConfigSQLitePath(file))
	if err != nil {
		return err
	}
	defer db.Close()
	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", string(raw))
	return err
}

func syncConfigBytes(cfg *syncServerConfig) ([]byte, error) {
	dir, err := os.MkdirTemp("", "reqflow-server-config-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "server-config.sqlite")
	if err = syncSaveConfig(file, cfg); err != nil {
		return nil, err
	}
	return os.ReadFile(file)
}

func (s *syncServer) openStore() (*sql.DB, error) {
	return syncOpenStore(filepath.Join(s.cfg.DataDir, "server.sqlite"))
}

func syncReadProjectSQL(tx *sql.Tx, id string) (*syncProjectRecord, error) {
	var raw string
	err := tx.QueryRow("SELECT record FROM remote_projects WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record syncProjectRecord
	err = json.Unmarshal([]byte(raw), &record)
	return &record, err
}

func syncWriteProjectSQL(tx *sql.Tx, record *syncProjectRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = tx.Exec("INSERT INTO remote_projects(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record", record.ID, string(raw))
	return err
}

// Import legacy JSON once; an existing SQLite record always wins on restart.
func (s *syncServer) migrateStore() error {
	db, err := s.openStore()
	if err != nil {
		return err
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var migrated string
	err = tx.QueryRow("SELECT value FROM settings WHERE key='legacyImported'").Scan(&migrated)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	files, err := filepath.Glob(filepath.Join(s.cfg.DataDir, "projects", "*.json"))
	if err != nil {
		return err
	}
	for _, file := range files {
		if strings.HasSuffix(file, ".events.json") {
			continue
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var record syncProjectRecord
		if err = json.Unmarshal(raw, &record); err != nil {
			return fmt.Errorf("迁移服务端项目 %s：%w", file, err)
		}
		if !syncProjectIDPattern.MatchString(record.ID) || record.Project == nil {
			return fmt.Errorf("迁移服务端项目数据无效：%s", file)
		}
		if _, err = tx.Exec("INSERT OR IGNORE INTO remote_projects(id,record) VALUES(?,?)", record.ID, string(raw)); err != nil {
			return err
		}
		var entries []map[string]any
		if coreExists(s.eventsPath(record.ID)) {
			if err = aiReadJSON(s.eventsPath(record.ID), &entries); err != nil {
				return err
			}
			for _, entry := range entries {
				if _, err = tx.Exec("INSERT INTO remote_events(project_id,event,time) VALUES(?,?,?)", record.ID, aiString(entry["event"]), aiString(entry["time"])); err != nil {
					return err
				}
			}
		}
	}
	if _, err = tx.Exec("INSERT INTO settings(key,value) VALUES('legacyImported','1')"); err != nil {
		return err
	}
	return tx.Commit()
}
