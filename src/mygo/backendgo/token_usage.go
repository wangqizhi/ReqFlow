package backendgo

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// Usage is optional evidence supplied by a provider, never a text-length estimate.
// Cached input is a subset of input; reasoning output is a subset of output.
func validateTokenUsage(value any) ([]any, error) {
	entries, ok := value.([]any)
	if !ok || len(entries) > 100 {
		return nil, errors.New("usage 须为最多 100 条用量记录的数组")
	}
	result := []any{}
	for _, v := range entries {
		u := coreMap(v)
		model := strings.TrimSpace(coreString(u["model"]))
		if model == "" || len(model) > 200 {
			return nil, errors.New("usage 缺少有效 model")
		}
		if !coreHas(u, "inputTokens") || !coreHas(u, "outputTokens") {
			return nil, errors.New("usage 必须提供实际 inputTokens 与 outputTokens")
		}
		clean := map[string]any{"model": model}
		for _, key := range []string{"inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens"} {
			n := u[key]
			if n == nil {
				n = float64(0)
			}
			if !coreSafeInt(n) || coreNum(n) < 0 {
				return nil, errors.New("usage Token 必须是非负安全整数")
			}
			clean[key] = n
		}
		if coreNum(clean["cachedInputTokens"]) > coreNum(clean["inputTokens"]) || coreNum(clean["reasoningOutputTokens"]) > coreNum(clean["outputTokens"]) {
			return nil, errors.New("usage 缓存或推理 Token 超过所属总量")
		}
		total := coreNum(clean["inputTokens"]) + coreNum(clean["outputTokens"])
		if total > 9007199254740991 {
			return nil, errors.New("usage Token 超出安全整数范围")
		}
		clean["totalTokens"] = total
		for _, key := range []string{"reasoningEffort", "source", "sessionId"} {
			if u[key] != nil {
				if _, ok := u[key].(string); !ok {
					return nil, errors.New("usage 元数据须为文本")
				}
			}
			text := coreString(u[key])
			if len(text) > 300 {
				return nil, errors.New("usage 元数据过长")
			}
			clean[key] = text
		}
		clean["scope"] = "requirement"
		if u["scope"] == "run" {
			if coreString(clean["sessionId"]) == "" {
				return nil, errors.New("共享 usage 缺少 sessionId")
			}
			clean["scope"] = "run"
		}
		result = append(result, clean)
	}
	return result, nil
}

// Read only the exact session inherited from the calling Codex shell. Never
// select a session merely by project directory (parallel chats may share it).
func codexTaskUsage(root, session, start string) []any {
	if session == "" || strings.ContainsAny(session, "/\\*?[]") {
		return nil
	}
	since, err := time.Parse(time.RFC3339Nano, start)
	if err != nil {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	// A task may span midnight. Include its start day through today, bounded to
	// the most recent 31 days; missing/older evidence stays unknown.
	today := time.Now().UTC()
	if today.Sub(since) > 31*24*time.Hour {
		return nil
	}
	var file string
	for day := since.UTC(); !day.After(today); day = day.AddDate(0, 0, 1) {
		matches, _ := filepath.Glob(filepath.Join(codexHome, "sessions", day.Format("2006"), day.Format("01"), day.Format("02"), "*"+session+".jsonl"))
		if len(matches) == 1 {
			file = matches[0]
			break
		}
	}
	if file == "" {
		return nil
	}
	return readCodexTaskUsage(file, root, session, since)
}

func readCodexTaskUsage(file, root, session string, since time.Time) []any {
	log := readCodexUsage(file)
	if log.session != session || log.dir == "" || !strings.EqualFold(filepath.Clean(log.dir), filepath.Clean(root)) {
		return nil
	}
	groups := newUsageGroups("codex-session", session)
	for _, step := range log.steps {
		if step.at.Before(since) || step.firstTotal && log.started.Before(since) {
			continue
		}
		groups.add(step.model, step.effort, step.input-step.cached, step.cached, 0, step.output, step.reasoning)
	}
	valid, err := validateTokenUsage(groups.result())
	if err != nil {
		return nil
	}
	return valid
}

type codexUsageStep struct {
	localUsageStep
	firstTotal bool
	responseID string
}

type codexUsageLog struct {
	session, dir string
	started      time.Time
	steps        []codexUsageStep
	responses    []codexUsageStep
}

func readCodexUsage(file string) codexUsageLog {
	f, err := os.Open(file)
	if err != nil {
		return codexUsageLog{}
	}
	defer f.Close()
	var log codexUsageLog
	var previous [4]int64
	baseline := false
	model, effort := "", ""
	var reader = io.Reader(f)
	if strings.HasSuffix(file, ".zst") {
		decoder, err := zstd.NewReader(f, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return log
		}
		defer decoder.Close()
		reader = decoder
	}
	err = scanJSONLines(reader, func(event map[string]any) {
		payload := coreMap(event["payload"])
		stamp := usageStamp(event["timestamp"])
		if event["type"] == "session_meta" && log.session == "" {
			log.session, log.dir = coreString(payload["id"]), coreString(payload["cwd"])
			log.started = stamp
			model = coreString(payload["model"])
		}
		if event["type"] == "turn_context" {
			model = coreString(payload["model"])
			effort = coreString(payload["effort"])
		}
		if event["type"] == "token_usage_record" {
			usage := coreMap(payload["usage"])
			if id := coreString(payload["response_id"]); id != "" && !stamp.IsZero() && model != "" && coreSafeInt(usage["input_tokens"]) && coreSafeInt(usage["output_tokens"]) {
				log.responses = append(log.responses, codexUsageStep{
					localUsageStep: localUsageStep{at: stamp, model: model, effort: effort,
						input: coreNum(usage["input_tokens"]), output: coreNum(usage["output_tokens"]),
						cached: coreNum(usage["cached_input_tokens"]), reasoning: coreNum(usage["reasoning_output_tokens"])},
					responseID: id,
				})
			}
			return
		}
		if event["type"] != "event_msg" || payload["type"] != "token_count" {
			return
		}
		totals := coreMap(coreMap(payload["info"])["total_token_usage"])
		if !coreSafeInt(totals["input_tokens"]) || !coreSafeInt(totals["output_tokens"]) || stamp.IsZero() {
			return
		}
		var current, delta [4]int64
		valid := true
		for i, key := range [...]string{"input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"} {
			current[i] = coreNum(totals[key])
			delta[i] = current[i] - previous[i]
			valid = valid && delta[i] >= 0
		}
		if valid && model != "" && (delta[0] > 0 || delta[1] > 0) && delta[2] <= delta[0] && delta[3] <= delta[1] {
			log.steps = append(log.steps, codexUsageStep{
				localUsageStep: localUsageStep{at: stamp, model: model, effort: effort, input: delta[0], output: delta[1], cached: delta[2], reasoning: delta[3]},
				firstTotal:     !baseline,
			})
		}
		previous = current
		baseline = true
	})
	if err != nil {
		return codexUsageLog{}
	}
	return log
}
