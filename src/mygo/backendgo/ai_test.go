package backendgo

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRequestAIOpenAIAndAnthropic(t *testing.T) {
	for _, format := range []string{"openai", "anthropic"} {
		t.Run(format, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if body["model"] != "deepseek-flash" {
					t.Error("model not forwarded")
				}
				if r.URL.Query().Get("custom") != "1" {
					t.Error("URL query lost")
				}
				if format == "anthropic" {
					if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "test-key" || r.Header.Get("anthropic-version") != "2023-06-01" || body["system"] != "system" || body["max_tokens"] != float64(2048) {
						t.Error("Anthropic request differs")
					}
					_, _ = w.Write([]byte(`{"content":[{"type":"thinking","text":"hidden"},{"type":"text","text":"hello"},{"type":"text","text":"world"}]}`))
				} else {
					if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-key" || body["reasoning_effort"] != "none" || len(aiArray(body["messages"])) != 2 {
						t.Error("OpenAI request differs")
					}
					_, _ = w.Write([]byte(`{"choices":[{"message":{"content":" hello "}}]}`))
				}
			}))
			defer server.Close()
			var events []AIRequestEvent
			s := AISettings{URL: server.URL + "?custom=1", APIKey: "test-key", Model: "deepseek-flash", Format: format}
			text, err := RequestAI(s, "system", "user", func(e AIRequestEvent) { events = append(events, e) })
			if err != nil {
				t.Fatal(err)
			}
			expected := "hello"
			if format == "anthropic" {
				expected = "hello\nworld"
			}
			if text != expected || len(events) != 3 || events[0].Phase != "request" || events[1].Phase != "response" || events[2].Phase != "complete" {
				t.Fatal("response/trace differs")
			}
		})
	}
}

func TestAIRejectsRedirectAndMalformedContent(t *testing.T) {
	for _, mode := range []string{"redirect", "status", "empty", "invalid"} {
		t.Run(mode, func(t *testing.T) {
			targetHit := false
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetHit = true }))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "redirect":
					http.Redirect(w, r, target.URL, http.StatusFound)
				case "status":
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = w.Write([]byte("test-secret"))
				case "empty":
					_, _ = w.Write([]byte(`{"choices":[]}`))
				case "invalid":
					_, _ = w.Write([]byte("not json"))
				}
			}))
			defer server.Close()
			var events []AIRequestEvent
			_, err := RequestAI(AISettings{URL: server.URL, APIKey: "test-secret", Model: "x", Format: "openai"}, "s", "u", func(e AIRequestEvent) { events = append(events, e) })
			if err == nil || strings.Contains(err.Error(), "test-secret") {
				t.Fatal("AI error missing or leaked server secret")
			}
			if events[len(events)-1].Phase != "error" || targetHit {
				t.Fatal("redirect followed or error trace missing")
			}
		})
	}
}

func TestAIReplyAndCommitParsers(t *testing.T) {
	text := "```json\n" + `{"reply":"讨论","items":[{"title":"标题","body":"需求","type":"feature","priority":"P1","criteria":["可验证"]}]}` + "\n```"
	reply, err := ParseRequirementReply(text)
	if err != nil || reply["reply"] != "讨论" || len(aiArray(reply["items"])) != 1 {
		t.Fatal("valid requirement response rejected")
	}
	for _, invalid := range []string{`{"reply":"x","items":null}`, `{"reply":"x","items":[{"title":"","body":"","type":"feature","priority":"P1","criteria":[]}]}`, `{"reply":"x","items":[{"title":"x","body":"x","type":"system","priority":"P1","criteria":[]}]}`} {
		if _, err := ParseRequirementReply(invalid); err == nil {
			t.Fatal("invalid requirement accepted")
		}
	}
	message, err := NormalizeAICommit("```text\nfeat： REQ-123 · 支持测试\nbugfix: 修复问题\n```")
	if err != nil || message != "feat: 支持测试\nbugfix: 修复问题" {
		t.Fatalf("commit result differs: %v", err)
	}
	if _, err = NormalizeAICommit("Here is your message: feat: x"); err == nil {
		t.Fatal("explanation accepted as commit")
	}
}

