package backendgo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

var syncBackupStatusMu sync.Mutex

func (s *WorkspaceService) recordRemoteBackup(serverID string, records []any) {
	syncBackupStatusMu.Lock()
	defer syncBackupStatusMu.Unlock()
	b := &Backend{DataDir: s.store.dir}
	status := b.syncReadStatus()
	entry := status[serverID]
	if entry == nil {
		entry = map[string]any{}
	}
	last := coreMap(entry["lastSync"])
	now := coreNow()
	for _, value := range records {
		last[aiString(coreMap(value)["id"])] = now
	}
	entry["lastSync"], entry["lastSyncError"] = last, nil
	status[serverID] = entry
	b.syncWriteStatus(status)
}

func syncLocalOperation(op string) bool {
	return coreIn(op, "projectSync", "projectDir", "projectRemote", "projectFolder", "verifySource", "publishScript")
}

func (s *WorkspaceService) localService() *WorkspaceService {
	return &WorkspaceService{store: s.store, localOnly: true}
}

func (s *WorkspaceService) remoteRequest(serverID, method, endpoint string, body any) (map[string]any, error) {
	b := &Backend{DataDir: s.store.dir, Workspace: s.localService()}
	if b.syncReadStatus()[serverID]["paused"] == true {
		return nil, errors.New("远程连接已手动断开；请重新连接，或中断项目远程同步后编辑本地备份")
	}
	agent, secret, err := b.syncAgentConfig(serverID)
	if err != nil {
		return nil, err
	}
	if aiString(agent["tlsMode"]) != "ca" && secret.Fingerprint == "" {
		return nil, errors.New("请先在 Server Agent 中确认服务端证书指纹")
	}
	client, _, err := syncBuildClient(agent, secret)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	var raw []byte
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return nil, err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, syncAgentBaseURL(agent)+endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+secret.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("远程操作失败，本地备份未修改；可中断远程同步后使用备份：%w", err)
	}
	defer response.Body.Close()
	raw, err = io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode == 409 {
		return nil, &VersionConflictError{}
	}
	if response.StatusCode == 404 && method == http.MethodPost && len(endpoint) >= 10 && endpoint[:10] == "/api/flow/" {
		return nil, errors.New("服务端版本不支持远程 flow 操作，请先更新远程 Server Agent")
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("远程服务端 HTTP %d：%s", response.StatusCode, syncResponseError(raw))
	}
	var result map[string]any
	if err = json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	if result["ok"] != true {
		return nil, errors.New("远程服务端返回无效结果")
	}
	return result, nil
}

func syncMergeRemote(project, remote map[string]any) {
	for key := range syncFlowPayload(project) {
		delete(project, key)
	}
	for key, value := range syncFlowPayload(remote) {
		project[key] = value
	}
}

// Archive/import operations that replace flow fields also execute a versioned
// transaction remotely before writing the acknowledged result to the backup.
func (s *WorkspaceService) remoteReplaceFlows(record, state map[string]any) (map[string]any, error) {
	state = coreMap(coreCloneAny(state))
	groups := map[string]map[string]any{}
	revisions := map[string]map[string]any{}
	for _, value := range coreList(coreMap(record["data"])["projects"]) {
		old := coreMap(value)
		association := coreMap(old["serverAgent"])
		serverID := aiString(association["id"])
		if serverID == "" {
			continue
		}
		id := aiString(old["id"])
		next := coreFind(coreList(state["projects"]), id)
		if next == nil || aiString(coreMap(next["serverAgent"])["id"]) != serverID {
			return nil, errors.New("请先中断远程同步，再恢复或移除关联项目")
		}
		before, after := syncFlowPayload(old), syncFlowPayload(next)
		delete(before, "revision")
		delete(after, "revision")
		if coreJSON(before) == coreJSON(after) {
			continue
		}
		if groups[serverID] == nil {
			groups[serverID] = map[string]any{}
			revisions[serverID] = map[string]any{}
		}
		groups[serverID][id] = after
		revisions[serverID][id] = association["remoteRevision"]
	}
	for serverID, replacements := range groups {
		result, err := s.remoteRequest(serverID, "POST", "/api/flow/mutate", map[string]any{"action": map[string]any{"op": "replaceFlow"}, "replacements": replacements, "revisions": revisions[serverID]})
		if err != nil {
			return nil, err
		}
		for _, value := range coreList(result["records"]) {
			r := coreMap(value)
			project := coreFind(coreList(state["projects"]), r["id"])
			if project == nil {
				continue
			}
			revision := project["revision"]
			syncMergeRemote(project, coreMap(r["project"]))
			project["revision"] = revision
			project["serverAgent"] = map[string]any{"id": serverID, "remoteRevision": r["revision"]}
		}
	}
	return state, nil
}

