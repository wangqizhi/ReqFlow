package backendgo

import (
	"os"
	"path/filepath"
	"testing"
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