func TestAILogsContainMetadataOnly(t *testing.T) {
	b := aiTestBackend(t)
	settings := AISettings{Model: "test-model", Format: "openai", APIKey: "fake-secret-should-not-log", URL: "https://private.example.invalid", RequestLogging: true}
	trace := b.aiTrace(settings)
	for i := 0; i < 503; i++ {
		trace(AIRequestEvent{Phase: "complete", ElapsedMs: 12, Status: 200})
	}
	raw, err := os.ReadFile(filepath.Join(b.DataDir, "ai-request-log.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(settings.APIKey)) || bytes.Contains(raw, []byte(settings.URL)) {
		t.Fatal("AI log leaked config")
	}
	var entries []any
	if err = json.Unmarshal(raw, &entries); err != nil || len(entries) != 500 {
		t.Fatal("AI log retention differs")
	}
}

func TestAIRequirementsChannelUsesGoWorkspace(t *testing.T) {
	b := aiTestBackend(t)
	workspace, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	projects := aiArray(aiMap(workspace["state"])["projects"])
	if len(projects) == 0 {
		t.Fatal("workspace lacks default project")
	}
	id := aiString(aiMap(projects[0])["id"])
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		messages := aiArray(payload["messages"])
		var context map[string]any
		if len(messages) != 2 || json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context) != nil {
			t.Error("AI requirements context missing")
		}
		if context["mode"] != "organize" || context["instruction"] != "整理一个测试需求" || aiMap(context["project"])["name"] == nil {
			t.Error("AI context differs")
		}
		reply := `{"reply":"可以","items":[{"title":"测试","body":"具体需求","type":"feature","priority":"P2","criteria":["通过测试"]}]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": reply}}}})
	}))
	defer server.Close()
	if _, err = b.saveAISettings(aiTestSettings(server.URL)); err != nil {
		t.Fatal(err)
	}
	value, handled, err := b.InvokeAI("ai:requirements", []any{id, "organize", "整理一个测试需求", []any{}})
	if err != nil || !handled || aiMap(value)["ok"] != true || len(aiArray(aiMap(value)["items"])) != 1 {
		t.Fatalf("Go requirements channel failed: %v", err)
	}
}

func TestAICommitChannelUsesActualStagedGitDiff(t *testing.T) {
	b := aiTestBackend(t)
	workspace, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	projects := aiArray(aiMap(workspace["state"])["projects"])
	if len(projects) == 0 {
		t.Fatal("workspace lacks default project")
	}
	id := aiString(aiMap(projects[0])["id"])
	repo := t.TempDir()
	if _, err = RunRemoteGit([]string{"init"}, repo, nil); err != nil {
		t.Skip("Git not available")
	}
	if err = os.WriteFile(filepath.Join(repo, "change.txt"), []byte("staged-fact\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = RunRemoteGit([]string{"add", "--", "change.txt"}, repo, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": id, "dir": repo}, nil); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		messages := aiArray(payload["messages"])
		var context map[string]any
		if len(messages) != 2 || json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context) != nil {
			t.Error("AI commit context missing")
		}
		if !strings.Contains(aiString(context["stagedDiff"]), "staged-fact") || strings.Contains(aiString(context["draft"]), "REQ-") {
			t.Error("AI commit omitted staged facts or retained tracking ID")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "feat: REQ-999 · 新增测试行为"}}}})
	}))
	defer server.Close()
	if _, err = b.saveAISettings(aiTestSettings(server.URL)); err != nil {
		t.Fatal(err)
	}
	value, handled, err := b.InvokeAI("ai:commit:optimize", []any{id, "REQ-999 草稿"})
	if err != nil || !handled || aiMap(value)["message"] != "feat: 新增测试行为" {
		t.Fatalf("Go AI commit channel failed: %v", err)
	}
}
