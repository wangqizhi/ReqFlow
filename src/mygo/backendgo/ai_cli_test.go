package backendgo

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestProviderHelper(t *testing.T) {
	if os.Getenv("REQFLOW_TEST_PROVIDER_HELPER") != "1" {
		return
	}
	args := strings.Join(os.Args, " ")
	if strings.Contains(args, "--version") {
		os.Stdout.WriteString("provider 1.2.3\n")
		os.Exit(0)
	}
	if strings.Contains(args, "--fail") {
		os.Exit(1)
	}
	input, _ := io.ReadAll(os.Stdin)
	for i, arg := range os.Args {
		if arg == "--attach" && i+1 < len(os.Args) {
			input, _ = os.ReadFile(os.Args[i+1])
		}
	}
	if !bytes.Contains(input, []byte("中文")) || !bytes.Contains(input, []byte(`& | $(literal) %PATH%`)) {
		os.Exit(2)
	}
	if strings.Contains(args, "--output-format json") {
		json.NewEncoder(os.Stdout).Encode(map[string]any{"response": "中文生成结果"})
	} else {
		os.Stdout.WriteString("中文生成结果\n")
	}
	os.Exit(0)
}

func fakeProviders(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "CLI wrappers 中文")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range providerCLIs {
		var script, suffix string
		if runtime.GOOS == "windows" {
			suffix, script = ".cmd", "@echo off\r\n\""+exe+"\" -test.run=^TestProviderHelper$ -- %*\r\n"
		} else {
			suffix, script = "", "#!/bin/sh\nexec '"+exe+"' -test.run=^TestProviderHelper$ -- \"$@\"\n"
		}
		if err = os.WriteFile(filepath.Join(root, id+suffix), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("REQFLOW_TEST_PROVIDER_HELPER", "1")
	t.Setenv("PATH", root+string(os.PathListSeparator)+os.Getenv("PATH"))
	return root
}

func TestCLIRequestUsesNoninteractiveWrappersAndUnicodeStdin(t *testing.T) {
	fakeProviders(t)
	for _, id := range providerCLIs {
		t.Run(id, func(t *testing.T) {
			events := []string{}
			text, err := RequestAI(AISettings{Kind: "cli", CLI: id}, "中文系统要求", `中文内容 & | $(literal) %PATH%`, func(e AIRequestEvent) { events = append(events, e.Phase) })
			if err != nil || text != "中文生成结果" {
				t.Fatalf("%s: result=%q error=%v", id, text, err)
			}
			if strings.Join(events, ",") != "request,complete" {
				t.Fatal(events)
			}
		})
	}
	result := detectProviderCLIs()
	for _, entry := range result["agents"].([]any) {
		if aiMap(entry)["installed"] != true || aiMap(entry)["version"] != "1.2.3" {
			t.Fatal(entry)
		}
	}
}

func TestCLIRejectsInvalidCommandsAndModels(t *testing.T) {
	if _, err := resolveProviderCLI("cmd.exe"); err == nil {
		t.Fatal("arbitrary command allowed")
	}
	if _, err := providerArguments(AISettings{CLI: "codex", Model: "model & echo injected"}, t.TempDir()); err == nil {
		t.Fatal("shell metacharacters allowed in model")
	}
	if _, err := providerArguments(AISettings{CLI: "unknown"}, t.TempDir()); err == nil {
		t.Fatal("unknown CLI accepted")
	}
	root := fakeProviders(t)
	path := filepath.Join(root, "codex")
	if runtime.GOOS == "windows" {
		path += ".cmd"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := runProviderCommand(providerCommand(ctx, path, []string{"--fail"})); err == nil {
		t.Fatal("failed process accepted")
	}
}

func TestCLIModelDiscoveryAndReasoningArguments(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	cache := `{"models":[{"slug":"no-off","display_name":"推理模型","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"optional","supported_reasoning_levels":[{"effort":"none"},{"effort":"medium"}]},{"slug":"hidden","visibility":"hide"},{"slug":"bad & command"}]}`
	if err := os.WriteFile(filepath.Join(home, "models_cache.json"), []byte(cache), 0600); err != nil {
		t.Fatal(err)
	}
	models := cachedCodexModels()
	if len(models) != 2 || models[0].Name != "推理模型" {
		t.Fatal(models)
	}
	for _, tc := range []struct{ model, effort, expected string }{{"no-off", "none", `model_reasoning_effort="low"`}, {"optional", "none", `model_reasoning_effort="none"`}, {"no-off", "high", `model_reasoning_effort="high"`}} {
		args, err := providerArguments(AISettings{CLI: "codex", Model: tc.model, ReasoningEffort: tc.effort}, t.TempDir())
		if err != nil || !strings.Contains(strings.Join(args, " "), tc.expected) {
			t.Fatal(args, err)
		}
	}
	if _, err := providerArguments(AISettings{CLI: "codex", Model: "no-off", ReasoningEffort: "medium"}, t.TempDir()); err == nil {
		t.Fatal("unsupported effort accepted")
	}
	pi := parsePiModels("provider model context max-out thinking images\nopenai gpt-5 400K 128K yes yes\nopenai gpt-4 8K 8K no no\nopenai gpt-5 400K 128K yes yes\nmalformed\n")
	if len(pi) != 2 || pi[0].ID != "openai/gpt-5" || len(pi[0].ReasoningEfforts) == 0 || len(pi[1].ReasoningEfforts) != 0 {
		t.Fatal(pi)
	}
	for _, effort := range []string{"none", "high"} {
		args, err := providerArguments(AISettings{CLI: "pi", Model: pi[0].ID, ReasoningEffort: effort}, t.TempDir())
		expected := effort
		if effort == "none" {
			expected = "off"
		}
		if err != nil || !strings.Contains(strings.Join(args, " "), "--thinking "+expected) {
			t.Fatal(args, err)
		}
	}
	os.Remove(filepath.Join(home, "models_cache.json"))
	if len(cachedCodexModels()) != 0 {
		t.Fatal("missing cache should use manual/default fallback")
	}
	if args, err := providerArguments(AISettings{CLI: "codex", Model: "manual-model"}, t.TempDir()); err != nil || !strings.Contains(strings.Join(args, " "), "--model manual-model") {
		t.Fatal(args, err)
	}
}

func TestPublishTemplateMigrationPreservesCustomText(t *testing.T) {
	for _, text := range []string{legacyPublishTemplate, "我的自定义发布步骤"} {
		state := NormalizeWorkspace(map[string]any{"projects": []any{}, "publishTemplate": text})
		want := text
		if text == legacyPublishTemplate {
			want = DefaultPublishTemplate
		}
		if state["publishTemplate"] != want {
			t.Fatal("publish template migration changed custom text or retained old default")
		}
	}
}

func TestAIProfilesMigrateEncryptSwitchAndPreserveOnFailure(t *testing.T) {
	b := aiTestBackend(t)
	legacy := aiTestSettings("https://example.invalid/v1")
	if _, err := b.saveAISettings(legacy); err != nil {
		t.Fatal(err)
	}
	read, err := b.readAISettings()
	if err != nil || read.APIKey != "fake-private-test-key" {
		t.Fatal(read, err)
	}
	legacy["id"] = "api"
	cli := map[string]any{"id": "cli", "provider": "个人 CLI", "kind": "cli", "cli": "pi", "url": "", "apiKey": "", "model": "openai/gpt-5", "reasoningEffort": "medium"}
	config := aiCloneMap(legacy)
	config["profiles"] = []any{legacy, cli}
	config["activeProfileId"] = "cli"
	config["requestLogging"] = false
	if _, err = b.saveAISettings(config); err != nil {
		t.Fatal(err)
	}
	read, err = b.readAISettings()
	if err != nil || read.Kind != "cli" || read.CLI != "pi" || read.ReasoningEffort != "medium" || len(read.Profiles) != 2 || read.RequestLogging {
		t.Fatal(read, err)
	}
	path := filepath.Join(b.DataDir, "ai-settings.json")
	before, _ := os.ReadFile(path)
	if bytes.Contains(before, []byte("fake-private-test-key")) {
		t.Fatal("inactive API key was persisted in plaintext")
	}
	config["activeProfileId"] = "missing"
	if _, err = b.saveAISettings(config); err == nil {
		t.Fatal("missing active profile accepted")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("invalid save overwrote profiles")
	}
	config["activeProfileId"] = "api"
	if _, err = b.saveAISettings(config); err != nil {
		t.Fatal(err)
	}
	read, err = b.readAISettings()
	if err != nil || read.Kind != "api" || read.APIKey != "fake-private-test-key" {
		t.Fatal(read, err)
	}
	config["profiles"] = []any{legacy, legacy}
	if _, err = b.saveAISettings(config); err == nil {
		t.Fatal("duplicate profile accepted")
	}
}

func TestCodexUsageOnlyDisplaysFreshAccountWindows(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	now := time.Now()
	dir := filepath.Join(home, "sessions", now.Format("2006/01/02"))
	os.MkdirAll(dir, 0700)
	event := map[string]any{"timestamp": now.Format(time.RFC3339Nano), "payload": map[string]any{"rate_limits": map[string]any{"primary": map[string]any{"window_minutes": 300, "used_percent": 12.0, "resets_at": now.Add(time.Hour).Unix()}, "secondary": map[string]any{"window_minutes": 10080, "used_percent": 42.0, "resets_at": now.Add(time.Hour).Unix()}}}}
	path := filepath.Join(dir, "session.jsonl")
	raw, _ := json.Marshal(event)
	os.WriteFile(path, raw, 0600)
	usage := cachedCodexUsage()
	if len(usage) != 1 || aiMap(usage[0])["label"] != "周用量" || aiMap(usage[0])["usedPercent"] != 42.0 {
		t.Fatal(usage)
	}
	event["timestamp"] = now.Add(-25 * time.Hour).Format(time.RFC3339Nano)
	raw, _ = json.Marshal(event)
	os.WriteFile(path, raw, 0600)
	if len(cachedCodexUsage()) != 0 {
		t.Fatal("stale quota displayed")
	}
}
