package backendgo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
