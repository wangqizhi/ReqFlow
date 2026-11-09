package backendgo

import (
	"bytes"
	"encoding/json"
	"io"
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
				if r.UserAgent() != "ReqFlow/dev" || r.Header.Get("x-opencode-session") != "" {
					t.Error("client identification or provider scoping differs")
				}
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

func TestAISettingsConnectionTestUsesDraftAndChecksReply(t *testing.T) {
	reply := "OK"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.UserAgent() != "ReqFlow/9.8.7" {
			t.Error("connection test must identify the running app version")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body["model"] != "draft-model" {
			t.Error("draft model was not used")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": reply}}}})
	}))
	defer server.Close()
	b := &Backend{Version: "9.8.7"}
	settings := map[string]any{"provider": "test", "url": server.URL, "apiKey": "test", "model": "draft-model", "format": "openai"}
	result, handled, err := b.InvokeAI("ai:settings:test", []any{settings})
	if err != nil || !handled || coreMap(result)["ok"] != true {
		t.Fatalf("connection test failed: %v", err)
	}
	reply = "no"
	_, _, err = b.InvokeAI("ai:settings:test", []any{settings})
	if err == nil {
		t.Fatal("unexpected response accepted")
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

func TestAIRequirementChatReplyFormats(t *testing.T) {
	const markdown = "### 讨论要点\n\n- **保留**候选需求"
	const candidate = `{"reply":"## 已整理","items":[{"title":"标题","body":"内容含有 { 和 }","type":"feature","priority":"P1","criteria":[]}]}`
	for _, tc := range []struct {
		name, input, reply string
		items              int // -1 means retain existing drafts.
	}{
		{"markdown", markdown, markdown, -1},
		{"reply only", `{"reply":"继续讨论"}`, "继续讨论", -1},
		{"wrapped candidates", "整理如下：\n\n```JSON\n" + candidate + "\n```\n可以继续修改。", "## 已整理", 1},
		{"empty candidates", `{"reply":"已清空","items":[]}`, "已清空", 0},
		{"markdown example", "```json\n{\"example\":true}\n```", "```json\n{\"example\":true}\n```", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := parseRequirementReply(tc.input, true)
			if err != nil || result["reply"] != tc.reply {
				t.Fatalf("unexpected reply: %v, %v", result, err)
			}
			if tc.items == -1 {
				if !coreHas(result, "items") || result["items"] != nil {
					t.Fatalf("discussion would replace drafts: %v", result)
				}
			} else if items, ok := result["items"].([]any); !ok || len(items) != tc.items {
				t.Fatalf("unexpected candidates: %v", result)
			}
		})
	}
	for _, input := range []string{
		"整理如下：\n```json\n" + strings.TrimSuffix(candidate, "}"),
		`{"reply":"已整理","items":[{"body":""}]}`,
	} {
		if _, err := parseRequirementReply(input, true); err == nil {
			t.Fatal("invalid candidate response accepted")
		}
	}
	drafts := []any{map[string]any{"id": "existing"}}
	result, err := parseRequirementResponse(`{"reply":"继续讨论","items":[]}`, true, drafts)
	if err != nil || len(aiArray(result["items"])) != 1 || aiMap(aiArray(result["items"])[0])["id"] != "existing" {
		t.Fatalf("empty legacy response discarded an existing draft: %v, %v", result, err)
	}
}

func TestAIRequirementChatSendsImagesAndRetainsDrafts(t *testing.T) {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMr8AAAAASUVORK5CYII="
	for _, format := range []string{"openai", "anthropic"} {
		t.Run(format, func(t *testing.T) {
			b := aiTestBackend(t)
			workspace, err := b.Workspace.Get()
			if err != nil {
				t.Fatal(err)
			}
			project := aiMap(aiArray(aiMap(workspace["state"])["projects"])[0])
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]any
				_ = json.NewDecoder(r.Body).Decode(&payload)
				messages := aiArray(payload["messages"])
				parts := aiArray(aiMap(messages[len(messages)-1])["content"])
				if len(parts) != 2 {
					t.Error("expected text and image parts")
					http.Error(w, "missing parts", http.StatusBadRequest)
					return
				}
				var context map[string]any
				if err := json.Unmarshal([]byte(aiString(aiMap(parts[0])["text"])), &context); err != nil ||
					context["mode"] != "chat" || context["imageTurn"] != "previous" ||
					len(aiArray(context["discussion"])) != 1 || len(aiArray(context["currentDrafts"])) != 1 ||
					aiMap(context["project"])["name"] != project["name"] {
					t.Errorf("unexpected chat context: %v", err)
				}
				image := aiMap(parts[1])
				reply := `{"reply":"继续讨论","items":null}`
				if format == "anthropic" {
					source := aiMap(image["source"])
					if image["type"] != "image" || source["media_type"] != "image/png" || source["data"] != png {
						t.Error("invalid Anthropic image block")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]any{"type": "text", "text": reply}}})
				} else {
					if image["type"] != "image_url" || aiMap(image["image_url"])["url"] != "data:image/png;base64,"+png {
						t.Error("invalid OpenAI image block")
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": reply}}}})
				}
			}))
			defer server.Close()
			settings := aiTestSettings(server.URL)
			settings["format"] = format
			if _, err = b.saveAISettings(settings); err != nil {
				t.Fatal(err)
			}
			args := []any{project["id"], "chat", "讨论上张图", []any{map[string]any{"role": "user", "content": "截图"}}, []any{"data:image/png;base64," + png}, "previous", []any{map[string]any{"id": "candidate-1", "title": "已有候选"}}}
			value, handled, err := b.InvokeAI("ai:requirements", args)
			result := aiMap(value)
			if err != nil || !handled || result["reply"] != "继续讨论" || !coreHas(result, "items") || result["items"] != nil {
				t.Fatalf("chat request failed: %v, %v", result, err)
			}
			args[4] = []any{"data:image/png;base64,SGVsbG8="}
			if _, _, err := b.InvokeAI("ai:requirements", args); err == nil {
				t.Fatal("accepted non-image attachment")
			}
		})
	}
}

