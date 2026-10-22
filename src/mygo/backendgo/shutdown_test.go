package backendgo

import "testing"

func TestShutdownReleasesExternalClaims(t *testing.T) {
	dir := t.TempDir()
	s := NewWorkspaceService(dir)
	r := coreTestGet(t, s)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	r, err := s.Mutate(map[string]any{"op": "item", "project": pid, "body": "shutdown"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	i := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["items"])[0])
	r, err = s.Mutate(map[string]any{"op": "generate", "project": pid, "ids": []any{i["id"]}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	b := coreMap(coreList(coreMap(coreList(coreMap(r["state"])["projects"])[0])["batches"])[0])
	run := coreUUID()
	_, err = NewWorkspaceService(dir).Mutate(map[string]any{"op": "executionClaim", "project": pid, "run": run, "client": "codex", "claims": []any{map[string]any{"id": i["id"], "version": i["version"], "batchId": b["id"], "hash": b["hash"]}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	actions, err := s.ActiveExecutionActions()
	if err != nil || len(actions) != 1 {
		t.Fatal(actions, err)
	}
	// Merely checking (or canceling the dialog) must leave ownership intact.
	again, _ := s.ActiveExecutionActions()
	if len(again) != 1 {
		t.Fatal("check changed execution")
	}
	if err = s.ReleaseForShutdown(actions); err != nil {
		t.Fatal(err)
	}
	again, err = s.ActiveExecutionActions()
	if err != nil || len(again) != 0 {
		t.Fatal(again, err)
	}
	r = coreTestGet(t, s)
	p := coreMap(coreList(coreMap(r["state"])["projects"])[0])
	i = coreMap(coreList(p["items"])[0])
	if ScheduledBatch(p, i) == nil || coreMap(i["aiExecution"])["outcome"] != "released" {
		t.Fatal("task did not return to schedule", i)
	}
	if _, err = s.Mutate(map[string]any{"op": "complete", "project": pid, "id": i["id"], "run": run, "batch": b["id"], "version": i["version"], "summary": "stale"}, nil); err == nil {
		t.Fatal("released run completed")
	}
}
