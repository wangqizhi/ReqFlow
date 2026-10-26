package backendgo

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

func (s *syncServer) insertProject(record *syncProjectRecord) error {
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
	previous, err := syncReadProjectSQL(tx, record.ID)
	if err != nil {
		return err
	}
	if previous != nil {
		return errors.New("远程项目已存在")
	}
	if err = syncWriteProjectSQL(tx, record); err != nil {
		return err
	}
	return tx.Commit()
}

// Older snapshot servers kept attachment IDs without the image bytes. Recover
// only missing bytes for the same attachment ID from the original local backup.
func syncRecoverAttachmentBytes(project, backup map[string]any) bool {
	images := map[string]string{}
	var collect func(any)
	collect = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			if id, data := aiString(v["id"]), aiString(v["dataUrl"]); id != "" && coreImagePattern.MatchString(data) {
				images[id] = data
			}
			for _, child := range v {
				collect(child)
			}
		case []any:
			for _, child := range v {
				collect(child)
			}
		}
	}
	collect(backup)
	changed := false
	var recoverBytes func(any)
	recoverBytes = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			if data := images[aiString(v["id"])]; data != "" && aiString(v["dataUrl"]) == "" {
				v["dataUrl"] = data
				changed = true
			}
			for _, child := range v {
				recoverBytes(child)
			}
		case []any:
			for _, child := range v {
				recoverBytes(child)
			}
		}
	}
	recoverBytes(project)
	return changed
}

// Association seeds a missing project once. Existing remote data is authoritative.
func (s *syncServer) handleFlowAssociate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeJSON(w, 405, map[string]any{"ok": false})
		return
	}
	var input struct {
		ProjectID string         `json:"projectId"`
		Project   map[string]any `json:"project"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&input); err != nil || !syncProjectIDPattern.MatchString(input.ProjectID) || input.Project == nil {
		s.writeJSON(w, 400, map[string]any{"ok": false, "error": "项目数据无效"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.readProject(input.ProjectID)
	if err == nil && record == nil {
		project := syncFlowPayload(input.Project)
		project["id"] = input.ProjectID
		project["revision"] = int64(1)
		NormalizeWorkspace(map[string]any{"projects": []any{project}})
		record = &syncProjectRecord{ID: input.ProjectID, Name: aiString(project["name"]), Project: project, Revision: 1, UpdatedAt: coreNow()}
		err = s.insertProject(record)
	} else if err == nil && syncRecoverAttachmentBytes(record.Project, input.Project) {
		record.Revision++
		record.Project["revision"] = record.Revision
		record.UpdatedAt = coreNow()
		db, openErr := s.openStore()
		if openErr != nil {
			err = openErr
		} else {
			tx, beginErr := db.Begin()
			if beginErr != nil {
				err = beginErr
			} else {
				err = syncWriteProjectSQL(tx, record)
				if err == nil {
					err = tx.Commit()
				}
				_ = tx.Rollback()
			}
			_ = db.Close()
		}
	}
	if err != nil {
		s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.writeJSON(w, 200, map[string]any{"ok": true, "records": []*syncProjectRecord{record}})
}

func (s *syncServer) handleFlowMutate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeJSON(w, 405, map[string]any{"ok": false})
		return
	}
	var input struct {
		Action       map[string]any `json:"action"`
		Revisions    map[string]any `json:"revisions"`
		Replacements map[string]any `json:"replacements"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&input); err != nil {
		s.writeJSON(w, 400, map[string]any{"ok": false, "error": "操作数据无效"})
		return
	}
	scopes := MutationProjectIDs(input.Action)
	if len(input.Replacements) > 0 {
		scopes = []string{}
		for id := range input.Replacements {
			scopes = append(scopes, id)
		}
	} else if syncLocalOperation(aiString(input.Action["op"])) {
		scopes = nil
	}
	if len(scopes) == 0 {
		s.writeJSON(w, 400, map[string]any{"ok": false, "error": "不支持的远程 flow 操作"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	db, err := s.openStore()
	if err != nil {
		s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer db.Close()
	tx, err := db.Begin()
	if err != nil {
		s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	defer tx.Rollback()
	projects := []any{}
	for _, id := range scopes {
		if !syncProjectIDPattern.MatchString(id) {
			s.writeJSON(w, 400, map[string]any{"ok": false, "error": "项目 ID 无效"})
			return
		}
		record, readErr := syncReadProjectSQL(tx, id)
		if readErr != nil {
			s.writeJSON(w, 500, map[string]any{"ok": false, "error": readErr.Error()})
			return
		}
		if record == nil {
			s.writeJSON(w, 404, map[string]any{"ok": false, "error": "远程项目不存在"})
			return
		}
		if !coreSafeInt(input.Revisions[id]) || coreNum(input.Revisions[id]) != record.Revision {
			s.writeJSON(w, 409, map[string]any{"ok": false, "code": "VERSION_CONFLICT", "error": "远程项目已更新，请刷新后重试"})
			return
		}
		record.Project["revision"] = record.Revision
		projects = append(projects, record.Project)
	}
	state := map[string]any{"projects": projects}
	deleted := []string{}
	if len(input.Replacements) > 0 {
		projects = []any{}
		for _, id := range scopes {
			project := syncFlowPayload(coreMap(input.Replacements[id]))
			project["id"], project["revision"] = id, coreNum(input.Revisions[id])+1
			projects = append(projects, project)
		}
		state["projects"] = projects
	} else if input.Action["op"] == "deleteProject" {
		deleted = append(deleted, scopes[0])
		state["projects"] = []any{}
	} else if err = Apply(state, input.Action); err != nil {
		s.writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	records := []*syncProjectRecord{}
	for _, value := range coreList(state["projects"]) {
		p := syncFlowPayload(coreMap(value))
		record := &syncProjectRecord{ID: aiString(p["id"]), Name: aiString(p["name"]), Project: p, Revision: coreNum(p["revision"]), UpdatedAt: now}
		if err = syncWriteProjectSQL(tx, record); err != nil {
			s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		records = append(records, record)
	}
	for _, id := range deleted {
		if _, err = tx.Exec("DELETE FROM remote_projects WHERE id=?", id); err != nil {
			s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}
	for _, id := range scopes {
		if _, err = tx.Exec("INSERT INTO remote_events(project_id,event,time) VALUES(?,?,?)", id, aiString(input.Action["op"]), now); err != nil {
			s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
			return
		}
	}
	if err = tx.Commit(); err != nil {
		s.writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	s.writeJSON(w, 200, map[string]any{"ok": true, "records": records, "deleted": deleted})
}
