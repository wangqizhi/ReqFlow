package backendgo

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OpenCode keeps per-message counters in both its original message table and
// its newer session projection. Session totals alone cannot be dated or deduped.
const openCodeLegacyUsageSQL = `
	SELECT
		m.id, s.id, s.directory, json_extract(m.data, '$.modelID'),
		json_extract(m.data, '$.variant'),
		coalesce(json_extract(m.data, '$.time.completed'), m.time_created),
		json_extract(m.data, '$.tokens.input'), json_extract(m.data, '$.tokens.output'),
		json_extract(m.data, '$.tokens.cache.read'), json_extract(m.data, '$.tokens.cache.write'),
		json_extract(m.data, '$.tokens.reasoning'), json_extract(m.data, '$.tokens.total'), 0
	FROM message m JOIN session s ON m.session_id = s.id
	WHERE json_extract(m.data, '$.role') = 'assistant'
		AND json_type(m.data, '$.tokens') = 'object'
		AND coalesce(json_extract(m.data, '$.time.completed'), m.time_created) >= ?`

const openCodeUsageSQL = `
	SELECT
		m.id, s.id, s.directory, json_extract(m.data, '$.model.id'),
		json_extract(m.data, '$.model.variant'),
		coalesce(json_extract(m.data, '$.time.completed'), m.time_created),
		json_extract(m.data, '$.tokens.input'), json_extract(m.data, '$.tokens.output'),
		json_extract(m.data, '$.tokens.cache.read'), json_extract(m.data, '$.tokens.cache.write'),
		json_extract(m.data, '$.tokens.reasoning'), NULL,
		EXISTS (SELECT 1 FROM session_message p WHERE p.session_id = s.fork_session_id
			AND p.type = m.type AND p.time_created = m.time_created
			AND json_extract(p.data, '$.time.completed') = json_extract(m.data, '$.time.completed'))
	FROM session_message m JOIN session_v2 s ON m.session_id = s.id
	WHERE m.type = 'assistant' AND json_type(m.data, '$.tokens') = 'object'
		AND coalesce(json_extract(m.data, '$.time.completed'), m.time_created) >= ?`

func collectOpenCodeStats(home string, start time.Time, add collectLocalUsage) {
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		data = filepath.Join(home, ".local", "share")
	}
	dir := filepath.Join(data, "opencode")
	files, _ := filepath.Glob(filepath.Join(dir, "opencode*.db"))
	if file := os.Getenv("OPENCODE_DB"); file != "" && file != ":memory:" {
		if !filepath.IsAbs(file) {
			file = filepath.Join(dir, file)
		}
		files = append([]string{file}, files...)
	}
	seen := map[string]bool{}
	for _, file := range files {
		readOpenCodeStats(file, start, seen, add)
	}
	readOpenCodeJSON(filepath.Join(dir, "storage"), start, seen, add)
}

func readOpenCodeStats(file string, start time.Time, seen map[string]bool, add collectLocalUsage) {
	db, err := openUsageDB(file)
	if err != nil {
		return
	}
	defer db.Close()
	for index, query := range []string{openCodeUsageSQL, openCodeLegacyUsageSQL} {
		rows, err := db.Query(query, start.UnixMilli())
		if err != nil {
			continue
		}
		for rows.Next() {
			var id, session, dir string
			var model, effort sql.NullString
			var at, copied int64
			var input, output, read, write, reasoning, total sql.NullInt64
			if rows.Scan(&id, &session, &dir, &model, &effort, &at, &input, &output, &read, &write, &reasoning, &total, &copied) != nil ||
				copied != 0 || seen[id] || !input.Valid || !output.Valid || at <= 0 || model.String == "" {
				continue
			}
			seen[id] = true
			allInput := input.Int64 + read.Int64 + write.Int64
			add("opencode", session, dir, localUsageStep{at: time.UnixMilli(at), model: model.String,
				effort: strings.TrimSpace(effort.String), input: allInput,
				output: openCodeOutput(allInput, output.Int64, reasoning.Int64, total.Int64, index == 0),
				cached: read.Int64, reasoning: reasoning.Int64})
		}
		rows.Close()
	}
}

func openCodeOutput(input, output, reasoning, total int64, v2 bool) int64 {
	// The v2 projection splits visible and reasoning output. Legacy records
	// may include reasoning in output; use their reported total when available.
	if v2 || reasoning > 0 && total == input+output+reasoning {
		return output + reasoning
	}
	return max(output, reasoning)
}

func readOpenCodeJSON(root string, start time.Time, seen map[string]bool, add collectLocalUsage) {
	for _, file := range usageFiles(filepath.Join(root, "message"), start, func(name string) bool {
		return strings.HasSuffix(name, ".json")
	}) {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var msg map[string]any
		if json.Unmarshal(raw, &msg) != nil || msg["role"] != "assistant" {
			continue
		}
		id, session, model := coreString(msg["id"]), coreString(msg["sessionID"]), coreString(msg["modelID"])
		tokens, timing := coreMap(msg["tokens"]), coreMap(msg["time"])
		if id == "" || session == "" || model == "" || seen[id] || !coreSafeInt(tokens["input"]) || !coreSafeInt(tokens["output"]) {
			continue
		}
		at := usageStamp(timing["completed"])
		if at.IsZero() {
			at = usageStamp(timing["created"])
		}
		if at.IsZero() {
			continue
		}
		cache := coreMap(tokens["cache"])
		cached, reasoning := coreNum(cache["read"]), coreNum(tokens["reasoning"])
		input := coreNum(tokens["input"]) + cached + coreNum(cache["write"])
		seen[id] = true
		add("opencode", session, coreString(coreMap(msg["path"])["cwd"]), localUsageStep{
			at: at, model: model, effort: coreString(msg["variant"]), input: input,
			output: openCodeOutput(input, coreNum(tokens["output"]), reasoning, coreNum(tokens["total"]), false),
			cached: cached, reasoning: reasoning,
		})
	}
}
