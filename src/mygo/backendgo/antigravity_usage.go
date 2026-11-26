package backendgo

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var antigravityUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type antigravityRun struct {
	project                      string
	start, end, completedThrough time.Time
	completed                    map[string]bool
	reported                     bool
}

type antigravityStep struct {
	time                  time.Time
	model                 string
	input, cached, output int64
}

type antigravityTranscript struct {
	session string
	runs    map[string]bool
	steps   []antigravityStep
}

func addAntigravityWindow(runs map[string]*antigravityRun, project string, execution map[string]any, end time.Time) *antigravityRun {
	id, start := coreString(execution["runId"]), usageStamp(execution["startedAt"])
	if !antigravityUUID.MatchString(id) || start.IsZero() || !end.After(start) {
		return nil
	}
	run := runs[id]
	if run == nil {
		run = &antigravityRun{project: project, start: start, end: end, completed: map[string]bool{}}
		runs[id] = run
	}
	if end.After(run.end) {
		run.end = end
	}
	return run
}

// Read at dashboard time so already-completed tasks can use their local
// transcripts and the completion tool call has had time to be flushed to disk.
func antigravityRoots(home string) []string {
	roots := []string{filepath.Join(home, ".config", "antigravity")}
	for _, name := range []string{"antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup", "antigravity-acp"} {
		roots = append(roots, filepath.Join(home, ".gemini", name))
	}
	if override := os.Getenv("ANTIGRAVITY_DATA_DIR"); override != "" {
		roots = append([]string{override}, roots...)
	}
	return roots
}

func antigravityStatsUsage(home string, state map[string]any) map[string][]any {
	runs := map[string]*antigravityRun{}
	now := time.Now()
	for _, p := range coreList(state["projects"]) {
		project := coreMap(p)
		projectID := coreString(project["id"])
		for _, i := range coreList(project["items"]) {
			item := coreMap(i)
			if active := ActiveAIExecution(item); active["client"] == "antigravity" {
				addAntigravityWindow(runs, projectID, active, now)
			}
			for _, h := range coreList(item["history"]) {
				event := coreMap(h)
				if event["event"] != "实现完成" && event["event"] != "释放 AI 任务" {
					continue
				}
				execution := coreMap(event["execution"])
				id := coreString(execution["runId"])
				legacy := execution["client"] == "pi" && strings.HasPrefix(coreString(event["note"]), "[ReqFlow Antigravity run "+id+"]\n")
				if execution["client"] != "antigravity" && !legacy {
					continue
				}
				end := usageStamp(event["time"])
				run := addAntigravityWindow(runs, projectID, execution, end)
				if run != nil && event["event"] == "实现完成" {
					run.completed[coreString(item["id"])] = true
					run.reported = run.reported || len(coreList(event["usage"])) > 0
					if end.After(run.completedThrough) {
						run.completedThrough = end
					}
				}
			}
		}
	}

	result := map[string][]any{}
	var earliest time.Time
	for _, run := range runs {
		if !run.reported && len(run.completed) > 0 && (earliest.IsZero() || run.start.Before(earliest)) {
			earliest = run.start
		}
	}
	if home == "" || earliest.IsZero() {
		return result
	}

	linked := map[string]*antigravityTranscript{}
	ambiguous := map[string]bool{}
	for _, root := range antigravityRoots(home) {
		brain := filepath.Join(root, "brain")
		entries, _ := os.ReadDir(brain)
		for _, entry := range entries {
			if !entry.IsDir() || !antigravityUUID.MatchString(entry.Name()) {
				continue
			}
			logs := filepath.Join(brain, entry.Name(), ".system_generated", "logs")
			file := filepath.Join(logs, "transcript_full.jsonl")
			info, err := os.Stat(file)
			if os.IsNotExist(err) {
				file = filepath.Join(logs, "transcript.jsonl")
				info, err = os.Stat(file)
			}
			if err != nil || !info.Mode().IsRegular() || info.ModTime().Before(earliest) {
				continue
			}
			transcript := readAntigravityTranscript(file, entry.Name(), runs)
			for id := range transcript.runs {
				previous := linked[id]
				if previous != nil && previous.session != transcript.session {
					ambiguous[id] = true
				}
				if previous == nil || len(previous.steps) < len(transcript.steps) {
					linked[id] = transcript
				}
			}
		}
	}

	for id, transcript := range linked {
		run := runs[id]
		if ambiguous[id] || run.reported || len(run.completed) == 0 {
			continue
		}
		groups := newUsageGroups("antigravity-session", transcript.session)
		for _, step := range transcript.steps {
			if step.time.Before(run.start) || step.time.After(run.completedThrough) {
				continue
			}
			overlaps := false
			// Parallel runs in this conversation can share model steps. Exclude
			// their overlapping intervals because ownership cannot be determined.
			for otherID := range transcript.runs {
				other := runs[otherID]
				if otherID != id && !step.time.Before(other.start) && !step.time.After(other.end) {
					overlaps = true
					break
				}
			}
			if !overlaps {
				// The transcript reports uncached input and cache reads separately.
				groups.add(step.model, "", step.input, step.cached, 0, step.output, 0)
			}
		}
		if rows, err := validateTokenUsage(groups.result()); err == nil && len(rows) > 0 {
			result[id] = rows
		}
	}
	return result
}

