package backendgo

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

// REQ-278：除 Codex 外，Claude Code、Pi、ZCode 与 DeepSeek Harness 也从本机
// 精确会话记录读取领取之后的实际用量。只按会话 ID 定位，并核对会话目录属于
// 项目；找不到、格式不符或无法核对时返回 nil，界面保持「未采集」，不估算。
// 各客户端的输入 Token 不含缓存，这里统一换算为「输入含缓存、缓存是输入子集」。

// taskUsage 选择领取客户端对应的会话读取方式。session 为空时回退到宿主继承的环境变量。
func taskUsage(client, root, session, start string) []any {
	since, err := time.Parse(time.RFC3339Nano, start)
	if err != nil || time.Since(since) > 31*24*time.Hour {
		return nil
	}
	if session == "" {
		session = os.Getenv(map[string]string{"codex": "CODEX_THREAD_ID", "claude-code": "CLAUDE_CODE_SESSION_ID", "zcode": "ZCODE_SESSION_ID"}[client])
	}
	session = strings.TrimSpace(session)
	if session == "" || strings.ContainsAny(session, "/\\*?[]") || strings.Contains(session, "..") {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var rows []any
	switch client {
	case "codex":
		return codexTaskUsage(root, session, start)
	case "claude-code":
		dir := os.Getenv("CLAUDE_CONFIG_DIR")
		if dir == "" {
			dir = filepath.Join(home, ".claude")
		}
		effort := ""
		if os.Getenv("CLAUDE_CODE_SESSION_ID") == session {
			effort = os.Getenv("CLAUDE_EFFORT")
		}
		rows = readClaudeTaskUsage(uniqueGlob(filepath.Join(dir, "projects", "*", session+".jsonl")), root, session, effort, since)
	case "pi":
		dir := os.Getenv("PI_CODING_AGENT_DIR")
		if dir == "" {
			dir = filepath.Join(home, ".pi", "agent")
		}
		rows = readPiTaskUsage(uniqueGlob(filepath.Join(dir, "sessions", "*", "*_"+session+".jsonl")), root, session, since)
	case "zcode":
		dir := filepath.Join(home, ".zcode", "cli")
		if !zcodeSessionInRoot(filepath.Join(dir, "db", "db.sqlite"), session, root) {
			return nil
		}
		rows = readZCodeTaskUsage(filepath.Join(dir, "rollout", "model-io-"+session+".jsonl"), session, since)
	case "dsh":
		rows = readDshTaskUsage(uniqueGlob(filepath.Join(home, ".dsh", "sessions", "*", session, "session.v4.jsonl.zstd")), root, session, since)
	}
	if len(rows) == 0 {
		return nil
	}
	valid, err := validateTokenUsage(rows)
	if err != nil {
		return nil
	}
	return valid
}

func uniqueGlob(pattern string) string {
	matches, _ := filepath.Glob(pattern)
	if len(matches) != 1 {
		return ""
	}
	return matches[0]
}

// 会话目录可以是项目根目录或其子目录（Agent 在执行中会 cd 到子目录）。
func usageDirInRoot(dir, root string) bool {
	if dir == "" || root == "" {
		return false
	}
	rel, err := filepath.Rel(filepath.Clean(strings.ToLower(root)), filepath.Clean(strings.ToLower(dir)))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// usageGroups 按模型与思考等级累加，生成 scope=run 的共享用量。
type usageGroups struct {
	source, session string
	rows            map[string]map[string]any
	order           []string
}

func newUsageGroups(source, session string) *usageGroups {
	return &usageGroups{source: source, session: session, rows: map[string]map[string]any{}}
}

// add 接收不含缓存的输入、缓存读取/写入与输出，换算为 ReqFlow 用量结构。
func (g *usageGroups) add(model, effort string, input, cacheRead, cacheWrite, output, reasoning int64) {
	if model == "" || input < 0 || cacheRead < 0 || cacheWrite < 0 || output < 0 || reasoning < 0 {
		return
	}
	if reasoning > output {
		reasoning = output
	}
	key := model + "\x00" + effort
	u := g.rows[key]
	if u == nil {
		u = map[string]any{"model": model, "reasoningEffort": effort, "source": g.source, "sessionId": g.session, "scope": "run"}
		g.rows[key] = u
		g.order = append(g.order, key)
	}
	u["inputTokens"] = coreNum(u["inputTokens"]) + input + cacheRead + cacheWrite
	u["cachedInputTokens"] = coreNum(u["cachedInputTokens"]) + cacheRead
	u["outputTokens"] = coreNum(u["outputTokens"]) + output
	u["reasoningOutputTokens"] = coreNum(u["reasoningOutputTokens"]) + reasoning
}

func (g *usageGroups) result() []any {
	out := []any{}
	for _, key := range g.order {
		out = append(out, g.rows[key])
	}
	return out
}

func scanJSONLines(r io.Reader, fn func(map[string]any)) error {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 65536), 64*1024*1024)
	for scan.Scan() {
		var event map[string]any
		if json.Unmarshal(scan.Bytes(), &event) == nil {
			fn(event)
		}
	}
	return scan.Err()
}

func usageStamp(v any) time.Time {
	if s, ok := v.(string); ok {
		t, _ := time.Parse(time.RFC3339Nano, s)
		return t
	}
	if n, ok := v.(float64); ok && n > 0 {
		return time.UnixMilli(int64(n))
	}
	return time.Time{}
}

