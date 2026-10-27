package backendgo

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

type WorkspaceService struct {
	store             *workspaceStore
	localOnly         bool
	completionVersion string
}

func NewWorkspaceService(dataDir string) *WorkspaceService {
	return &WorkspaceService{store: newWorkspaceStore(dataDir)}
}
func (s *WorkspaceService) StorageStatus() string { return s.store.backend() }
func (s *WorkspaceService) DataFile() string {
	if s.StorageStatus() == "sqlite" {
		return s.store.sqlitePath()
	}
	return s.store.jsonPath()
}
func (s *WorkspaceService) MigrateToSQLite() error { return s.store.migrate() }

var coreImagePattern = regexp.MustCompile(`^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+=*)$`)

func (s *WorkspaceService) materializeImages(state map[string]any) error {
	dir := filepath.Join(s.store.dir, "images")
	for _, pv := range coreList(state["projects"]) {
		p := coreMap(pv)
		items := append([]any{}, coreList(p["items"])...)
		for _, bv := range coreList(p["batches"]) {
			items = append(items, coreList(coreMap(bv)["items"])...)
		}
		for _, iv := range items {
			for _, av := range coreList(coreMap(iv)["attachments"]) {
				a := coreMap(av)
				match := coreImagePattern.FindStringSubmatch(coreString(a["dataUrl"]))
				if match == nil || !regexp.MustCompile(`^[a-zA-Z0-9-]+$`).MatchString(coreString(a["id"])) {
					return errors.New("图片附件数据无效")
				}
				bytes, e := base64.StdEncoding.DecodeString(match[2])
				if e != nil {
					bytes, e = base64.RawStdEncoding.DecodeString(match[2])
				}
				if e != nil {
					return errors.New("图片附件数据无效")
				}
				if e = os.MkdirAll(dir, 0700); e != nil {
					return e
				}
				a["path"] = filepath.Join(dir, coreString(a["id"])+"-"+coreHash(string(bytes))[:16]+"."+match[1])
				file := coreString(a["path"])
				if !coreExists(file) {
					if e = coreAtomicWrite(file, bytes); e != nil {
						return e
					}
				}
			}
		}
	}
	return nil
}
func (s *WorkspaceService) Get() (map[string]any, error) {
	record, e := s.store.read()
	if e != nil {
		return nil, e
	}
	if record == nil {
		record, e = s.store.initialize(map[string]any{"projects": []any{MakeProject("我的第一个项目", "")}})
		if e != nil {
			return nil, e
		}
	}
	record, warning := s.refreshRemote(record)
	state := coreMap(record["data"])
	if e = s.materializeImages(state); e != nil {
		return nil, e
	}
	return map[string]any{"state": NormalizeWorkspace(state), "version": coreNum(record["version"]), "warning": warning}, nil
}
func (s *WorkspaceService) Mutate(action map[string]any, expectedVersion *int64) (map[string]any, error) {
	if coreString(action["op"]) == "complete" && coreString(action["verificationVersion"]) == "" {
		copied := map[string]any{}
		for k, v := range action {
			copied[k] = v
		}
		action = copied
		action["verificationVersion"] = s.projectVersion(coreString(action["project"]))
		if coreString(action["verificationVersion"]) == "" {
			action["verificationVersion"] = s.completionVersion
		}
	}
	if result, handled, err := s.remoteMutate(action, expectedVersion); handled {
		if err == nil {
			result = s.remoteVerificationVersion(action, result)
		}
		return result, err
	}
	scopes := MutationProjectIDs(action)
	revisions, hasRevisions := action["expectedProjectVersions"]
	revisionMap, revisionOK := revisions.(map[string]any)
	if hasRevisions {
		if scopes == nil || !revisionOK {
			return nil, errors.New("项目并发版本参数无效")
		}
		for _, id := range scopes {
			if !coreSafeInt(revisionMap[id]) || coreNum(revisionMap[id]) < 0 {
				return nil, errors.New("项目并发版本参数无效")
			}
		}
		for id := range revisionMap {
			if !coreIn(id, scopes...) {
				return nil, errors.New("项目并发版本参数无效")
			}
		}
	}
	signatures, hasSignatures := action["expectedProjectSignatures"]
	signatureMap, signatureOK := signatures.(map[string]any)
	if hasSignatures {
		if !hasRevisions || !signatureOK {
			return nil, errors.New("项目内容校验参数无效")
		}
		for _, id := range scopes {
			str, ok := signatureMap[id].(string)
			if !ok || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(str) {
				return nil, errors.New("项目内容校验参数无效")
			}
		}
		for id := range signatureMap {
			if !coreIn(id, scopes...) {
				return nil, errors.New("项目内容校验参数无效")
			}
		}
	}
	attempts := 1
	if expectedVersion == nil || hasRevisions {
		attempts = 12
	}
	for n := 0; n < attempts; n++ {
		record, e := s.store.read()
		if e != nil {
			return nil, e
		}
		if record == nil {
			if _, e = s.Get(); e != nil {
				return nil, e
			}
			continue
		}
		state := NormalizeWorkspace(coreMap(record["data"]))
		if hasRevisions {
			for _, id := range scopes {
				p := coreFind(coreList(state["projects"]), id)
				if p == nil || coreNum(p["revision"]) != coreNum(revisionMap[id]) {
					return nil, &VersionConflictError{}
				}
				if hasSignatures && ProjectConcurrencyToken(p) != signatureMap[id] {
					return nil, &VersionConflictError{}
				}
			}
		} else if expectedVersion != nil && *expectedVersion != coreNum(record["version"]) {
			return nil, &VersionConflictError{}
		}
		if e = s.materializeImages(state); e != nil {
			return nil, e
		}
		if e = Apply(state, action); e != nil {
			return nil, e
		}
		if e = s.materializeImages(state); e != nil {
			return nil, e
		}
		expected := coreNum(record["version"])
		record["id"] = "local_electron"
		record["data"] = state
		next, e := s.store.write(record, &expected)
		if e == nil {
			result := map[string]any{"state": NormalizeWorkspace(coreMap(next["data"])), "version": coreNum(next["version"])}
			if warning := coreString(next["contextWarning"]); warning != "" {
				result["warning"] = warning
			}
			return result, nil
		}
		var conflict *VersionConflictError
		if !errors.As(e, &conflict) {
			return nil, e
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil, &VersionConflictError{}
}
func (s *WorkspaceService) ImportWorkspace(data any, replace bool) (map[string]any, error) {
	workspace := coreMap(data)
	if workspace["format"] == "reqflow-backup-v1" {
		workspace = coreMap(workspace["workspace"])
	} else if workspace["projects"] == nil {
		if exported, ok := workspace["workspace"].(map[string]any); ok {
			workspace = exported
		}
	}
	projects, ok := workspace["projects"].([]any)
	if !ok {
		return nil, errors.New("请使用 ReqFlow 导出的完整工作区 JSON。")
	}
	for _, v := range projects {
		p, ok := v.(map[string]any)
		if !ok {
			return nil, errors.New("请使用 ReqFlow 导出的完整工作区 JSON。")
		}
		if _, ok = p["id"].(string); !ok {
			return nil, errors.New("请使用 ReqFlow 导出的完整工作区 JSON。")
		}
		if _, ok = p["name"].(string); !ok {
			return nil, errors.New("请使用 ReqFlow 导出的完整工作区 JSON。")
		}
		if _, ok = p["items"].([]any); !ok {
			return nil, errors.New("请使用 ReqFlow 导出的完整工作区 JSON。")
		}
		if _, ok = p["batches"].([]any); !ok {
			return nil, errors.New("请使用 ReqFlow 导出的完整工作区 JSON。")
		}
	}
	current, e := s.store.read()
	if e != nil {
		return nil, e
	}
	if current != nil && !replace && len(coreList(NormalizeWorkspace(coreMap(current["data"]))["projects"])) > 0 {
		return nil, errors.New("当前已有工作区数据；如需覆盖请使用 --replace。")
	}
	if !s.localOnly && current != nil {
		for _, value := range coreList(coreMap(current["data"])["projects"]) {
			if aiString(coreMap(coreMap(value)["serverAgent"])["id"]) != "" {
				return nil, errors.New("恢复工作区备份前，请先中断关联项目的远程同步")
			}
		}
	}
	if e = s.materializeImages(workspace); e != nil {
		return nil, e
	}
	if _, e = s.store.overwrite(workspace); e != nil {
		return nil, e
	}
	return map[string]any{"projects": len(projects), "replaced": current != nil}, nil
}

// Archive/reporting operations retain optimistic revisions and all unknown fields.
func (s *WorkspaceService) WriteState(state map[string]any, expectedVersion int64) (map[string]any, error) {
	record, e := s.store.read()
	if e != nil {
		return nil, e
	}
	if record == nil || coreNum(record["version"]) != expectedVersion {
		return nil, &VersionConflictError{}
	}
	if !s.localOnly {
		var err error
		state, err = s.remoteReplaceFlows(record, state)
		if err != nil {
			return nil, err
		}
	}
	prior := coreList(coreMap(record["data"])["projects"])
	replacement := coreMap(coreClone(state))
	for _, v := range coreList(replacement["projects"]) {
		p := coreMap(v)
		old := coreFind(prior, p["id"])
		if old == nil {
			p["revision"] = int64(1)
		} else if coreJSON(old) != coreJSON(p) {
			p["revision"] = coreNum(old["revision"]) + 1
		}
	}
	if e = s.materializeImages(replacement); e != nil {
		return nil, e
	}
	record["data"] = replacement
	next, e := s.store.write(record, &expectedVersion)
	if e != nil {
		return nil, e
	}
	return map[string]any{"state": NormalizeWorkspace(coreMap(next["data"])), "version": coreNum(next["version"])}, nil
}
