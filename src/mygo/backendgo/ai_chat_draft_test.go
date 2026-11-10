package backendgo

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// REQ-315/319/320：只追问未建候选时自动补建第一版候选，记录模型，并告知模型已追问过。
func TestAIRequirementChatDraftsWhenOnlyAsking(t *testing.T) {
	b := aiTestBackend(t)
	workspace, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	project := aiMap(aiArray(aiMap(workspace["state"])["projects"])[0])
	var calls []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		messages := aiArray(payload["messages"])
		var context map[string]any
		_ = json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context)
		calls = append(calls, context)
		content := "请问导出需要支持哪些格式？"
		if strings.Contains(aiString(aiMap(messages[0])["content"]), "需求整理助手") {
			if len(aiArray(payload["tools"])) > 0 || context["assistantReply"] != "请问导出需要支持哪些格式？" {
				t.Error("draft pass should be a plain JSON request with the assistant reply")
			}
			content = "```json\n{\"changes\":[{\"action\":\"create\",\"title\":\"导出需求\",\"body\":\"支持导出需求列表。导出格式待确认。\",\"type\":\"feature\",\"priority\":\"P1\",\"criteria\":[]}]}\n```"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "provider-model-v2", "choices": []any{map[string]any{"message": map[string]any{"content": content}}},
			"usage": map[string]int{"prompt_tokens": 100, "completion_tokens": 20}})
	}))
	defer server.Close()
	settings := aiTestSettings(server.URL)
	settings["provider"] = "测试供应商"
	if _, err = b.saveAISettings(settings); err != nil {
		t.Fatal(err)
	}
	value, _, err := b.InvokeAI("ai:requirements", []any{project["id"], "chat", "我想要导出需求", []any{}, nil, "", []any{}})
	result := aiMap(value)
	items := aiArray(result["items"])
	if err != nil || len(calls) != 2 || len(items) != 1 || aiMap(items[0])["title"] != "导出需求" || result["reply"] != "请问导出需要支持哪些格式？" {
		t.Fatalf("draft pass result: %v %v calls=%d", result, err, len(calls))
	}
	if calls[0]["clarificationAsked"] != nil {
		t.Fatal("first turn must allow one clarification round")
	}
	usage := aiMap(result["usage"])
	if usage["contextTokens"] != 120 || usage["inputTokens"] != 200 || usage["outputTokens"] != 40 {
		t.Fatalf("draft pass usage: %v", usage)
	}
	model := aiMap(result["model"])
	if model["provider"] != "测试供应商" || model["model"] != "provider-model-v2" || model["kind"] != "api" || model["host"] == nil {
		t.Fatalf("model info: %v", model)
	}

	// 用户已回答追问：告知模型不再追问；没有可识别需求时整理轮返回空 changes，候选保持不变。
	calls = nil
	discussion := []any{map[string]any{"role": "user", "content": "我想要导出需求"}, map[string]any{"role": "assistant", "content": "请问导出需要支持哪些格式？"}}
	drafts := []any{map[string]any{"id": "d1", "title": "导出需求", "body": "支持导出", "type": "feature", "priority": "P1", "criteria": []any{}}}
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(r.Body).Decode(&payload)
		messages := aiArray(payload["messages"])
		var context map[string]any
		_ = json.Unmarshal([]byte(aiString(aiMap(messages[1])["content"])), &context)
		calls = append(calls, context)
		content := "好的，CSV 即可。"
		if strings.Contains(aiString(aiMap(messages[0])["content"]), "需求整理助手") {
			content = `{"changes":[{"action":"update","id":"d1","body":"支持导出为 CSV"}]}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	})
	value, _, err = b.InvokeAI("ai:requirements", []any{project["id"], "chat", "CSV", discussion, nil, "", drafts})
	result = aiMap(value)
	items = aiArray(result["items"])
	if err != nil || len(calls) != 2 || calls[0]["clarificationAsked"] != true || len(items) != 1 || aiMap(items[0])["body"] != "支持导出为 CSV" {
		t.Fatalf("answer revision: %v %v", result, err)
	}
	if aiMap(result["model"])["model"] == "" {
		t.Fatalf("configured model fallback missing: %v", result["model"])
	}
}

func TestAIRequirementDraftPassParsingAndTriggers(t *testing.T) {
	if needsRequirementDraftPass("好的，已了解。", nil, nil) || !needsRequirementDraftPass("需要支持哪些格式？", nil, nil) {
		t.Fatal("question trigger")
	}
	asked := []any{map[string]any{"role": "assistant", "content": "要支持 CSV 吗?"}}
	if !needsRequirementDraftPass("好的", asked, []any{map[string]any{"id": "a"}}) || needsRequirementDraftPass("好的", asked, nil) {
		t.Fatal("answer trigger")
	}
	if items, ops, err := parseRequirementDraftPass(`{"changes":[]}`, nil); err != nil || items != nil || ops != nil {
		t.Fatal("empty changes must be ignored")
	}
	if _, _, err := parseRequirementDraftPass(`{"changes":[{"action":"update","id":"missing","body":"x"}]}`, nil); err == nil {
		t.Fatal("unknown draft id accepted")
	}
	cli := aiChatModelInfo(AISettings{Kind: "cli", CLI: "claude"}, "")
	if cli["provider"] != "Claude Code" || cli["model"] != "CLI 默认模型" {
		t.Fatal(cli)
	}
}

func TestGitProgressKeepsLatestProgressLine(t *testing.T) {
	p := &gitProgress{running: true}
	_, _ = p.Write([]byte("Enumerating objects: 5, done.\nWriting objects:  50% (1/2)\rWriting objects: 100% (2/2), done.\n"))
	_, _ = p.Write([]byte("To github.com:a/b.git\n   abc..def  master -> master\n"))
	p.finish(nil, "")
	if strings.Join(p.lines, "|") != "Enumerating objects: 5, done.|Writing objects: 100% (2/2), done.|To github.com:a/b.git|abc..def  master -> master" || p.running {
		t.Fatalf("progress lines: %q", p.lines)
	}
}

func TestDesktopFileStat(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	b := aiTestBackend(t)
	value, err := b.desktopFiles("fs:stat", []any{root, "a.txt"})
	info := aiMap(value)
	if err != nil || info["size"] != int64(5) || info["dir"] != false || info["mode"] == "" || info["writable"] != true || !strings.HasSuffix(aiString(info["path"]), "a.txt") {
		t.Fatalf("stat: %v %v", info, err)
	}
}
