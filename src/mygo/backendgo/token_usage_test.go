package backendgo

import (
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLocalStatsUsageRespectsTaskCoverageAndLocalDay(t *testing.T) {
	home := t.TempDir()
	claude := filepath.Join(home, ".claude")
	t.Setenv("CLAUDE_CONFIG_DIR", claude)
	logs := filepath.Join(claude, "projects", "fixture")
	if err := os.MkdirAll(logs, 0700); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, "work")
	sub := filepath.Join(root, "nested")
	today := time.Date(2026, 11, 23, 0, 0, 0, 0, time.Local)
	emit := func(at time.Time, id, session string, input int) map[string]any {
		return map[string]any{"type": "assistant", "timestamp": at.Format(time.RFC3339), "sessionId": session, "cwd": sub,
			"message": map[string]any{"id": id, "model": "fixture-model",
				"usage": map[string]any{"input_tokens": input, "cache_read_input_tokens": 3, "output_tokens": 2}}}
	}
	log := []map[string]any{
		emit(today.Add(-time.Minute), "yesterday", "same", 1),
		emit(today.Add(time.Minute), "covered", "same", 100),
		emit(today.Add(time.Minute), "parallel", "other", 20),
		emit(today.Add(3*time.Minute), "later", "same", 30),
		emit(today.Add(3*time.Minute), "later", "same", 30),
	}
	writeUsageLines(t, filepath.Join(logs, "fixture.jsonl"), false, log...)
	event := map[string]any{
		"event": "实现完成", "time": today.Add(2 * time.Minute).Format(time.RFC3339),
		"execution": map[string]any{"client": "claude-code", "startedAt": today.Format(time.RFC3339)},
		"usage":     []any{map[string]any{"sessionId": "same"}},
	}
	state := map[string]any{"projects": []any{
		map[string]any{"id": "parent", "dir": root, "items": []any{map[string]any{"history": []any{event}}}},
		map[string]any{"id": "child", "dir": sub},
	}}
	rows := localStatsUsage(home, state, nil, today)
	var sessions []localUsageRow
	for _, row := range rows {
		if row.Client == "claude-code" {
			sessions = append(sessions, row)
		}
	}
	if len(sessions) != 2 || sessions[0].Session != "other" || sessions[0].Input != 23 ||
		sessions[1].Session != "same" || sessions[1].Input != 33 || sessions[1].ProjectID != "child" ||
		sessions[1].Day != today.Format("2006-01-02") {
		t.Fatalf("unexpected local rows: %#v", sessions)
	}
}

func TestOpenCodeStatsProjectedUsage(t *testing.T) {
	file := filepath.Join(t.TempDir(), "opencode.db")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, statement := range []string{
		"CREATE TABLE session_v2 (id TEXT, directory TEXT, fork_session_id TEXT)",
		"CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO session_v2 VALUES ('original', ?, NULL), ('fork', ?, 'original')", root, root); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 23, 12, 0, 0, 0, time.Local)
	raw := `{"model":{"id":"test-model","variant":"high"},"tokens":{"input":5,"output":7,"reasoning":11,"cache":{"read":20,"write":4}},"time":{"completed":` + coreString(at.UnixMilli()) + `}}`
	if _, err := db.Exec("INSERT INTO session_message VALUES ('1','original','assistant',?,?),('2','fork','assistant',?,?)",
		at.UnixMilli(), raw, at.UnixMilli(), raw); err != nil {
		t.Fatal(err)
	}
	db.Close()
	count := 0
	readOpenCodeStats(file, at, map[string]bool{}, func(client, session, dir string, step localUsageStep) {
		count++
		if client != "opencode" || session != "original" || dir != root || step.model != "test-model" ||
			step.effort != "high" || step.input != 29 || step.output != 18 || step.reasoning != 11 || step.cached != 20 {
			t.Fatalf("unexpected projection: %s %s %s %#v", client, session, dir, step)
		}
	})
	if count != 1 {
		t.Fatalf("expected original usage exactly once, got %d rows", count)
	}
}

