package backendgo

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgentConfigAndCommandAllowlist(t *testing.T) {
	b := aiTestBackend(t)
	if _, err := b.invokeAgents("agents:save", []any{[]any{"codex", "pi", "pi"}}); err != nil {
		t.Fatal(err)
	}
	result, err := b.invokeAgents("agents:get", nil)
	if err != nil || len(aiArray(aiMap(result)["enabled"])) != 2 {
		t.Fatal("Agent config not deduplicated")
	}
	if _, err = b.invokeAgents("agents:save", []any{[]any{"echo injected"}}); err == nil {
		t.Fatal("arbitrary command accepted")
	}
	if ProbeAgent("codex & echo injected")["installed"] != false {
		t.Fatal("arbitrary shell command executed")
	}
	for _, pair := range [][3]string{{"1.2.3", "1.3.0", "yes"}, {"1.3.0", "1.2.3", "no"}, {"1.3.0", "1.3.0", "no"}} {
		update, valid := aiLatestNewer(pair[0], pair[1])
		if !valid || update != (pair[2] == "yes") {
			t.Fatal("version comparison differs")
		}
	}
}

func TestAgentRegistryResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/@earendil-works%2Fpi-coding-agent/latest" {
			t.Errorf("registry package path differs: %s", r.URL.EscapedPath())
		}
		_, _ = w.Write([]byte(`{"version":"2.3.4"}`))
	}))
	defer server.Close()
	t.Setenv("REQFLOW_NPM_REGISTRY", server.URL)
	version, err := aiLatestAgentVersion("@earendil-works/pi-coding-agent")
	if err != nil || version != "2.3.4" {
		t.Fatal("registry version failed")
	}
}
