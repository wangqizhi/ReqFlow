package backendgo

import (
	"database/sql"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type localUsageStep struct {
	at                time.Time
	model, effort     string
	input, output     int64
	cached, reasoning int64
}

type localUsageKey struct {
	ProjectID string `json:"projectId"`
	Client    string `json:"client"`
	Session   string `json:"sessionId"`
	Day       string `json:"day"`
	Model     string `json:"model"`
	Effort    string `json:"reasoningEffort"`
}

type localUsageRow struct {
	localUsageKey
	Input     int64 `json:"inputTokens"`
	Output    int64 `json:"outputTokens"`
	Cached    int64 `json:"cachedInputTokens"`
	Reasoning int64 `json:"reasoningOutputTokens"`
}

type statsUsageWindow struct {
	project, session string
	start, end       time.Time
}

// Keep the existing task report as the source of truth for covered execution
// windows. Only suppress other sessions when the report lacks a session ID.
func statsUsageWindows(state map[string]any, recovered map[string][]any) map[string][]statsUsageWindow {
	windows := map[string][]statsUsageWindow{}
	for _, p := range coreList(state["projects"]) {
		project := coreMap(p)
		for _, i := range coreList(project["items"]) {
			for _, h := range coreList(coreMap(i)["history"]) {
				event := coreMap(h)
				if event["event"] != "实现完成" {
					continue
				}
				execution := coreMap(event["execution"])
				client, run := coreString(execution["client"]), coreString(execution["runId"])
				if client == "pi" && run != "" {
					for _, legacy := range []string{"Antigravity", "OpenCode"} {
						if strings.HasPrefix(coreString(event["note"]), "[ReqFlow "+legacy+" run "+run+"]\n") {
							client = strings.ToLower(legacy)
						}
					}
				}
				start, end := usageStamp(execution["startedAt"]), usageStamp(event["time"])
				if client == "" || start.IsZero() || end.Before(start) {
					continue
				}
				usage := coreList(event["usage"])
				if len(usage) == 0 {
					usage = recovered[run]
				}
				sessions := map[string]bool{}
				for _, u := range usage {
					sessions[coreString(coreMap(u)["sessionId"])] = true
				}
				for session := range sessions {
					windows[client] = append(windows[client], statsUsageWindow{coreString(project["id"]), session, start, end})
				}
			}
		}
	}
	return windows
}

func localStatsUsage(home string, state map[string]any, recovered map[string][]any, start time.Time) []localUsageRow {
	projects := coreList(state["projects"])
	windows := statsUsageWindows(state, recovered)
	rows := map[localUsageKey]localUsageRow{}
	collect := func(client, session, dir string, step localUsageStep) {
		if session == "" || step.at.IsZero() || step.at.Before(start) || step.model == "" ||
			step.input < 0 || step.output < 0 || step.cached < 0 || step.reasoning < 0 ||
			step.cached > step.input || step.reasoning > step.output || step.input > 9007199254740991-step.output ||
			step.input+step.output == 0 {
			return
		}
		project := localUsageProject(dir, projects)
		if project == "" {
			// A task link can identify a project even for stores without a cwd.
			for _, window := range windows[client] {
				if window.session == session {
					if project != "" && project != window.project {
						project = ""
						break
					}
					project = window.project
				}
			}
		}
		for _, window := range windows[client] {
			if step.at.Before(window.start) || step.at.After(window.end) {
				continue
			}
			if window.session == session || window.session == "" && (window.project == project || project == "" && dir == "") {
				return
			}
		}
		key := localUsageKey{project, client, session, step.at.Local().Format("2006-01-02"), step.model, step.effort}
		row := rows[key]
		row.localUsageKey = key
		row.Input += step.input
		row.Output += step.output
		row.Cached += step.cached
		row.Reasoning += step.reasoning
		rows[key] = row
	}
	if home != "" {
		collectCodexStats(home, start, collect)
		collectClaudeStats(home, start, collect)
		collectOpenCodeStats(home, start, collect)
		collectAntigravityStats(home, start, collect)
	}
	result := make([]localUsageRow, 0, len(rows))
	for _, row := range rows {
		result = append(result, row)
	}
	sort.Slice(result, func(i, j int) bool {
		a, b := result[i].localUsageKey, result[j].localUsageKey
		if a.Day != b.Day {
			return a.Day > b.Day
		}
		return strings.Join([]string{a.Client, a.ProjectID, a.Session, a.Model, a.Effort}, "\x00") <
			strings.Join([]string{b.Client, b.ProjectID, b.Session, b.Model, b.Effort}, "\x00")
	})
	return result
}

func localUsageProject(dir string, projects []any) string {
	if !filepath.IsAbs(dir) {
		return ""
	}
	best, length := "", 0
	for _, p := range projects {
		project := coreMap(p)
		root := coreString(project["dir"])
		if !filepath.IsAbs(root) || !usageDirInRoot(dir, root) {
			continue
		}
		size := len(filepath.Clean(root))
		if size > length {
			best, length = coreString(project["id"]), size
		} else if size == length {
			best = ""
		}
	}
	return best
}

type collectLocalUsage func(client, session, dir string, step localUsageStep)

func usageFiles(root string, start time.Time, accept func(string) bool) []string {
	files := []string{}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err == nil && entry.Type().IsRegular() && accept(entry.Name()) {
			if info, err := entry.Info(); err == nil && !info.ModTime().Before(start) {
				files = append(files, path)
			}
		}
		return nil
	})
	return files
}