func antigravityRunID(file string) string {
	name := path.Base(strings.ReplaceAll(file, `\`, "/"))
	id, ok := strings.CutSuffix(name, ".json")
	if !ok {
		return ""
	}
	return id
}

func decodeAntigravityReceipt(content string) (string, string, bool) {
	if !strings.Contains(content, `"runFile"`) {
		return "", "", false
	}
	for offset := 0; offset < len(content); {
		rel := strings.IndexByte(content[offset:], '{')
		if rel < 0 {
			return "", "", false
		}
		offset += rel
		var receipt struct {
			OK      bool                `json:"ok"`
			RunFile string              `json:"runFile"`
			Project struct{ ID string } `json:"project"`
		}
		if json.NewDecoder(strings.NewReader(content[offset:])).Decode(&receipt) == nil && receipt.OK {
			if id := antigravityRunID(receipt.RunFile); id != "" && receipt.Project.ID != "" {
				return id, receipt.Project.ID, true
			}
		}
		offset++
	}
	return "", "", false
}

func antigravityReadCommand(command string) bool {
	lower := strings.ToLower(command)
	if !strings.Contains(lower, "reqflow.mjs") {
		return false
	}
	for _, field := range strings.Fields(lower) {
		if strings.Trim(field, `"'`) == "read" {
			return true
		}
	}
	return false
}

func readAntigravityTranscript(file, session string, runs map[string]*antigravityRun) *antigravityTranscript {
	transcript := &antigravityTranscript{session: session, runs: map[string]bool{}}
	f, err := os.Open(file)
	if err != nil {
		return transcript
	}
	defer f.Close()

	readRequested := false
	seen := map[int64]bool{}
	err = scanJSONLines(f, func(event map[string]any) {
		if event["type"] == "GENERIC" {
			if readRequested && event["status"] == "DONE" {
				if id, projectID, ok := decodeAntigravityReceipt(coreString(event["content"])); ok {
					if run := runs[id]; run != nil && projectID == run.project {
						transcript.runs[id] = true
					}
				}
			}
			return
		}
		readRequested = false
		if event["type"] != "PLANNER_RESPONSE" || event["status"] != "DONE" {
			return
		}
		stamp := usageStamp(event["created_at"])
		for _, value := range coreList(event["tool_calls"]) {
			tool := coreMap(value)
			args := coreMap(tool["args"])
			if tool["name"] == "run_command" {
				if antigravityReadCommand(coreString(args["CommandLine"])) {
					readRequested = true
				}
				continue
			}
			if tool["name"] != "call_mcp_tool" || !coreIn(coreString(args["ServerName"]), "reqflow", "reqflow-agent-antigravity_reqflow") {
				continue
			}
			input := coreMap(args["Arguments"])
			switch args["ToolName"] {
			case "reqflow_read":
				if input["execute"] == true {
					readRequested = true
				}
			case "reqflow_complete":
				id := antigravityRunID(coreString(input["runFile"]))
				if run := runs[id]; run != nil && !stamp.Before(run.start) && !stamp.After(run.end) {
					for _, item := range coreList(input["items"]) {
						if run.completed[coreString(coreMap(item)["id"])] {
							transcript.runs[id] = true
							break
						}
					}
				}
			}
		}

		index := coreNum(event["step_index"])
		model := strings.TrimSpace(coreString(event["model"]))
		input, cached, output := event["input_tokens"], event["cache_read_tokens"], event["output_tokens"]
		if cached == nil {
			cached = int64(0)
		}
		if event["source"] != "MODEL" || stamp.IsZero() || !coreSafeInt(event["step_index"]) || seen[index] || model == "" ||
			!coreSafeInt(input) || !coreSafeInt(cached) || !coreSafeInt(output) || coreNum(input) < 0 || coreNum(cached) < 0 || coreNum(output) < 0 {
			return
		}
		seen[index] = true
		transcript.steps = append(transcript.steps, antigravityStep{time: stamp, model: model, input: coreNum(input), cached: coreNum(cached), output: coreNum(output)})
	})
	if err != nil {
		return &antigravityTranscript{}
	}
	return transcript
}