func TestAIChatPreparedContextExcludesDisabledSources(t *testing.T) {
	b := aiTestBackend(t)
	workspace, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	project := aiMap(aiArray(aiMap(workspace["state"])["projects"])[0])
	id := aiString(project["id"])
	sources := map[string]any{"overview": false, "guidance": false, "git": false, "requirements": false, "files": false, "images": false}
	preview, _, err := b.InvokeAI("ai:requirements:context", []any{id, sources})
	if err != nil || len(aiMap(preview)["counts"].(map[string]int)) != 0 {
		t.Fatalf("unexpected context preview: %v, %v", preview, err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		messages := aiArray(payload["messages"])
		prompt := aiString(aiMap(messages[0])["content"])
		if !strings.Contains(prompt, "具体的澄清问题") || !strings.Contains(prompt, "不要替用户决定关键假设") {
			t.Error("chat does not instruct the model to clarify material ambiguity")
		}
		var context map[string]any
		if err := json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context); err != nil {
			t.Error(err)
		}
		for _, key := range []string{"project", "recentRequirements", "files", "gitLog", "imageTurn"} {
			if coreHas(context, key) {
				t.Errorf("disabled source leaked: %s", key)
			}
		}
		if len(aiArray(context["currentDrafts"])) != 1 || len(aiArray(context["discussion"])) != 1 {
			t.Error("turn lost its discussion or candidate data")
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"在哪些项目启用？"}}]}`)
	}))
	defer server.Close()
	if _, err := b.saveAISettings(aiTestSettings(server.URL)); err != nil {
		t.Fatal(err)
	}
	const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMr8AAAAASUVORK5CYII="
	args := []any{id, "chat", "继续讨论", []any{map[string]any{"role": "user", "content": "增加提示"}}, []any{png}, "current", []any{map[string]any{"id": "kept"}}, aiMap(preview)["token"]}
	result, _, err := b.InvokeAI("ai:requirements", args)
	if err != nil || aiMap(result)["reply"] != "在哪些项目启用？" || aiMap(result)["sourceCounts"].(map[string]int)["images"] != 0 {
		t.Fatalf("unexpected chat result: %v, %v", result, err)
	}
	args[7] = "invalid"
	if _, _, err := b.InvokeAI("ai:requirements", args); err == nil {
		t.Fatal("unrecognized preview was accepted")
	}
}

func TestAIChatStoreKeepsDraftAndHistorySeparate(t *testing.T) {
	dir := t.TempDir()
	b := NewBackend(dir, dir, "2.18.0")
	invoke := func(channel string, args ...any) map[string]any {
		t.Helper()
		result, handled, err := b.InvokeAI(channel, args)
		if err != nil || !handled || aiMap(result)["ok"] != true {
			t.Fatalf("%s: %v, %v", channel, result, err)
		}
		return aiMap(result)
	}
	draft := map[string]any{"id": "session", "input": "待发送"}
	turn := func(stamp, text string) map[string]any {
		return map[string]any{"session": "session", "time": stamp, "title": text, "messages": []any{
			map[string]any{"role": "user", "content": text}, map[string]any{"role": "assistant", "content": "回复 " + text},
		}}
	}
	invoke("ai:chat:save-sources", "project-a", map[string]any{"images": false})
	invoke("ai:chat:save-draft", "project-a", draft, turn("2026-11-09T08:00:00Z", "第一轮"))
	invoke("ai:chat:save-draft", "project-a", draft, turn("2026-11-09T08:01:00Z", "第二轮"))
	invoke("ai:chat:save-draft", "project-b", draft, turn("2026-11-09T08:02:00Z", "另一个项目"))
	b = NewBackend(dir, dir, "2.18.0")
	state := invoke("ai:chat:state", "project-a")
	if aiMap(state["draft"])["input"] != "待发送" || aiMap(state["sources"])["images"] != false || invoke("ai:chat:state", "missing")["draft"] != nil {
		t.Fatal("draft or preferences did not persist by project")
	}
	messages := invoke("ai:chat:read-history", "project-a", "session")["messages"].([]json.RawMessage)
	if len(messages) != 4 || !bytes.Contains(messages[0], []byte("第一轮")) || !bytes.Contains(messages[3], []byte("回复 第二轮")) {
		t.Fatal("conversation order changed")
	}
	invoke("ai:chat:clear-history", "project-a")
	if len(invoke("ai:chat:history", "project-a")["entries"].([]map[string]string)) != 0 ||
		len(invoke("ai:chat:history", "project-b")["entries"].([]map[string]string)) != 1 || invoke("ai:chat:state", "project-a")["draft"] == nil {
		t.Fatal("project history cleanup affected draft or another project")
	}
	invoke("ai:chat:save-draft", "project-a", draft, turn("2026-11-09T08:03:00Z", "新一轮"))
	if len(invoke("ai:chat:read-history", "project-a", "session")["messages"].([]json.RawMessage)) != 2 {
		t.Fatal("cleared historical messages were restored when continuing a draft")
	}
	invoke("ai:chat:save-draft", "project-a", nil)
	if invoke("ai:chat:state", "project-a")["draft"] != nil || len(invoke("ai:chat:history", "project-a")["entries"].([]map[string]string)) != 1 {
		t.Fatal("discarding the draft must leave history intact")
	}
	invoke("ai:chat:clear-history", nil)
	if len(invoke("ai:chat:history", "project-b")["entries"].([]map[string]string)) != 0 {
		t.Fatal("all-project cleanup left history")
	}
}

func TestAIRequirementChatToolPatchesDrafts(t *testing.T) {
	const argsJSON = `{"reply":"已补充验收条件","changes":[{"action":"update","id":"draft-1","criteria":["可重试"]},{"action":"list"},{"action":"create","title":"新增","body":"新的正文","type":"feature","priority":"P1","criteria":[]}]}`
	const reasoning = "先检查候选需求的验收条件"
	for _, format := range []string{"openai", "anthropic", "fallback"} {
		t.Run(format, func(t *testing.T) {
			b := aiTestBackend(t)
			workspace, err := b.Workspace.Get()
			if err != nil {
				t.Fatal(err)
			}
			project := aiMap(aiArray(aiMap(workspace["state"])["projects"])[0])
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				var payload map[string]any
				_ = json.NewDecoder(req.Body).Decode(&payload)
				tools := aiArray(payload["tools"])
				if format == "anthropic" {
					if len(tools) != 1 || aiMap(tools[0])["name"] != aiRequirementToolName {
						t.Error("expected Anthropic tool")
					}
					var input any
					_ = json.Unmarshal([]byte(argsJSON), &input)
					_ = json.NewEncoder(w).Encode(map[string]any{"content": []any{
						map[string]any{"type": "thinking", "thinking": reasoning},
						map[string]any{"type": "tool_use", "name": aiRequirementToolName, "input": input},
					}})
					return
				}
				if format == "fallback" && len(tools) > 0 {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				message := map[string]any{"reasoning_content": reasoning}
				if format == "fallback" {
					messages := aiArray(payload["messages"])
					if !strings.Contains(aiString(aiMap(messages[0])["content"]), "当前连接通过 JSON 调用工具") {
						t.Error("missing JSON fallback instructions")
					}
					message["content"] = `{"tool":"edit_requirement_drafts","arguments":` + argsJSON + `}`
				} else {
					if len(tools) != 1 || aiMap(aiMap(tools[0])["function"])["name"] != aiRequirementToolName {
						t.Error("expected OpenAI tool")
					}
					message["tool_calls"] = []any{map[string]any{"function": map[string]any{"name": aiRequirementToolName, "arguments": argsJSON}}}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}})
			}))
			defer server.Close()
			settings := aiTestSettings(server.URL)
			if format == "anthropic" {
				settings["format"] = format
			}
			if _, err = b.saveAISettings(settings); err != nil {
				t.Fatal(err)
			}
			old := map[string]any{"id": "draft-1", "title": "原题", "body": "原文", "type": "bug", "priority": "P0", "criteria": []any{}}
			drafts := []any{old, map[string]any{"id": "draft-2"}, map[string]any{"id": "untouched"}}
			value, handled, err := b.InvokeAI("ai:requirements", []any{project["id"], "chat", "更新候选", []any{}, nil, "", drafts})
			result := aiMap(value)
			items := aiArray(result["items"])
			if err != nil || !handled || result["reply"] != "已补充验收条件" || result["reasoning"] != reasoning || len(items) != 4 {
				t.Fatalf("tool response: %v, %v", result, err)
			}
			updated := aiMap(items[0])
			if updated["id"] != "draft-1" || updated["body"] != "原文" || aiArray(updated["criteria"])[0] != "可重试" ||
				aiMap(items[1])["id"] != "draft-2" || aiMap(items[2])["id"] != "untouched" || aiMap(items[3])["title"] != "新增" || len(aiArray(old["criteria"])) != 0 {
				t.Fatal(items)
			}
			if traces, ok := result["toolCalls"].([]map[string]any); !ok || len(traces) != 1 || traces[0]["name"] != aiRequirementToolName {
				t.Fatalf("missing tool call trace: %v", result["toolCalls"])
			}
			if _, err := applyAIRequirementChanges(drafts, []any{map[string]any{"action": "remove", "id": "draft-1"}}); err == nil {
				t.Fatal("accepted a candidate removal")
			}
		})
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
	largeDiff := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		messages := aiArray(payload["messages"])
		var context map[string]any
		if len(messages) != 2 || json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context) != nil {
			t.Error("AI commit context missing")
		}
		if largeDiff {
			if coreHas(context, "stagedDiff") || coreHas(context, "draft") || len(aiArray(context["requirements"])) != 1 || !strings.Contains(aiString(aiMap(messages[0])["content"]), "仅依据 requirements") {
				t.Error("large diff must use requirements only")
			}
		} else if !strings.Contains(aiString(context["stagedDiff"]), "staged-fact") || strings.Contains(aiString(context["draft"]), "REQ-") {
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
	if err = os.WriteFile(filepath.Join(repo, "change.txt"), []byte(strings.Repeat("large change\n", 20000)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = RunRemoteGit([]string{"add", "--", "change.txt"}, repo, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err = b.InvokeAI("ai:commit:optimize", []any{id, "草稿"}); err == nil || !strings.Contains(err.Error(), "没有待 Git 提交的需求") {
		t.Fatal("missing requirements must not produce invented summary")
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "item", "project": id, "body": "新增测试行为"}, nil); err != nil {
		t.Fatal(err)
	}
	workspace, err = b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	itemID := aiMap(aiArray(aiMap(aiArray(aiMap(workspace["state"])["projects"])[0])["items"])[0])["id"]
	if _, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": id, "ids": []any{itemID}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "complete", "project": id, "id": itemID}, nil); err != nil {
		t.Fatal(err)
	}
	largeDiff = true
	if _, _, err = b.InvokeAI("ai:commit:optimize", []any{id, "无关草稿"}); err != nil {
		t.Fatal(err)
	}
}

func TestAIGuidanceOptimizeUsesRecentChanges(t *testing.T) {
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
	for _, config := range [][]string{{"config", "user.email", "t@example.com"}, {"config", "user.name", "tester"}} {
		if _, err = RunRemoteGit(config, repo, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.WriteFile(filepath.Join(repo, "change.txt"), []byte("guidance-fact\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "--", "change.txt"}, {"commit", "-m", "feat: 新增测试行为"}} {
		if _, err = RunRemoteGit(args, repo, nil); err != nil {
			t.Fatal(err)
		}
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
			t.Error("AI guidance context missing")
		}
		if context["kind"] != "delivery" || aiString(context["text"]) != "说明改动与未解决的问题" || aiMap(context["project"])["name"] == nil {
			t.Error("AI guidance kind/text/project differ")
		}
		system := aiString(aiMap(messages[0])["content"])
		if !strings.Contains(system, "精炼、条目化") || !strings.Contains(system, "不增加上下文占用") || strings.Contains(system, "无列表符号") {
			t.Error("guidance optimization lacks concise, itemized context limits")
		}
		if !strings.Contains(aiString(context["recentDiffStat"]), "change.txt") || !strings.Contains(aiString(context["recentLog"]), "新增测试行为") {
			t.Error("AI guidance omitted recent diff facts")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "```\n优化后的交付引导\n```"}}}})
	}))
	defer server.Close()
	if _, err = b.saveAISettings(aiTestSettings(server.URL)); err != nil {
		t.Fatal(err)
	}
	value, handled, err := b.InvokeAI("ai:guidance:optimize", []any{id, "delivery", "说明改动与未解决的问题"})
	if err != nil || !handled || aiMap(value)["ok"] != true || aiMap(value)["text"] != "优化后的交付引导" {
		t.Fatalf("Go guidance optimize channel failed: %v", err)
	}
	if _, _, err = b.InvokeAI("ai:guidance:optimize", []any{id, "unknown", "文本"}); err == nil {
		t.Fatal("invalid kind must be rejected")
	}
}