func TestAntigravityStatsDatabaseUsage(t *testing.T) {
	field := func(id uint64, body []byte) []byte {
		data := binary.AppendUvarint(nil, id<<3|2)
		return append(binary.AppendUvarint(data, uint64(len(body))), body...)
	}
	number := func(id, value uint64) []byte {
		return binary.AppendUvarint(binary.AppendUvarint(nil, id<<3), value)
	}
	stamp := time.Date(2026, 11, 23, 12, 0, 0, 0, time.Local)
	usage := append(number(2, 10), number(3, 8)...)
	usage = append(usage, number(5, 30)...)
	usage = append(usage, number(9, 4)...)
	usage = append(usage, field(11, []byte("response-id"))...)
	chat := append(field(4, usage), field(9, field(4, number(1, uint64(stamp.Unix()))))...)
	chat = append(chat, field(19, []byte("test-model"))...)
	file := filepath.Join(t.TempDir(), "session.db")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)"); err != nil {
		t.Fatal(err)
	}
	blob := field(1, chat)
	if _, err := db.Exec("INSERT INTO gen_metadata VALUES (1, ?), (2, ?)", blob, blob); err != nil {
		t.Fatal(err)
	}
	db.Close()
	count := 0
	if !readAntigravityStatsDB(file, "session", map[string]bool{}, func(client, session, dir string, step localUsageStep) {
		count++
		if client != "antigravity" || session != "session" || dir != "" || !step.at.Equal(stamp) ||
			step.model != "test-model" || step.input != 40 || step.cached != 30 || step.output != 8 || step.reasoning != 4 {
			t.Fatalf("unexpected Antigravity statistics: %s %s %s %#v", client, session, dir, step)
		}
	}) || count != 1 {
		t.Fatalf("expected one Antigravity generation, got %d", count)
	}
}

func TestTaskUsageValidation(t *testing.T) {
	valid := []any{map[string]any{"model": "actual-model", "inputTokens": 100, "outputTokens": 20, "cachedInputTokens": 80, "reasoningOutputTokens": 5}}
	result, err := validateTokenUsage(valid)
	if err != nil || coreNum(coreMap(result[0])["totalTokens"]) != 120 {
		t.Fatal(result, err)
	}
	for _, u := range []any{map[string]any{"model": "m", "inputTokens": -1}, map[string]any{"model": "m", "inputTokens": 1.5}, map[string]any{"model": "m", "inputTokens": 10, "cachedInputTokens": 11}, map[string]any{"inputTokens": 1}} {
		if _, err := validateTokenUsage([]any{u}); err == nil {
			t.Fatal("invalid usage accepted", u)
		}
	}
}

func TestCodexUsageSessionBoundaryAndModels(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(t.TempDir(), "session.jsonl")
	f, _ := os.Create(file)
	emit := func(kind, stamp string, payload map[string]any) {
		raw, _ := json.Marshal(map[string]any{"type": kind, "timestamp": stamp, "payload": payload})
		f.Write(append(raw, '\n'))
	}
	emit("session_meta", "2026-10-28T00:00:00Z", map[string]any{"id": "test-session", "cwd": root})
	context := func(model, effort string) {
		emit("turn_context", "2026-10-28T00:00:00Z", map[string]any{"model": model, "effort": effort})
	}
	token := func(stamp string, in, out int) {
		emit("event_msg", stamp, map[string]any{"type": "token_count", "info": map[string]any{"total_token_usage": map[string]any{"input_tokens": in, "output_tokens": out}}})
	}
	context("model-a", "high")
	token("2026-10-28T00:00:01Z", 1000, 100)
	token("2026-10-28T00:00:03Z", 1100, 110)
	token("2026-10-28T00:00:03Z", 1100, 110) // duplicate provider snapshot
	context("model-b", "low")
	token("2026-10-28T00:00:04Z", 1300, 130)
	f.Close()
	since, _ := time.Parse(time.RFC3339, "2026-10-28T00:00:02Z")
	rows := readCodexTaskUsage(file, root, "test-session", since)
	total := int64(0)
	for _, row := range rows {
		total += coreNum(coreMap(row)["totalTokens"])
	}
	if len(rows) != 2 || total != 330 {
		t.Fatal(rows)
	}
	if got := readCodexTaskUsage(file, t.TempDir(), "test-session", since); len(got) != 0 {
		t.Fatal("cross-project usage", got)
	}
	if got := readCodexTaskUsage(file, root, "another-session", since); len(got) != 0 {
		t.Fatal("cross-session usage", got)
	}
}

func TestCompleteUsageStoredInHistory(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "1.0.0")
	r := coreTestGet(t, b.Workspace)
	project := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	r, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": project, "body": "usage test"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(r["state"])["projects"]), project)
	id := coreMap(coreList(p["items"])[0])["id"]
	if _, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": project, "ids": []any{id}}, nil); err != nil {
		t.Fatal(err)
	}
	r, err = coreCLIDispatch(b.Workspace, "complete", map[string]any{"project": project, "id": id, "usage": `[{"model":"provider-model","reasoningEffort":"high","inputTokens":20,"outputTokens":5}]`}, "1.0.0")
	if err != nil {
		t.Fatal(r, err)
	}
	r = coreTestGet(t, b.Workspace)
	p = coreFind(coreList(coreMap(r["state"])["projects"]), project)
	item := coreFind(coreList(p["items"]), id)
	history := coreMap(coreList(item["history"])[0])
	usage := coreMap(coreList(history["usage"])[0])
	if usage["model"] != "provider-model" || coreNum(usage["totalTokens"]) != 25 {
		t.Fatal(history)
	}
}
