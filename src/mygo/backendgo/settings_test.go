package backendgo

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func aiTestBackend(t *testing.T) *Backend {
	t.Helper()
	root := t.TempDir()
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("REQFLOW_ELECTRON_LOCAL_STATE", filepath.Join(root, "nonexistent-local-state"))
	return NewBackend(root, root, "2.0.0")
}

func aiTestSettings(url string) map[string]any {
	return map[string]any{"provider": "test", "url": url, "apiKey": "fake-private-test-key", "format": "openai", "model": "deepseek-flash", "requestLogging": true}
}

func aiTestElectronState(t *testing.T, b *Backend) []byte {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	protected, err := aiDPAPI(key, true)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(b.DataDir, "test-local-state.json")
	if err = aiWriteJSON(file, map[string]any{"os_crypt": map[string]any{"encrypted_key": base64.StdEncoding.EncodeToString(append([]byte("DPAPI"), protected...))}}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REQFLOW_ELECTRON_LOCAL_STATE", file)
	return key
}

func TestSettingsDPAPIFallbackNeverWritesPlaintext(t *testing.T) {
	b := aiTestBackend(t)
	result, err := b.saveAISettings(aiTestSettings("https://api.example.invalid/v1"))
	if err != nil {
		t.Fatal(err)
	}
	if result["keyStorage"] != "dpapi-v1" {
		t.Fatal("new profile must use an explicit DPAPI envelope")
	}
	raw, err := os.ReadFile(filepath.Join(b.DataDir, "ai-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("fake-private-test-key")) {
		t.Fatal("plaintext API key was persisted")
	}
	s, err := b.readAISettings()
	if err != nil {
		t.Fatal(err)
	}
	if s.APIKey != "fake-private-test-key" || s.Model != "deepseek-flash" || !s.RequestLogging {
		t.Fatal("settings roundtrip differs")
	}
}

func TestElectronV10AndV11Compatibility(t *testing.T) {
	b := aiTestBackend(t)
	key := aiTestElectronState(t, b)
	if _, err := b.saveAISettings(aiTestSettings("https://api.example.invalid/v1")); err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := aiReadJSON(filepath.Join(b.DataDir, "ai-settings.json"), &stored); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(aiString(stored["encryptedKey"]))
	if err != nil || !strings.HasPrefix(string(raw), "v10") {
		t.Fatal("existing Electron profile must retain v10 format")
	}
	for _, prefix := range []string{"v10", "v11"} {
		copy(raw[:3], prefix)
		plain, err := b.decryptAIKey(base64.StdEncoding.EncodeToString(raw))
		if err != nil || plain != "fake-private-test-key" {
			t.Fatal("Electron AES-GCM envelope did not decrypt")
		}
	}
	other := aiTestBackend(t)
	encrypted, err := aiEncryptEnvelope(key, "test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = other.decryptAIKey(base64.StdEncoding.EncodeToString(encrypted)); err == nil {
		t.Fatal("a missing Electron profile must not silently discard the key")
	}
}

func TestSettingsValidationAndFailedSavePreserveFile(t *testing.T) {
	b := aiTestBackend(t)
	if _, err := b.saveAISettings(aiTestSettings("https://api.example.invalid")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(b.DataDir, "ai-settings.json")
	before, _ := os.ReadFile(path)
	invalid := aiTestSettings("javascript:alert(1)")
	if _, err := b.saveAISettings(invalid); err == nil {
		t.Fatal("invalid URL was saved")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("failed save changed existing settings")
	}
	if _, err := b.decryptAIKey(base64.StdEncoding.EncodeToString([]byte("v20unsupported"))); err == nil {
		t.Fatal("v20 must fail explicitly")
	}
}
