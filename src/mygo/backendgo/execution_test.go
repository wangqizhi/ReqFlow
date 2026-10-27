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
	runs := []string{coreUUID(), coreUUID(), coreUUID(), coreUUID(), coreUUID(), coreUUID()}
	clients := []string{"codex", "zcode", "pi", "claude-code", "dsh", "opencode"}
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
	// An open new-requirement draft must not block the owning Agent's completion.
	_, err = s.Mutate(map[string]any{"op": "requirementDraft", "project": pid, "draft": map[string]any{"body": "用户仍在记录新需求"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Mutate(map[string]any{"op": "complete", "project": pid, "id": iid, "batch": b["id"], "version": i["version"], "run": wrongRun, "summary": "完成"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r = coreTestGet(t, s)
	if coreMap(coreMap(coreList(coreMap(r["state"])["projects"])[0])["requirementDraft"])["body"] != "用户仍在记录新需求" {
		t.Fatal("Agent completion lost the draft")
	}
	item = coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["items"])[0])
	if ActiveAIExecution(item) != nil || item["status"] != "pending_verification" || coreMap(item["aiExecution"])["outcome"] != "completed" || !coreHas(coreMap(item["aiExecution"]), "durationMs") {
		t.Fatal(item)
	}
}

// Manual confirmation and release remain available after project guidance changes.
func TestAIExecutionRecoveryAfterGuidanceChange(t *testing.T) {
	for _, complete := range []bool{false, true} {
		t.Run(map[bool]string{false: "release", true: "manualComplete"}[complete], func(t *testing.T) {
			s := NewWorkspaceService(t.TempDir())
			r := coreTestGet(t, s)
			p := coreMap(coreList(coreMap(r["state"])["projects"])[0])
			pid := p["id"]
			mutate := func(a map[string]any) map[string]any {
				t.Helper()
				a["project"] = pid
				r, err := s.Mutate(a, nil)
				if err != nil {
					t.Fatal(err)
				}
				return coreMap(coreList(coreMap(r["state"])["projects"])[0])
			}
			p = mutate(map[string]any{"op": "item", "body": "recover"})
			i := coreMap(coreList(p["items"])[0])
			id := i["id"]
			p = mutate(map[string]any{"op": "generate", "ids": []any{id}})
			b := coreMap(coreList(p["batches"])[0])
			run := coreUUID()
			mutate(map[string]any{"op": "executionClaim", "run": run, "client": "codex", "claims": []any{map[string]any{"id": id, "version": i["version"], "batchId": b["id"], "hash": b["hash"]}}})
			mutate(map[string]any{"op": "guidance", "text": "changed guidance"})
			if complete {
				p = mutate(map[string]any{"op": "complete", "id": id, "manualConfirmation": true})
				i = coreMap(coreList(p["items"])[0])
				if i["status"] != "pending_verification" || coreMap(i["aiExecution"])["outcome"] != "completed" {
					t.Fatal(i)
				}
			} else {
				p = mutate(map[string]any{"op": "executionRelease", "id": id, "run": run})
				i = coreMap(coreList(p["items"])[0])
				if i["status"] != "ready" || ActiveAIExecution(i) != nil {
					t.Fatal(i)
				}
				mutate(map[string]any{"op": "item", "id": id, "body": "editable again"})
				mutate(map[string]any{"op": "generate", "ids": []any{id}})
			}
			if _, err := s.Mutate(map[string]any{"op": "complete", "project": pid, "id": id, "run": run}, nil); err == nil {
				t.Fatal("old run completed")
			}
		})
	}
}
