package backendgo

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
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
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 65536), 8*1024*1024)
	verified, baseline := false, false
	model, effort := "", ""
	previous := map[string]int64{}
	groups := map[string]map[string]any{}
	for scan.Scan() {
		var event map[string]any
		if json.Unmarshal(scan.Bytes(), &event) != nil {
			continue
		}
		payload := coreMap(event["payload"])
		stamp, _ := time.Parse(time.RFC3339Nano, coreString(event["timestamp"]))
		if event["type"] == "session_meta" {
			verified = payload["id"] == session && strings.EqualFold(filepath.Clean(coreString(payload["cwd"])), filepath.Clean(root))
			baseline = !stamp.Before(since)
		}
		if event["type"] == "turn_context" {
			model = coreString(payload["model"])
			effort = coreString(payload["effort"])
		}
		if payload["type"] != "token_count" {
			continue
		}
		totals := coreMap(coreMap(payload["info"])["total_token_usage"])
		if len(totals) == 0 {
			continue
		}
		current := map[string]int64{}
		for _, key := range []string{"input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"} {
			current[key] = coreNum(totals[key])
		}
		if verified && baseline && !stamp.Before(since) && model != "" {
			key := model + "\x00" + effort
			u := groups[key]
			if u == nil {
				u = map[string]any{"model": model, "reasoningEffort": effort, "source": "codex-session", "sessionId": session, "scope": "run"}
				groups[key] = u
			}
			for from, to := range map[string]string{"input_tokens": "inputTokens", "output_tokens": "outputTokens", "cached_input_tokens": "cachedInputTokens", "reasoning_output_tokens": "reasoningOutputTokens"} {
				delta := current[from] - previous[from]
				if delta < 0 {
					return nil
				}
				u[to] = coreNum(u[to]) + delta
			}
		}
		previous = current
		baseline = true
	}
	if scan.Err() != nil || !verified {
		return nil
	}
	result := []any{}
	for _, u := range groups {
		result = append(result, u)
	}
	valid, err := validateTokenUsage(result)
	if err != nil {
		return nil
	}
	return valid
}
