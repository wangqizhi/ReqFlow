package backendgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Import uses an isolated fetch: never call syncBackup, which uploads the local
// workspace before a user has had a chance to restore their remote copy.
func (b *Backend) importBackup(values ...any) (map[string]any, error) {
	var next map[string]any
	var err error
	if len(values) > 0 {
		next, err = aiValidateBackup(values[0])
		if err != nil {
			return nil, err
		}
	}
	s := b.backupState()
	s.mu.Lock()
	if s.status["running"] == true {
		s.mu.Unlock()
		return nil, errors.New("备份操作正在进行，请稍候")
	}
	settings := aiCloneMap(s.settings)
	if next != nil {
		settings = next
	}
	if aiString(settings["url"]) == "" {
		s.mu.Unlock()
		return nil, errors.New("请先配置备份仓库")
	}
	// Save and acquire the operation lock together. Enabling auto-sync in the
	// form must not allow the ticker to upload before the import starts.
	if next != nil {
		if err = aiWriteJSON(filepath.Join(b.DataDir, "backup-settings.json"), next); err != nil {
			s.mu.Unlock()
			return nil, err
		}
		s.settings = aiCloneMap(next)
	}
	s.status["running"] = true
	s.mu.Unlock()
	counts, err := b.performBackupImport(settings)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status["running"] = false
	if err != nil {
		s.status["error"] = err.Error()
		return map[string]any{"ok": false, "error": err.Error(), "settings": settings, "status": aiCloneMap(s.status)}, nil
	}
	delete(s.status, "error")
	counts["ok"], counts["status"] = true, aiCloneMap(s.status)
	counts["settings"] = settings
	return counts, nil
}

