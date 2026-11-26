package backendgo

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAntigravityStatsUsage(t *testing.T) {
	home := t.TempDir()
	const runID = "10000000-0000-4000-8000-000000000001"
	const otherRunID = "10000000-0000-4000-8000-000000000002"
	const session = "20000000-0000-4000-8000-000000000001"
	const unrelated = "20000000-0000-4000-8000-000000000002"
	const readTool = `{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"call_mcp_tool","args":{"ServerName":"reqflow-agent-antigravity_reqflow","ToolName":"reqflow_read","Arguments":{"execute":true}}}]}`
	const receipt = `{"type":"GENERIC","status":"DONE","content":"Created At: ...\n{\"ok\":true,\"runFile\":\"C:\\\\runs\\\\` + runID + `.json\",\"project\":{\"id\":\"project\"}}"}`
	const firstStep = `{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":2,"created_at":"2020-10-01T00:00:11Z","model":"gemini-first","input_tokens":5,"cache_read_tokens":50,"output_tokens":8}`
	const otherRunTool = `{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":3,"created_at":"2020-10-01T00:00:22Z","model":"overlap","input_tokens":99,"output_tokens":1,"tool_calls":[{"name":"call_mcp_tool","args":{"ServerName":"reqflow","ToolName":"reqflow_complete","Arguments":{"runFile":"/runs/` + otherRunID + `.json","items":[{"id":"b"}]}}}]}`
	const secondStep = `{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":4,"created_at":"2020-10-01T00:00:29Z","model":"claude-second","input_tokens":10,"output_tokens":4}`
	const tooLate = `{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":5,"created_at":"2020-10-01T00:00:40Z","model":"later","input_tokens":999,"output_tokens":1}`
	write := func(dir, id, contents string) {
		t.Helper()
		logs := filepath.Join(home, ".gemini", dir, "brain", id, ".system_generated", "logs")
		if err := os.MkdirAll(logs, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(logs, "transcript_full.jsonl"), []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("antigravity", session, readTool+"\n"+receipt+"\n"+firstStep+"\n"+firstStep+"\n"+otherRunTool+"\n"+secondStep+"\n"+tooLate)
	write("antigravity-cli", unrelated, firstStep+"\n"+secondStep)
	item := func(id, run, client, start, end string) (map[string]any, map[string]any) {
		event := map[string]any{"event": "实现完成", "time": end, "execution": map[string]any{"runId": run, "client": client, "startedAt": start}}
		return map[string]any{"id": id, "history": []any{event}}, event
	}
	a, aCompletion := item("a", runID, "antigravity", "2020-10-01T00:00:10Z", "2020-10-01T00:00:30Z")
	b, bCompletion := item("b", otherRunID, "pi", "2020-10-01T00:00:20Z", "2020-10-01T00:00:24Z")
	bCompletion["note"] = "[ReqFlow Antigravity run " + otherRunID + "]\n"
	state := map[string]any{"projects": []any{map[string]any{"id": "project", "items": []any{a, b}}}}

	usage := antigravityStatsUsage(home, state)
	if len(usage) != 1 || len(usage[runID]) != 2 {
		t.Fatalf("expected two unambiguous model rows for the first run, got %#v", usage)
	}
	row := coreMap(usage[runID][0])
	if row["sessionId"] != session || row["scope"] != "run" || row["model"] != "gemini-first" ||
		coreNum(row["inputTokens"]) != 55 || coreNum(row["cachedInputTokens"]) != 50 || coreNum(row["outputTokens"]) != 8 {
		t.Fatalf("unexpected usage: %#v", row)
	}
	aCompletion["usage"] = usage[runID]
	if got := antigravityStatsUsage(home, state); len(got) > 0 {
		t.Fatalf("a provider report should take precedence: %#v", got)
	}
}

func TestAntigravityStatsUsageParallelAndCLIFallback(t *testing.T) {
	home := t.TempDir()
	const parallelRunID = "10000000-0000-4000-8000-000000000011"
	const cliRunID = "10000000-0000-4000-8000-000000000012"
	const parallelSession = "20000000-0000-4000-8000-000000000011"
	const cliSession = "20000000-0000-4000-8000-000000000012"
	write := func(dir, id, contents string) {
		t.Helper()
		logs := filepath.Join(home, ".gemini", dir, "brain", id, ".system_generated", "logs")
		if err := os.MkdirAll(logs, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(logs, "transcript_full.jsonl"), []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Parallel tool calls: another tool's GENERIC response arrives before reqflow_read's receipt.
	parallelTranscript := `{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"call_mcp_tool","args":{"ServerName":"reqflow-agent-antigravity_reqflow","ToolName":"reqflow_read","Arguments":{"execute":true}}},{"name":"read_file","args":{"Path":"README.md"}}]}` + "\n" +
		`{"type":"GENERIC","status":"DONE","content":"Created At: ...\nREADME content"}` + "\n" +
		`{"type":"GENERIC","status":"DONE","content":"Created At: ...\n{\"ok\":true,\"runFile\":\"C:\\\\runs\\\\` + parallelRunID + `.json\",\"project\":{\"id\":\"project\"}}"}` + "\n" +
		`{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":3,"created_at":"2020-10-01T00:00:15Z","model":"gemini-parallel","input_tokens":12,"cache_read_tokens":30,"output_tokens":6}`
	// Fallback CLI invocation via run_command running reqflow.mjs read.
	cliTranscript := `{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"CommandLine":"node C:\\plugins\\scripts\\reqflow.mjs read --cwd E:\\repo"}}]}` + "\n" +
		`{"type":"GENERIC","status":"DONE","content":"Command exited with code 0.\n\nCommand output:\n{\"ok\":true,\"runFile\":\"C:\\\\runs\\\\` + cliRunID + `.json\",\"project\":{\"id\":\"project\"}}"}` + "\n" +
		`{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":4,"created_at":"2020-10-01T00:01:15Z","model":"gemini-cli","input_tokens":20,"cache_read_tokens":40,"output_tokens":9}`
	write("antigravity", parallelSession, parallelTranscript)
	write("antigravity-cli", cliSession, cliTranscript)

	item := func(id, run, start, end string) map[string]any {
		event := map[string]any{"event": "实现完成", "time": end, "execution": map[string]any{"runId": run, "client": "antigravity", "startedAt": start}}
		return map[string]any{"id": id, "history": []any{event}}
	}
	state := map[string]any{"projects": []any{map[string]any{
		"id": "project",
		"items": []any{
			item("a", parallelRunID, "2020-10-01T00:00:10Z", "2020-10-01T00:00:20Z"),
			item("b", cliRunID, "2020-10-01T00:01:10Z", "2020-10-01T00:01:20Z"),
		},
	}}}

	usage := antigravityStatsUsage(home, state)
	if len(usage) != 2 {
		t.Fatalf("expected both parallel and CLI fallback runs to be recovered, got %#v", usage)
	}
	if row := coreMap(usage[parallelRunID][0]); row["model"] != "gemini-parallel" || coreNum(row["inputTokens"]) != 42 || coreNum(row["outputTokens"]) != 6 {
		t.Fatalf("unexpected parallel usage: %#v", row)
	}
	if row := coreMap(usage[cliRunID][0]); row["model"] != "gemini-cli" || coreNum(row["inputTokens"]) != 60 || coreNum(row["outputTokens"]) != 9 {
		t.Fatalf("unexpected cli fallback usage: %#v", row)
	}

	// Verify the dedicated stats:antigravity-usage IPC channel returns recovered usage without enabling local sessions.
	t.Setenv("ANTIGRAVITY_DATA_DIR", filepath.Join(home, ".gemini", "antigravity"))
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	r := coreTestGet(t, b.Workspace)
	projectID := coreString(coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"])
	r, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": projectID, "body": "agy stats ipc"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(r["state"])["projects"]), projectID)
	itemID := coreString(coreMap(coreList(p["items"])[0])["id"])
	r, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": projectID, "ids": []any{itemID}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p = coreFind(coreList(coreMap(r["state"])["projects"]), projectID)
	batch := coreMap(coreList(p["batches"])[0])
	if _, err := b.Workspace.Mutate(map[string]any{
		"op": "executionClaim", "project": projectID, "run": parallelRunID, "client": "antigravity",
		"claims": []any{map[string]any{"id": itemID, "version": 1, "batchId": batch["id"], "hash": batch["hash"]}},
	}, nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := b.Workspace.Mutate(map[string]any{
		"op": "complete", "project": projectID, "id": itemID, "run": parallelRunID, "summary": "done",
	}, nil); err != nil {
		t.Fatal(err)
	}
	// Write a transcript whose project ID and step timestamp match the real claimed/completed run.
	record, err := b.Workspace.store.read()
	if err != nil {
		t.Fatal(err)
	}
	completedProject := coreFind(coreList(coreMap(record["data"])["projects"]), projectID)
	completedItem := coreFind(coreList(completedProject["items"]), itemID)
	completedEvent := coreMap(coreList(completedItem["history"])[0])
	stepTime := coreString(completedEvent["time"])
	ipcTranscript := `{"type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"call_mcp_tool","args":{"ServerName":"reqflow-agent-antigravity_reqflow","ToolName":"reqflow_read","Arguments":{"execute":true}}}]}` + "\n" +
		`{"type":"GENERIC","status":"DONE","content":"{\"ok\":true,\"runFile\":\"C:\\\\runs\\\\` + parallelRunID + `.json\",\"project\":{\"id\":\"` + projectID + `\"}}"}` + "\n" +
		`{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":1,"created_at":"` + stepTime + `","model":"gemini-ipc","input_tokens":15,"cache_read_tokens":5,"output_tokens":7}`
	write("antigravity", parallelSession, ipcTranscript)

	resp, err := b.Invoke(context.Background(), "stats:antigravity-usage", nil)
	if err != nil {
		t.Fatal(err)
	}
	usageByRun, ok := desktopMap(resp)["usageByRun"].(map[string][]any)
	if !ok {
		t.Fatalf("unexpected usageByRun type: %#v", resp)
	}
	rows := usageByRun[parallelRunID]
	if len(rows) != 1 || coreMap(rows[0])["model"] != "gemini-ipc" || coreNum(coreMap(rows[0])["inputTokens"]) != 20 {
		t.Fatalf("unexpected stats:antigravity-usage response: %#v", resp)
	}
}
