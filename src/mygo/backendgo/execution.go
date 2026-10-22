package backendgo

import (
	"errors"
	"regexp"
	"time"
)

func ActiveAIExecution(i map[string]any) map[string]any {
	e := coreMap(i["aiExecution"])
	if coreString(e["runId"]) != "" && coreString(e["endedAt"]) == "" {
		return e
	}
	return nil
}

func claimAIExecution(p, a map[string]any, now string) error {
	if !coreIn(coreString(a["client"]), "codex", "zcode", "pi", "claude-code", "dsh", "opencode") || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(coreString(a["run"])) {
		return errors.New("AI 领取客户端或运行 ID 无效")
	}
	requests, ok := a["claims"].([]any)
	if !ok || len(requests) == 0 {
		return errors.New("AI 领取请求不能为空")
	}
	seen := map[string]bool{}
	for _, v := range requests {
		r := coreMap(v)
		id := coreString(r["id"])
		if id == "" || seen[id] || !coreSafeInt(r["version"]) || coreString(r["batchId"]) == "" || coreString(r["hash"]) == "" {
			return errors.New("AI 领取请求格式无效")
		}
		seen[id] = true
	}
	for _, v := range requests {
		r := coreMap(v)
		i := coreFind(coreList(p["items"]), r["id"])
		if i == nil || coreTruthy(i["archived"]) || coreExecutor(i) != "ai" || !coreIn(coreString(i["status"]), "ready", "in_progress") {
			continue
		}
		if e := ActiveAIExecution(i); e != nil {
			continue // No overwrite, including a second client using the same run ID.
		}
		b := ScheduledBatch(p, i)
		if b == nil || b["id"] != r["batchId"] || b["hash"] != r["hash"] || coreNum(i["version"]) != coreNum(r["version"]) {
			continue
		}
		i["aiExecution"] = map[string]any{"runId": a["run"], "client": a["client"], "startedAt": now, "version": i["version"], "batchId": b["id"]}
		coreHistory(i, map[string]any{"event": "AI 领取任务", "time": now, "client": a["client"], "runId": a["run"]})
	}
	return nil
}

func finishAIExecution(i map[string]any, now, outcome string) {
	if e := ActiveAIExecution(i); e != nil {
		e["endedAt"] = now
		e["outcome"] = outcome
		start, err := time.Parse(time.RFC3339Nano, coreString(e["startedAt"]))
		end, endErr := time.Parse(time.RFC3339Nano, now)
		if err == nil && endErr == nil {
			duration := end.Sub(start).Milliseconds()
			if duration < 0 {
				duration = 0
			}
			e["durationMs"] = duration
		}
	}
}

// GUI and CLI share this guard; store CAS makes claim acquisition exclusive
// across separate processes as well as separate clients.
func guardAIExecution(p, a map[string]any) error {
	op := coreString(a["op"])
	if coreIn(op, "executionClaim", "executionRelease", "gitCommitted", "requirementDraft", "completionNote") {
		return nil
	}
	ids := coreList(a["ids"])
	if coreString(a["id"]) != "" {
		ids = append(ids, a["id"])
	}
	if coreIn(op, "cancel", "submit") {
		if b := coreFind(coreList(p["batches"]), a["batch"]); b != nil {
			for _, v := range coreList(b["items"]) {
				ids = append(ids, coreMap(v)["id"])
			}
		}
	}
	if coreIn(op, "deleteProject", "guidance", "projectDir", "projectDescription") {
		for _, v := range coreList(p["items"]) {
			ids = append(ids, coreMap(v)["id"])
		}
	}
	for _, id := range ids {
		i := coreFind(coreList(p["items"]), id)
		if i == nil {
			continue
		}
		if op == "complete" && coreString(a["run"]) != "" && ActiveAIExecution(i) == nil {
			return errors.New("AI 任务已释放或结束，不能使用旧运行记录提交完成")
		}
		if e := ActiveAIExecution(i); e != nil {
			if op == "complete" && e["runId"] == a["run"] {
				continue
			}
			return errors.New("需求正在由 " + coreString(e["client"]) + " 执行，请先释放任务")
		}
	}
	return nil
}