func (b *Backend) performBackupImport(settings map[string]any) (map[string]any, error) {
	// Capture the workspace version before the network request. A concurrent CLI
	// or editor mutation must make the final write fail rather than disappear.
	current, err := b.Workspace.Get()
	if err != nil {
		return nil, err
	}
	repo, err := os.MkdirTemp("", "reqflow-backup-import-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(repo)
	git := func(args ...string) (string, error) { return RunRemoteGit(args, repo, settings) }
	if _, err = git("init"); err != nil {
		return nil, err
	}
	if _, err = git("fetch", "--depth=1", "--", aiString(settings["url"]), "refs/heads/"+aiString(settings["branch"])); err != nil {
		return nil, fmt.Errorf("读取远端备份失败：%w", err)
	}
	raw, err := git("show", "FETCH_HEAD:reqflow-backup.json")
	if err != nil {
		return nil, fmt.Errorf("远端分支缺少可读取的 reqflow-backup.json：%w", err)
	}
	var payload map[string]any
	if err = json.Unmarshal([]byte(raw), &payload); err != nil || payload["format"] != "reqflow-backup-v1" {
		return nil, errors.New("远端文件不是有效的 ReqFlow 备份")
	}
	state, counts, err := mergeBackupWorkspace(desktopMap(current["state"]), desktopMap(payload["workspace"]))
	if err != nil {
		return nil, err
	}
	if counts["projects"] == 0 && counts["items"] == 0 && coreJSON(state) == coreJSON(current["state"]) {
		return counts, nil
	}
	// Keep a recoverable copy even though same-ID local content wins the merge.
	if err = desktopAtomicJSON(filepath.Join(b.DataDir, "before-remote-import.json"), map[string]any{"format": "reqflow-backup-v1", "workspace": current["state"]}); err != nil {
		return nil, err
	}
	if _, err = b.Workspace.WriteState(state, desktopInt(current["version"])); err != nil {
		return nil, err
	}
	return counts, nil
}

func mergeBackupWorkspace(local, incoming map[string]any) (map[string]any, map[string]any, error) {
	projects, ok := incoming["projects"].([]any)
	if !ok {
		return nil, nil, errors.New("备份缺少完整工作区 projects")
	}
	// Validate identities before making any changes. Imported execution locks
	// belong to another runFile/machine and must never be activated here.
	incoming = desktopMap(coreClone(incoming))
	projects = desktopList(incoming["projects"])
	seenProjects := map[string]bool{}
	for _, pv := range projects {
		p := desktopMap(pv)
		id := desktopString(p["id"])
		_, itemsOK := p["items"].([]any)
		_, batchesOK := p["batches"].([]any)
		if id == "" || seenProjects[id] || strings.TrimSpace(desktopString(p["name"])) == "" || !itemsOK || !batchesOK {
			return nil, nil, errors.New("备份项目结构或标识无效")
		}
		seenProjects[id] = true
		for _, key := range []string{"items", "batches"} {
			seen := map[string]bool{}
			for _, value := range desktopList(p[key]) {
				entry := desktopMap(value)
				id := desktopString(entry["id"])
				if id == "" || seen[id] {
					return nil, nil, errors.New("备份需求或批次标识无效")
				}
				seen[id] = true
				delete(entry, "aiExecution")
				if key == "batches" {
					for _, snapshot := range desktopList(entry["items"]) {
						delete(desktopMap(snapshot), "aiExecution")
					}
				}
			}
		}
	}
	state := desktopMap(coreClone(local))
	addedProjects, addedItems := 0, 0
	for _, key := range []string{"folders", "contextPrompts"} {
		entries := desktopList(state[key])
		for _, value := range desktopList(incoming[key]) {
			entry := desktopMap(value)
			if id := desktopString(entry["id"]); id != "" && coreFind(entries, id) == nil {
				entries = append(entries, entry)
			}
		}
		if len(entries) > 0 {
			state[key] = entries
		}
	}
	for _, key := range []string{"baselineTemplate", "publishTemplate", "corePromptTemplate"} {
		if !coreHas(state, key) && coreHas(incoming, key) {
			state[key] = incoming[key]
		}
	}
	all := desktopList(state["projects"])
	for _, pv := range projects {
		p := desktopMap(pv)
		target := coreFind(all, p["id"])
		if target == nil {
			all = append(all, p)
			addedProjects++
			addedItems += len(desktopList(p["items"]))
			target = p
		} else {
			items := desktopList(target["items"])
			usedNumbers := map[string]bool{}
			next := desktopInt(target["nextNumber"])
			if next < 1 {
				next = 1
			}
			for _, iv := range items {
				number := desktopString(desktopMap(iv)["number"])
				usedNumbers[number] = true
				if n, _ := strconv.ParseInt(strings.TrimPrefix(number, "REQ-"), 10, 64); n >= next {
					next = n + 1
				}
			}
			for _, iv := range desktopList(p["items"]) {
				i := desktopMap(iv)
				if coreFind(items, i["id"]) != nil {
					continue
				}
				number := desktopString(i["number"])
				if number == "" || usedNumbers[number] {
					for usedNumbers[fmt.Sprintf("REQ-%03d", next)] {
						next++
					}
					i["number"] = fmt.Sprintf("REQ-%03d", next)
					next++
				}
				usedNumbers[desktopString(i["number"])] = true
				items = append(items, i)
				addedItems++
			}
			target["items"] = items
			batches := desktopList(target["batches"])
			for _, bv := range desktopList(p["batches"]) {
				if coreFind(batches, desktopMap(bv)["id"]) == nil {
					batches = append(batches, bv)
				}
			}
			target["batches"] = batches
		}
		// Repair the counter for new and merged projects, including sparse numbers.
		next := desktopInt(target["nextNumber"])
		if next < 1 {
			next = 1
		}
		for _, iv := range desktopList(target["items"]) {
			if n, _ := strconv.ParseInt(strings.TrimPrefix(desktopString(desktopMap(iv)["number"]), "REQ-"), 10, 64); n >= next {
				next = n + 1
			}
		}
		target["nextNumber"] = next
	}
	state["projects"] = all
	return NormalizeWorkspace(state), map[string]any{"projects": addedProjects, "items": addedItems}, nil
}
