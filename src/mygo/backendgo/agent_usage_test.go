package backendgo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

func writeUsageLines(t *testing.T, file string, compress bool, lines ...map[string]any) {
	t.Helper()
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var w interface {
		Write([]byte) (int, error)
	} = f
	var enc *zstd.Encoder
	if compress {
		enc, _ = zstd.NewWriter(f)
		w = enc
	}
	for _, line := range lines {
		raw, _ := json.Marshal(line)
		w.Write(append(raw, '\n'))
	}
	if enc != nil {
		enc.Close()
	}
}

func usageTotals(rows []any) (input, cached, output int64) {
	for _, row := range rows {
		u := coreMap(row)
		input += coreNum(u["inputTokens"])
		cached += coreNum(u["cachedInputTokens"])
		output += coreNum(u["outputTokens"])
	}
	return
}

var usageSince, _ = time.Parse(time.RFC3339, "2026-10-28T00:00:10Z")

func TestClaudeUsageDedupAndBoundary(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(t.TempDir(), "s1.jsonl")
	msg := func(id, stamp string, in, cache, out int) map[string]any {
		return map[string]any{"type": "assistant", "sessionId": "s1", "cwd": filepath.Join(root, "sub"), "timestamp": stamp,
			"message": map[string]any{"id": id, "model": "claude-x", "usage": map[string]any{"input_tokens": in, "cache_read_input_tokens": cache, "output_tokens": out}}}
	}
	writeUsageLines(t, file, false,
		msg("m0", "2026-10-28T00:00:05Z", 999, 0, 9), // before claim
		msg("m1", "2026-10-28T00:00:11Z", 100, 50, 10),
		msg("m1", "2026-10-28T00:00:11Z", 100, 50, 10), // same reply, another content block
		msg("m2", "2026-10-28T00:00:12Z", 20, 0, 5))
	rows := readClaudeTaskUsage(file, root, "s1", "high", usageSince)
	in, cached, out := usageTotals(rows)
	if in != 170 || cached != 50 || out != 15 || coreMap(rows[0])["reasoningEffort"] != "high" {
		t.Fatal(rows)
	}
	if readClaudeTaskUsage(file, t.TempDir(), "s1", "", usageSince) != nil {
		t.Fatal("session outside project accepted")
	}
}

func TestPiUsageVerifiesSessionDir(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(t.TempDir(), "x_p1.jsonl")
	writeUsageLines(t, file, false,
		map[string]any{"type": "session", "id": "p1", "cwd": root},
		map[string]any{"type": "message", "timestamp": "2026-10-28T00:00:11Z", "message": map[string]any{"role": "assistant", "model": "m", "thinkingLevel": "medium", "usage": map[string]any{"input": 40, "cacheRead": 60, "output": 7}}})
	in, cached, out := usageTotals(readPiTaskUsage(file, root, "p1", usageSince))
	if in != 100 || cached != 60 || out != 7 {
		t.Fatal(in, cached, out)
	}
	if readPiTaskUsage(file, root, "other", usageSince) != nil {
		t.Fatal("mismatched session accepted")
	}
}

func TestZCodeAndDshUsage(t *testing.T) {
	file := filepath.Join(t.TempDir(), "model-io-z1.jsonl")
	io := func(req, stamp string, in, out int) map[string]any {
		return map[string]any{"type": "model_io", "sessionId": "z1", "requestId": req, "attempt": 1, "completedAt": stamp, "model": map[string]any{"modelId": "zm"},
			"request": map[string]any{"body": map[string]any{"output_config": map[string]any{"effort": "low"}}}, "response": map[string]any{"usage": map[string]any{"inputTokens": in, "outputTokens": out, "cacheReadTokens": 5}}}
	}
	writeUsageLines(t, file, false, io("r0", "2026-10-28T00:00:01Z", 500, 50), io("r1", "2026-10-28T00:00:20Z", 10, 2), io("r1", "2026-10-28T00:00:20Z", 10, 2))
	if in, cached, out := usageTotals(readZCodeTaskUsage(file, "z1", usageSince)); in != 15 || cached != 5 || out != 2 {
		t.Fatal(in, cached, out)
	}
	root := t.TempDir()
	dsh := filepath.Join(t.TempDir(), "session.v4.jsonl.zstd")
	writeUsageLines(t, dsh, true,
		map[string]any{"type": "session", "id": "d1", "cwd": root},
		map[string]any{"type": "assistant/message", "time": float64(usageSince.Add(time.Second).UnixMilli()), "data": map[string]any{"usage": map[string]any{"inputTokens": 30, "cacheReadTokens": 70, "outputTokens": 9}, "message": map[string]any{"source": map[string]any{"model": "ds"}}}})
	if in, cached, out := usageTotals(readDshTaskUsage(dsh, root, "d1", usageSince)); in != 100 || cached != 70 || out != 9 {
		t.Fatal(in, cached, out)
	}
}
