package backendgo

import (
	"sync"
	"testing"
)

func TestAIExecutionExclusiveClaim(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	r := coreTestGet(t, s)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	r, err := s.Mutate(map[string]any{"op": "item", "project": pid, "body": "竞争领取"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	i := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["items"])[0])
	iid := i["id"]
	r, err = s.Mutate(map[string]any{"op": "generate", "project": pid, "ids": []any{iid}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["batches"])[0])
	claims := []any{map[string]any{"id": iid, "version": i["version"], "batchId": b["id"], "hash": b["hash"]}}
	runs := []string{coreUUID(), coreUUID(), coreUUID(), coreUUID(), coreUUID()}
	clients := []string{"codex", "zcode", "pi", "claude-code", "dsh"}
	var wait sync.WaitGroup
	var mu sync.Mutex
	errors := []error{}
	for n, client := range clients {
		wait.Add(1)
		go func(client, run string) {
			defer wait.Done()
			_, e := NewWorkspaceService(dir).Mutate(map[string]any{"op": "executionClaim", "project": pid, "claims": claims, "run": run, "client": client}, nil)
			if e != nil {
				mu.Lock()
				errors = append(errors, e)
				mu.Unlock()
			}
		}(client, runs[n])
	}
	wait.Wait()
	if len(errors) != 0 {
		t.Fatal(errors)
	}
	r = coreTestGet(t, s)
	item := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["items"])[0])
	e := ActiveAIExecution(item)
	if e == nil {
		t.Fatal("no client acquired the task")
	}
	owner := coreString(e["runId"])
	claimEvents := 0
	for _, v := range coreList(item["history"]) {
		if coreMap(v)["event"] == "AI 领取任务" {
			claimEvents++
		}
	}
	if claimEvents != 1 {
		t.Fatal("duplicate claim", item)
	}
	wrongRun := runs[0]
	if wrongRun == owner {
		wrongRun = runs[1]
	}
	for _, action := range []map[string]any{
		{"op": "complete", "project": pid, "id": iid, "run": wrongRun},
		{"op": "generate", "project": pid, "ids": []any{iid}},
		{"op": "item", "project": pid, "id": iid, "body": "overwrite"},
		{"op": "executionRelease", "project": pid, "id": iid, "run": wrongRun},
	} {
		if _, e := s.Mutate(action, nil); e == nil {
			t.Fatal("foreign mutation accepted", action)
		}
	}
	_, err = s.Mutate(map[string]any{"op": "executionRelease", "project": pid, "id": iid, "run": owner}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Mutate(map[string]any{"op": "executionClaim", "project": pid, "claims": claims, "run": wrongRun, "client": "pi"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Mutate(map[string]any{"op": "complete", "project": pid, "id": iid, "batch": b["id"], "version": i["version"], "run": wrongRun, "summary": "完成"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r = coreTestGet(t, s)
	item = coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["items"])[0])
	if ActiveAIExecution(item) != nil || item["status"] != "pending_verification" || coreMap(item["aiExecution"])["outcome"] != "completed" || !coreHas(coreMap(item["aiExecution"]), "durationMs") {
		t.Fatal(item)
	}
}