// Cache commits never execute a flow operation locally. Retry only the local
// backup write on CAS contention; never replay an acknowledged remote mutation.
func (s *WorkspaceService) cacheRemote(serverID string, records []any, deleted []any, link bool) (map[string]any, error) {
	for attempt := 0; attempt < 12; attempt++ {
		stored, err := s.store.read()
		if err != nil {
			return nil, err
		}
		if stored == nil {
			return nil, errors.New("本地备份不存在")
		}
		state := NormalizeWorkspace(coreMap(stored["data"]))
		changed := false
		for _, value := range records {
			record := coreMap(value)
			id := aiString(record["id"])
			project := coreFind(coreList(state["projects"]), id)
			if project == nil {
				continue
			}
			association := coreMap(project["serverAgent"])
			if !link && aiString(association["id"]) != serverID {
				continue
			}
			if !link && coreNum(association["remoteRevision"]) > coreNum(record["revision"]) {
				continue
			}
			before := ProjectConcurrencyToken(project)
			revision := coreNum(project["revision"])
			syncMergeRemote(project, coreMap(record["project"]))
			project["serverAgent"] = map[string]any{"id": serverID, "remoteRevision": record["revision"]}
			project["revision"] = revision
			if before != ProjectConcurrencyToken(project) {
				project["revision"] = revision + 1
				changed = true
			}
		}
		for _, id := range deleted {
			project := coreFind(coreList(state["projects"]), id)
			if project != nil && aiString(coreMap(project["serverAgent"])["id"]) == serverID {
				state["projects"] = coreRemove(coreList(state["projects"]), id)
				changed = true
			}
		}
		if err = s.materializeImages(state); err != nil {
			return nil, err
		}
		if !changed {
			return map[string]any{"state": state, "version": coreNum(stored["version"])}, nil
		}
		version := coreNum(stored["version"])
		stored["data"] = state
		next, err := s.store.write(stored, &version)
		if err == nil {
			s.recordRemoteBackup(serverID, records)
			return map[string]any{"state": NormalizeWorkspace(coreMap(next["data"])), "version": coreNum(next["version"])}, nil
		}
		var conflict *VersionConflictError
		if !errors.As(err, &conflict) {
			return nil, err
		}
	}
	return nil, &VersionConflictError{}
}

func (s *WorkspaceService) refreshRemote(record map[string]any) (map[string]any, string) {
	if s.localOnly {
		return record, ""
	}
	warning := ""
	for _, value := range coreList(coreMap(record["data"])["projects"]) {
		p := coreMap(value)
		serverID := aiString(coreMap(p["serverAgent"])["id"])
		if serverID == "" {
			continue
		}
		var result map[string]any
		var err error
		if _, known := coreMap(p["serverAgent"])["remoteRevision"]; !known {
			// Upgrade an existing association without replacing server-owned flow.
			var associated map[string]any
			associated, err = s.remoteRequest(serverID, "POST", "/api/flow/associate", map[string]any{"projectId": p["id"], "project": syncFlowPayload(p)})
			if err == nil {
				records := coreList(associated["records"])
				if len(records) != 1 {
					err = errors.New("远程项目关联返回无效数据")
				} else {
					result = coreMap(records[0])
				}
			}
		} else {
			result, err = s.remoteRequest(serverID, "GET", "/api/sync/project?id="+url.QueryEscape(aiString(p["id"])), nil)
		}
		if err == nil {
			result["id"] = p["id"]
			_, err = s.cacheRemote(serverID, []any{result}, nil, false)
		}
		if err != nil {
			warning = "远程暂不可用，当前显示本地备份；修改 flow 前请恢复连接或中断远程同步：" + err.Error()
		}
	}
	latest, err := s.store.read()
	if err == nil && latest != nil {
		return latest, warning
	}
	return record, warning
}

