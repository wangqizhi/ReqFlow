package backendgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
)

func coreCLIPreview(s string, n int) string {
	r := utf16.Encode([]rune(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(utf16.Decode(r))
}
func coreCLIHelp(version string) map[string]any {
	var h map[string]any
	_ = json.Unmarshal([]byte(coreCLIHelpJSON), &h)
	lines := []string{"ReqFlow v" + version + " — CLI 命令参考", "用法：" + coreString(h["usage"]), "", "全局选项："}
	for _, v := range coreList(h["options"]) {
		o := coreMap(v)
		name := coreString(o["name"])
		padding := 18 - len(utf16.Encode([]rune(name)))
		if padding < 0 {
			padding = 0
		}
		lines = append(lines, "  "+name+strings.Repeat(" ", padding)+" "+coreString(o["desc"]))
	}
	for _, v := range coreList(h["groups"]) {
		g := coreMap(v)
		lines = append(lines, "", "## "+coreString(g["group"])+" — "+coreString(g["desc"]))
		for _, v := range coreList(g["commands"]) {
			c := coreMap(v)
			lines = append(lines, "  "+coreString(c["name"])+" "+coreString(c["args"]), "      "+coreString(c["desc"]))
			if coreTruthy(c["example"]) {
				lines = append(lines, "      例："+coreString(c["example"]))
			}
		}
	}
	lines = append(lines, "", "说明：")
	for _, v := range coreList(h["notes"]) {
		lines = append(lines, "  - "+coreString(v))
	}
	h["text"] = strings.Join(lines, "\n")
	return h
}
func coreCLIItem(i map[string]any) map[string]any {
	r := map[string]any{"archived": coreTruthy(i["archived"]), "executor": coreExecutor(i), "bodyPreview": coreCLIPreview(coreString(i["body"]), 120)}
	for _, k := range []string{"id", "number", "title", "type", "priority", "status", "version", "executionVersion", "completionNote", "completionNoteVersion", "scheduledDate", "aiValidation", "deliveryGuidance", "link", "criteria", "aiExecution"} {
		if v, ok := i[k]; ok {
			r[k] = v
		}
	}
	return r
}
func coreCLIBatch(b map[string]any) map[string]any {
	r := map[string]any{}
	for _, k := range []string{"id", "number", "mode", "status", "hash", "guideVersion", "time"} {
		if v, ok := b[k]; ok {
			r[k] = v
		}
	}
	r["submittedAt"] = nil
	if coreTruthy(b["submittedAt"]) {
		r["submittedAt"] = b["submittedAt"]
	}
	items := []any{}
	for _, v := range coreList(b["items"]) {
		i := coreMap(v)
		items = append(items, map[string]any{"id": i["id"], "number": i["number"], "title": i["title"]})
	}
	r["items"] = items
	return r
}
func coreCLIProject(state map[string]any, id string) (map[string]any, error) {
	if id == "" {
		return nil, errors.New("缺少 --project <项目ID>（可先运行 project list 获取）")
	}
	p := coreFind(coreList(state["projects"]), id)
	if p == nil {
		return nil, errors.New("项目不存在：" + id)
	}
	return p, nil
}
func coreCLIRequireItem(p map[string]any, id string) (map[string]any, error) {
	if id == "" {
		return nil, errors.New("缺少 --id <需求ID>")
	}
	i := coreFind(coreList(p["items"]), id)
	if i == nil {
		return nil, errors.New("需求不存在：" + id)
	}
	return i, nil
}

func RunCLI(argv []string, version, dataDir string, stdout io.Writer) int {
	a := map[string]any{}
	positionals := []string{}
	for n := 0; n < len(argv); n++ {
		v := argv[n]
		if v == "--help" || v == "-h" {
			a["help"] = true
		} else if strings.HasPrefix(v, "--") {
			parts := strings.SplitN(strings.TrimPrefix(v, "--"), "=", 2)
			value := "true"
			if len(parts) == 2 {
				value = parts[1]
			} else if n+1 < len(argv) && !strings.HasPrefix(argv[n+1], "--") {
				n++
				value = argv[n]
			}
			a[parts[0]] = value
		} else {
			positionals = append(positionals, v)
		}
	}
	if coreTruthy(a["data-dir"]) {
		dataDir = coreString(a["data-dir"])
	}
	service := NewWorkspaceService(dataDir)
	var result map[string]any
	var e error
	if coreTruthy(a["help"]) {
		result = coreCLIHelp(version)
	} else {
		result, e = coreCLIDispatch(service, strings.Join(positionals, " "), a, version)
	}
	code := 0
	if e != nil {
		errCode := "ERROR"
		var conflict *VersionConflictError
		if errors.As(e, &conflict) {
			errCode = "VERSION_CONFLICT"
		}
		result = map[string]any{"ok": false, "error": e.Error(), "code": errCode}
		code = 1
	} else {
		if result == nil {
			result = map[string]any{}
		}
		result["ok"] = true
	}
	text := coreJSON(result)
	if coreTruthy(a["pretty"]) {
		var b any
		_ = json.Unmarshal([]byte(text), &b)
		v, _ := json.MarshalIndent(b, "", "  ")
		text = string(v)
	}
	_, _ = io.WriteString(stdout, text+"\n")
	if coreTruthy(a["out"]) {
		_ = os.WriteFile(coreString(a["out"]), []byte(text+"\n"), 0600)
	}
	return code
}
func coreCLIDispatch(s *WorkspaceService, command string, a map[string]any, version string) (map[string]any, error) {
	switch command {
	case "context list":
		r, e := s.Get()
		if e != nil {
			return nil, e
		}
		return map[string]any{"contexts": coreMap(r["state"])["contextPrompts"]}, nil
	case "context put":
		body := coreString(a["body"])
		if file := coreString(a["file"]); file != "" {
			raw, e := os.ReadFile(file)
			if e != nil {
				return nil, e
			}
			body = string(raw)
		}
		tags := []any{}
		for _, tag := range strings.Split(coreString(a["tags"]), ",") {
			if strings.TrimSpace(tag) != "" {
				tags = append(tags, strings.TrimSpace(tag))
			}
		}
		action := map[string]any{"op": "contextPrompt", "id": a["id"], "title": a["title"], "body": body, "tags": tags}
		if _, ok := a["project"]; ok {
			action["projectId"], action["feature"] = coreString(a["project"]), coreString(a["feature"])
		} else if a["feature"] != nil {
			return nil, errors.New("--feature 需要同时提供 --project")
		}
		return s.Mutate(action, nil)
	case "context settings":
		return s.contextSettings()
	case "context migrate":
		return s.moveContexts(coreString(a["dir"]))

	case "version":
		return map[string]any{"app": "ReqFlow", "capabilities": []any{"scheduled-ai-complete", "plugin-release-v1", "ai-execution-claim-v1"}, "version": version, "dataFile": s.DataFile(), "storageBackend": s.StorageStatus(), "protocol": "workspace-json-v1"}, nil
	case "plugin version", "plugin bundle":
		return pluginRelease(command, a)
	case "execution claim":
		var claims []any
		if err := json.Unmarshal([]byte(coreString(a["claims"])), &claims); err != nil {
			return nil, errors.New("--claims 需要 JSON 数组")
		}
		r, err := s.Mutate(map[string]any{"op": "executionClaim", "project": a["project"], "claims": claims, "run": a["run"], "client": a["client"]}, nil)
		if err != nil {
			return nil, err
		}
		p, err := coreCLIProject(coreMap(r["state"]), coreString(a["project"]))
		if err != nil {
			return nil, err
		}
		owned, skipped := []any{}, []any{}
		for _, v := range claims {
			request := coreMap(v)
			i := coreFind(coreList(p["items"]), request["id"])
			e := ActiveAIExecution(i)
			if e != nil && e["runId"] == a["run"] && e["client"] == a["client"] {
				owned = append(owned, i)
			} else {
				skipped = append(skipped, map[string]any{"id": request["id"], "reason": "任务已被其他 AI 领取，或排期内容已变化"})
			}
		}
		return map[string]any{"project": p, "items": owned, "skipped": skipped, "version": r["version"]}, nil
	case "execution release":
		r, err := s.Mutate(map[string]any{"op": "executionRelease", "project": a["project"], "id": a["id"], "run": a["run"], "note": a["note"]}, nil)
		if err != nil {
			return nil, err
		}
		return map[string]any{"version": r["version"]}, nil
	case "help":
		return coreCLIHelp(version), nil
	case "workspace get":
		return s.Get()
	case "workspace export":
		r, e := s.Get()
		if e != nil {
			return nil, e
		}
		return map[string]any{"version": r["version"], "workspace": r["state"]}, nil
	case "workspace import":
		if !coreTruthy(a["file"]) {
			return nil, errors.New("缺少 --file <path>")
		}
		b, e := os.ReadFile(coreString(a["file"]))
		if e != nil {
			return nil, e
		}
		var data any
		if e = json.Unmarshal(b, &data); e != nil {
			return nil, e
		}
		return s.ImportWorkspace(data, a["replace"] == true || a["replace"] == "true")
	case "project create":
		r, e := s.Mutate(map[string]any{"op": "project", "name": a["name"], "description": coreString(a["description"])}, nil)
		if e != nil {
			return nil, e
		}
		projects := coreList(coreMap(r["state"])["projects"])
		p := coreMap(projects[len(projects)-1])
		return map[string]any{"project": map[string]any{"id": p["id"], "name": p["name"]}, "version": r["version"]}, nil
	case "project delete":
		r, e := s.Mutate(map[string]any{"op": "deleteProject", "project": a["project"]}, nil)
		if e != nil {
			return nil, e
		}
		return map[string]any{"deleted": a["project"], "remaining": len(coreList(coreMap(r["state"])["projects"])), "version": r["version"]}, nil
	case "guidance set":
		action := map[string]any{"op": "guidance", "project": a["project"], "text": a["text"]}
		if coreHas(a, "delivery") {
			action["deliveryGuidance"] = a["delivery"]
		}
		r, e := s.Mutate(action, nil)
		if e != nil {
			return nil, e
		}
		p, e := coreCLIProject(coreMap(r["state"]), coreString(a["project"]))
		if e != nil {
			return nil, e
		}
		return map[string]any{"guideVersion": p["guideVersion"], "version": r["version"]}, nil
	case "item add", "item edit":
		action := map[string]any{"op": "item", "project": a["project"]}
		if command == "item edit" {
			if !coreTruthy(a["id"]) {
				return nil, errors.New("缺少 --id <需求ID>")
			}
			action["id"] = a["id"]
		}
		for _, k := range []string{"title", "body", "type", "priority", "executor"} {
			if coreHas(a, k) {
				action[k] = a[k]
			}
		}
		if coreHas(a, "criteria") {
			criteria := []string{}
			for _, v := range strings.Split(strings.ReplaceAll(coreString(a["criteria"]), ";", "\n"), "\n") {
				if strings.TrimSpace(v) != "" {
					criteria = append(criteria, strings.TrimSpace(v))
				}
			}
			action["criteria"] = strings.Join(criteria, "\n")
		}
		if coreHas(a, "delivery") {
			action["deliveryGuidance"] = a["delivery"]
		}
		if coreHas(a, "date") {
			action["scheduledDate"] = a["date"]
		}
		r, e := s.Mutate(action, nil)
		if e != nil {
			return nil, e
		}
		p, e := coreCLIProject(coreMap(r["state"]), coreString(a["project"]))
		if e != nil {
			return nil, e
		}
		items := coreList(p["items"])
		i := coreFind(items, a["id"])
		if command == "item add" {
			i = coreMap(items[len(items)-1])
		}
		if i == nil {
			return nil, errors.New("需求不存在")
		}
		return map[string]any{"item": coreCLIItem(i), "version": r["version"]}, nil
	case "generate":
		if !coreTruthy(a["items"]) {
			return nil, errors.New("缺少 --items <id1,id2,...>")
		}
		ids := []any{}
		for _, v := range strings.Split(coreString(a["items"]), ",") {
			if strings.TrimSpace(v) != "" {
				ids = append(ids, strings.TrimSpace(v))
			}
		}
		r, e := s.Mutate(map[string]any{"op": "generate", "project": a["project"], "ids": ids}, nil)
		if e != nil {
			return nil, e
		}
		p, e := coreCLIProject(coreMap(r["state"]), coreString(a["project"]))
		if e != nil {
			return nil, e
		}
		b := coreMap(coreList(p["batches"])[0])
		return map[string]any{"batch": coreCLIBatch(b), "prompt": b["text"], "promptLength": len(utf16.Encode([]rune(coreString(b["text"])))), "version": r["version"]}, nil
	case "submit", "cancel", "complete", "item completion-note", "revert", "verify", "regress", "archive":
		action := map[string]any{"op": command, "project": a["project"], "id": a["id"], "note": coreString(a["note"]), "link": coreString(a["link"]), "run": a["run"]}
		if command == "item completion-note" {
			action["op"] = "completionNote"
			if !coreHas(a, "summary") {
				return nil, errors.New("缺少 --summary <50字内完成说明>")
			}
		}
		if coreHas(a, "summary") {
			action["summary"] = a["summary"]
		}
		if command == "submit" || command == "cancel" {
			if !coreTruthy(a["batch"]) {
				return nil, errors.New("缺少 --batch <批次ID>")
			}
		}
		if coreHas(a, "batch") {
			action["batch"] = a["batch"]
		}
		if coreHas(a, "item-version") {
			n, e := strconv.ParseFloat(coreString(a["item-version"]), 64)
			if e != nil {
				n = -1
			}
			action["version"] = n
		}
		if command == "verify" {
			v := coreString(a["pass"])
			if !coreHas(a, "pass") {
				return nil, errors.New("缺少 --pass <true|false>")
			}
			if !coreIn(v, "true", "1", "false", "0") {
				return nil, fmt.Errorf("布尔参数无效：%s（应为 true/false）", v)
			}
			action["pass"] = v == "true" || v == "1"
		}
		r, e := s.Mutate(action, nil)
		if e != nil {
			return nil, e
		}
		return map[string]any{"version": r["version"]}, nil
	}
	if !coreIn(command, "project list", "project show", "guidance show", "item list", "item show", "item history", "batch list", "batch show") {
		if command == "" {
			command = "(空)"
		}
		return nil, errors.New("未知命令：" + command + "。运行 --cli help 查看全部命令。")
	}
	r, e := s.Get()
	if e != nil {
		return nil, e
	}
	state := coreMap(r["state"])
	if command == "project list" {
		projects := []any{}
		for _, v := range coreList(state["projects"]) {
			p := coreMap(v)
			counts := map[string]any{"ready": 0, "in_progress": 0, "pending_verification": 0, "archived": 0, "batches": len(coreList(p["batches"]))}
			for _, v := range coreList(p["items"]) {
				i := coreMap(v)
				if coreTruthy(i["archived"]) {
					counts["archived"] = coreNum(counts["archived"]) + 1
				} else if coreIn(coreString(i["status"]), "ready", "in_progress", "pending_verification") {
					k := coreString(i["status"])
					counts[k] = coreNum(counts[k]) + 1
				}
			}
			projects = append(projects, map[string]any{"id": p["id"], "name": p["name"], "description": p["description"], "guideVersion": p["guideVersion"], "counts": counts})
		}
		return map[string]any{"projects": projects}, nil
	}
	if command == "item list" {
		projects := coreList(state["projects"])
		if coreTruthy(a["project"]) {
			p, e := coreCLIProject(state, coreString(a["project"]))
			if e != nil {
				return nil, e
			}
			projects = []any{p}
		}
		items := []any{}
		status, search, executor := coreString(a["status"]), strings.ToLower(coreString(a["search"])), coreString(a["executor"])
		for _, v := range projects {
			p := coreMap(v)
			for _, v := range coreList(p["items"]) {
				i := coreMap(v)
				summary := coreCLIItem(i)
				if executor != "" && summary["executor"] != executor {
					continue
				}
				if status == "archived" {
					if !coreTruthy(i["archived"]) {
						continue
					}
				} else if status != "" {
					if coreTruthy(i["archived"]) || i["status"] != status {
						continue
					}
				} else if coreTruthy(i["archived"]) {
					continue
				}
				if search != "" && !strings.Contains(strings.ToLower(coreString(summary["number"])+" "+coreString(summary["title"])+" "+coreString(summary["body"])), search) {
					continue
				}
				if !coreTruthy(a["project"]) {
					summary["projectId"] = p["id"]
					summary["projectName"] = p["name"]
				}
				items = append(items, summary)
			}
		}
		return map[string]any{"items": items, "total": len(items)}, nil
	}
	p, e := coreCLIProject(state, coreString(a["project"]))
	if e != nil {
		return nil, e
	}
	switch command {
	case "project show":
		project := map[string]any{"dir": coreString(p["dir"]), "guideHistoryCount": len(coreList(p["guideHistory"]))}
		for _, k := range []string{"id", "name", "description", "guidance", "guideVersion", "deliveryGuidance", "aiValidation", "nextNumber"} {
			project[k] = p[k]
		}
		return map[string]any{"project": project}, nil
	case "guidance show":
		guidance := map[string]any{}
		for _, k := range []string{"guidance", "guideVersion", "deliveryGuidance", "aiValidation", "guideHistory"} {
			guidance[k] = p[k]
		}
		return guidance, nil
	case "item show", "item history":
		i, e := coreCLIRequireItem(p, coreString(a["id"]))
		if e != nil {
			return nil, e
		}
		if command == "item history" {
			return map[string]any{"history": i["history"]}, nil
		}
		summary := coreCLIItem(i)
		summary["history"] = i["history"]
		summary["flowEvents"] = i["flowEvents"]
		summary["unresolvedFailures"] = UnresolvedFailures(i)
		return map[string]any{"item": summary}, nil
	case "batch list":
		batches := []any{}
		for _, v := range coreList(p["batches"]) {
			batches = append(batches, coreCLIBatch(coreMap(v)))
		}
		return map[string]any{"batches": batches}, nil
	case "batch show":
		b := coreFind(coreList(p["batches"]), a["id"])
		if b == nil {
			return nil, errors.New("批次不存在")
		}
		batch := coreCLIBatch(b)
		items := []any{}
		for _, v := range coreList(b["items"]) {
			items = append(items, coreCLIItem(coreMap(v)))
		}
		batch["items"] = items
		return map[string]any{"batch": batch, "prompt": b["text"], "hash": b["hash"]}, nil
	}
	return nil, errors.New("未知命令")
}