func collectCodexStats(home string, start time.Time, add collectLocalUsage) {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		dir = filepath.Join(home, ".codex")
	}
	logs := map[string]codexUsageLog{}
	for _, root := range []string{"sessions", "archived_sessions"} {
		for _, file := range usageFiles(filepath.Join(dir, root), start, func(name string) bool {
			return strings.HasPrefix(name, "rollout-") && (strings.HasSuffix(name, ".jsonl") || strings.HasSuffix(name, ".jsonl.zst"))
		}) {
			log := readCodexUsage(file)
			old := logs[log.session]
			if log.session != "" && len(log.steps)+len(log.responses) > len(old.steps)+len(old.responses) {
				logs[log.session] = log
			}
		}
	}
	sessions := make([]string, 0, len(logs))
	for session := range logs {
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		a, b := logs[sessions[i]].started, logs[sessions[j]].started
		if a.Equal(b) {
			return sessions[i] < sessions[j]
		}
		return a.Before(b)
	})
	seenResponses := map[string]bool{}
	for _, session := range sessions {
		log := logs[session]
		for _, step := range log.steps {
			if len(log.responses) == 0 || step.at.Before(log.responses[0].at) {
				add("codex", session, log.dir, step.localUsageStep)
			}
		}
		for _, step := range log.responses {
			if !seenResponses[step.responseID] {
				add("codex", session, log.dir, step.localUsageStep)
				seenResponses[step.responseID] = true
			}
		}
	}
}

func collectClaudeStats(home string, start time.Time, add collectLocalUsage) {
	dir := os.Getenv("CLAUDE_CONFIG_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".claude")
	}
	seen := map[string]bool{}
	for _, file := range usageFiles(filepath.Join(dir, "projects"), start, func(name string) bool {
		return strings.HasSuffix(name, ".jsonl")
	}) {
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		_ = scanJSONLines(f, func(e map[string]any) {
			msg := coreMap(e["message"])
			id, session := coreString(msg["id"]), coreString(e["sessionId"])
			usage := coreMap(msg["usage"])
			if e["type"] != "assistant" || id == "" || session == "" || seen[id] || len(usage) == 0 {
				return
			}
			at, dir := usageStamp(e["timestamp"]), coreString(e["cwd"])
			if at.IsZero() || dir == "" {
				return
			}
			seen[id] = true
			add("claude-code", session, dir, claudeUsageStep(msg, at, ""))
		})
		f.Close()
	}
}

func openUsageDB(file string) (*sql.DB, error) {
	path := filepath.ToSlash(file)
	if filepath.VolumeName(file) != "" && !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	uri := url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro&_pragma=busy_timeout(500)"}
	return sql.Open("sqlite", uri.String())
}