func (s *WorkspaceService) remoteMutate(action map[string]any, expected *int64) (map[string]any, bool, error) {
	if s.localOnly {
		return nil, false, nil
	}
	scopes := MutationProjectIDs(action)
	if len(scopes) == 0 {
		return nil, false, nil
	}
	stored, err := s.store.read()
	if err != nil {
		return nil, true, err
	}
	if stored == nil {
		return nil, false, nil
	}
	state := NormalizeWorkspace(coreMap(stored["data"]))
	serverID := ""
	for _, id := range scopes {
		p := coreFind(coreList(state["projects"]), id)
		if p == nil {
			continue
		}
		if candidate := aiString(coreMap(p["serverAgent"])["id"]); candidate != "" {
			serverID = candidate
			break
		}
	}
	linking := action["op"] == "projectSync" && action["server"] != nil && action["server"] != ""
	if linking {
		serverID = aiString(action["server"])
		if serverID == "" {
			serverID = aiString(coreMap(action["server"])["id"])
		}
	}
	if serverID == "" || (syncLocalOperation(aiString(action["op"])) && !linking) {
		return nil, false, nil
	}
	if versions, ok := action["expectedProjectVersions"]; ok {
		m, valid := versions.(map[string]any)
		if !valid {
			return nil, true, errors.New("项目并发版本参数无效")
		}
		for _, id := range scopes {
			p := coreFind(coreList(state["projects"]), id)
			if p == nil || !coreSafeInt(m[id]) || coreNum(m[id]) != coreNum(p["revision"]) {
				return nil, true, &VersionConflictError{}
			}
			if signatures, exists := action["expectedProjectSignatures"]; exists && coreMap(signatures)[id] != ProjectConcurrencyToken(p) {
				return nil, true, &VersionConflictError{}
			}
		}
	} else if expected != nil && *expected != coreNum(stored["version"]) {
		return nil, true, &VersionConflictError{}
	}
	if linking {
		p := coreFind(coreList(state["projects"]), scopes[0])
		if p == nil {
			return nil, true, errors.New("项目不存在")
		}
		payload := syncFlowPayload(p)
		if aiString(payload["baselineTemplate"]) == "" && aiString(state["baselineTemplate"]) != "" {
			payload["baselineTemplate"] = state["baselineTemplate"]
		}
		result, err := s.remoteRequest(serverID, "POST", "/api/flow/associate", map[string]any{"projectId": p["id"], "project": payload})
		if err != nil {
			return nil, true, err
		}
		cached, err := s.cacheRemote(serverID, coreList(result["records"]), nil, true)
		return cached, true, err
	}
	if action["op"] == "deleteProject" && len(coreList(state["projects"])) <= 1 {
		return nil, true, errors.New("至少保留一个项目，最后一个项目不可删除")
	}
	revisions := map[string]any{}
	for _, id := range scopes {
		p := coreFind(coreList(state["projects"]), id)
		if p == nil || aiString(coreMap(p["serverAgent"])["id"]) != serverID {
			return nil, true, errors.New("跨本地或不同服务器移动需求前，请先中断远程同步")
		}
		revisions[id] = coreMap(p["serverAgent"])["remoteRevision"]
	}
	result, err := s.remoteRequest(serverID, "POST", "/api/flow/mutate", map[string]any{"action": action, "revisions": revisions})
	if err != nil {
		return nil, true, err
	}
	cached, err := s.cacheRemote(serverID, coreList(result["records"]), coreList(result["deleted"]), false)
	if err != nil {
		return nil, true, fmt.Errorf("操作已在远程完成，但本地备份更新失败；请刷新，勿重复提交：%w", err)
	}
	return cached, true, nil
}
