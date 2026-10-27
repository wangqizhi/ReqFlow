package backendgo

import (
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestOpenCodeGoRequestHeaders(t *testing.T) {
	for _, tc := range []struct {
		url, format string
		goProvider  bool
	}{
		{"https://opencode.ai/inference/go/openai/v1/chat/completions", "openai", true},
		{"https://OPENCODE.AI/inference/go/anthropic/v1/messages", "anthropic", true},
		{"https://opencode.ai/zen/go/v1/chat/completions", "openai", true},
		{"https://opencode.ai/inference/openai/v1/chat/completions", "openai", false},
		{"https://opencode.ai.evil.example/inference/go/v1/chat/completions", "openai", false},
		{"https://other.example/inference/go/v1/chat/completions", "openai", false},
	} {
		t.Run(tc.url, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodPost, tc.url, nil)
			if err != nil {
				t.Fatal(err)
			}
			settings := AISettings{Format: tc.format, APIKey: "test-key"}
			if err := setAIRequestHeaders(request, settings, aiRequestContext{version: "9.8.7", sessionID: "reqflow-test-session"}); err != nil {
				t.Fatal(err)
			}
			if request.UserAgent() != "ReqFlow/9.8.7" || request.Header.Get("Content-Type") != "application/json" {
				t.Fatal("client headers missing")
			}
			want := ""
			if tc.goProvider {
				want = "reqflow-test-session"
			}
			if request.Header.Get("x-opencode-session") != want {
				t.Fatal("session header routed to wrong provider")
			}
			if tc.format == "anthropic" {
				if request.Header.Get("x-api-key") != "test-key" || request.Header.Get("anthropic-version") != "2023-06-01" || request.Header.Get("Authorization") != "" {
					t.Fatal("Anthropic authentication changed")
				}
			} else if request.Header.Get("Authorization") != "Bearer test-key" {
				t.Fatal("OpenAI authentication changed")
			}
		})
	}
}

func TestOpenCodeGoStableScopedSessions(t *testing.T) {
	b := &Backend{Version: "9.8.7"}
	settings := AISettings{ID: "provider-1", URL: "https://opencode.ai/inference/go/openai/v1/chat/completions", Model: "deepseek-v4.1-flash"}
	first, err := b.aiContextFor(settings, "requirements:project-1:suggest")
	if err != nil || !strings.HasPrefix(first.sessionID, "reqflow-") || len(first.sessionID) != 40 || first.version != b.Version {
		t.Fatalf("missing random session: %+v %v", first, err)
	}
	var workers sync.WaitGroup
	for range 20 {
		workers.Go(func() {
			got, err := b.aiContextFor(settings, "requirements:project-1:suggest")
			if err != nil || got.sessionID != first.sessionID {
				t.Error("concurrent requests did not reuse their session")
			}
		})
	}
	workers.Wait()
	otherProvider, otherModel := settings, settings
	otherProvider.ID = "provider-2"
	otherModel.Model = "another-model"
	for _, tc := range []struct {
		backend  *Backend
		settings AISettings
		scope    string
	}{
		{b, settings, "requirements:project-2:suggest"},
		{b, settings, "settings-test"},
		{b, otherProvider, "requirements:project-1:suggest"},
		{b, otherModel, "requirements:project-1:suggest"},
		{&Backend{}, settings, "requirements:project-1:suggest"},
	} {
		got, err := tc.backend.aiContextFor(tc.settings, tc.scope)
		if err != nil || got.sessionID == "" || got.sessionID == first.sessionID {
			t.Fatal("unrelated sessions were shared", err)
		}
	}
	for _, settings := range []AISettings{{URL: "https://other.example/v1"}, {Kind: "cli", URL: settings.URL}} {
		got, err := b.aiContextFor(settings, "settings-test")
		if err != nil || got.sessionID != "" {
			t.Fatal("session allocated for an unrelated provider")
		}
	}
}
