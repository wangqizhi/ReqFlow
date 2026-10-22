package backendgo

import "testing"

func TestAgentAssignmentAfterVerificationFailure(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	state := coreTestGet(t, b.Workspace)
	pid := coreString(coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"])
	mutate := func(action map[string]any) map[string]any {
		action["project"] = pid
		result, err := b.Workspace.Mutate(action, nil)
		if err != nil {
			t.Fatal(err)
		}
		return coreFind(coreList(coreMap(result["state"])["projects"]), pid)
	}
	p := mutate(map[string]any{"op": "item", "body": "verification round"})
	item := coreMap(coreList(p["items"])[0])
	id := coreString(item["id"])
	p = mutate(map[string]any{"op": "generate", "ids": []any{id}})
	batch := ScheduledBatch(p, coreFind(coreList(p["items"]), id))
	run := &agentRun{assignments: map[string]agentAssignment{id: {version: 1, batch: coreString(batch["id"])}}}
	if !agentHasCurrentAssignments(p, run) {
		t.Fatal("new assignment must remain open before claim")
	}
	p = mutate(map[string]any{"op": "complete", "id": id, "batch": batch["id"], "version": 1, "summary": "round one complete"})
	if !agentHasCurrentAssignments(p, run) {
		t.Fatal("keep completed terminal during verification")
	}
	p = mutate(map[string]any{"op": "verify", "id": id, "pass": false, "note": "needs changes"})
	if agentHasCurrentAssignments(p, run) {
		t.Fatal("old terminal must not block the rejected version")
	}
	p = mutate(map[string]any{"op": "generate", "ids": []any{id}})
	if agentHasCurrentAssignments(p, run) {
		t.Fatal("new schedule must not revive old assignment")
	}
	current := &agentRun{assignments: map[string]agentAssignment{id: {version: 2}}}
	if !agentHasCurrentAssignments(p, current) {
		t.Fatal("new round can be assigned")
	}
	// A different item still in verification keeps its output available.
	p = mutate(map[string]any{"op": "item", "body": "another assignment"})
	for _, v := range coreList(p["items"]) {
		i := coreMap(v)
		if i["id"] != id {
			run.assignments[coreString(i["id"])] = agentAssignment{version: coreNum(i["version"])}
		}
	}
	if !agentHasCurrentAssignments(p, run) {
		t.Fatal("one current assignment must keep a combined session alive")
	}
}