// Claude Code：同一条模型回复按内容块写成多行且重复携带 usage，按 message.id 去重。
func readClaudeTaskUsage(file, root, session, effort string, since time.Time) []any {
	if file == "" {
		return nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	verified := false
	seen := map[string]bool{}
	groups := newUsageGroups("claude-code-session", session)
	err = scanJSONLines(f, func(e map[string]any) {
		if coreString(e["sessionId"]) != "" && coreString(e["sessionId"]) != session {
			return
		}
		if usageDirInRoot(coreString(e["cwd"]), root) {
			verified = true
		}
		msg := coreMap(e["message"])
		usage := coreMap(msg["usage"])
		id := coreString(msg["id"])
		if e["type"] != "assistant" || len(usage) == 0 || id == "" || seen[id] || usageStamp(e["timestamp"]).Before(since) {
			return
		}
		seen[id] = true
		groups.add(coreString(msg["model"]), effort, coreNum(usage["input_tokens"]), coreNum(usage["cache_read_input_tokens"]), coreNum(usage["cache_creation_input_tokens"]), coreNum(usage["output_tokens"]), coreNum(coreMap(usage["output_tokens_details"])["thinking_tokens"]))
	})
	if err != nil || !verified {
		return nil
	}
	return groups.result()
}

// Pi：首行 session 记录会话 ID 与目录，assistant 消息带 usage 与 thinkingLevel。
func readPiTaskUsage(file, root, session string, since time.Time) []any {
	if file == "" {
		return nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	verified := false
	groups := newUsageGroups("pi-session", session)
	err = scanJSONLines(f, func(e map[string]any) {
		if e["type"] == "session" {
			verified = coreString(e["id"]) == session && usageDirInRoot(coreString(e["cwd"]), root)
			return
		}
		msg := coreMap(e["message"])
		usage := coreMap(msg["usage"])
		if !verified || e["type"] != "message" || msg["role"] != "assistant" || len(usage) == 0 || usageStamp(e["timestamp"]).Before(since) {
			return
		}
		groups.add(coreString(msg["model"]), coreString(msg["thinkingLevel"]), coreNum(usage["input"]), coreNum(usage["cacheRead"]), coreNum(usage["cacheWrite"]), coreNum(usage["output"]), coreNum(usage["reasoning"]))
	})
	if err != nil || !verified {
		return nil
	}
	return groups.result()
}

// ZCode：会话目录登记在本机 SQLite，只读打开核对；模型调用记录在 rollout/model-io-<会话>.jsonl。
func zcodeSessionInRoot(dbFile, session, root string) bool {
	if _, err := os.Stat(dbFile); err != nil {
		return false
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbFile)+"?mode=ro&_pragma=busy_timeout(2000)")
	if err != nil {
		return false
	}
	defer db.Close()
	var dir string
	if db.QueryRow("select directory from session where id = ?", session).Scan(&dir) != nil {
		return false
	}
	return usageDirInRoot(dir, root)
}

func readZCodeTaskUsage(file, session string, since time.Time) []any {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	seen := map[string]bool{}
	groups := newUsageGroups("zcode-session", session)
	err = scanJSONLines(f, func(e map[string]any) {
		usage := coreMap(coreMap(e["response"])["usage"])
		id := coreString(e["requestId"]) + "\x00" + coreString(e["attempt"])
		if e["type"] != "model_io" || coreString(e["sessionId"]) != session || len(usage) == 0 || seen[id] || usageStamp(e["completedAt"]).Before(since) {
			return
		}
		seen[id] = true
		effort := coreString(coreMap(coreMap(coreMap(e["request"])["body"])["output_config"])["effort"])
		groups.add(coreString(coreMap(e["model"])["modelId"]), effort, coreNum(usage["inputTokens"]), coreNum(usage["cacheReadTokens"]), coreNum(usage["cacheWriteTokens"]), coreNum(usage["outputTokens"]), coreNum(usage["reasoningTokens"]))
	})
	if err != nil {
		return nil
	}
	return groups.result()
}

// DeepSeek Harness：会话以 zstd 压缩 JSONL 保存，首行 session 记录 ID 与目录。
func readDshTaskUsage(file, root, session string, since time.Time) []any {
	if file == "" {
		return nil
	}
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	decoder, err := zstd.NewReader(f, zstd.WithDecoderConcurrency(1))
	if err != nil {
		return nil
	}
	defer decoder.Close()
	verified := false
	groups := newUsageGroups("dsh-session", session)
	err = scanJSONLines(decoder, func(e map[string]any) {
		if e["type"] == "session" {
			verified = coreString(e["id"]) == session && usageDirInRoot(coreString(e["cwd"]), root)
			return
		}
		data := coreMap(e["data"])
		usage := coreMap(data["usage"])
		if !verified || e["type"] != "assistant/message" || len(usage) == 0 || usageStamp(e["time"]).Before(since) {
			return
		}
		source := coreMap(coreMap(data["message"])["source"])
		groups.add(coreString(source["model"]), "", coreNum(usage["inputTokens"]), coreNum(usage["cacheReadTokens"]), coreNum(usage["cacheWriteTokens"]), coreNum(usage["outputTokens"]), coreNum(usage["reasoningTokens"]))
	})
	if err != nil || !verified {
		return nil
	}
	return groups.result()
}
