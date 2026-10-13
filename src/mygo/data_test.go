package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf16"
)

func TestInstalledDataLayout(t *testing.T) {
	root := t.TempDir()
	actual := filepath.Join(root, "AppData", "Roaming", "ReqFlow")
	if err := os.MkdirAll(actual, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(actual, "workspace.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := existingDataDir(root); got != actual {
		t.Fatalf("picked %q, want existing nested data %q", got, actual)
	}
	if got := existingDataDir(t.TempDir()); got != "" {
		t.Fatalf("empty directory selected: %q", got)
	}
}

func TestUTF16ConfigAndEnvPrecedence(t *testing.T) {
	appDir := t.TempDir()
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(data, "requirements.sqlite"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	units := utf16.Encode([]rune(data + "\r\n"))
	raw := []byte{0xff, 0xfe}
	for _, unit := range units {
		raw = binary.LittleEndian.AppendUint16(raw, unit)
	}
	if err := os.WriteFile(filepath.Join(appDir, "data-dir.cfg"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REQFLOW_DATA_DIR", "")
	if got, err := resolveDataDir(appDir); err != nil || got != data {
		t.Fatalf("config data = %q, %v", got, err)
	}
	override := t.TempDir()
	t.Setenv("REQFLOW_DATA_DIR", override)
	if got, err := resolveDataDir(appDir); err != nil || got != override {
		t.Fatalf("env data = %q, %v", got, err)
	}
}

func TestFreshConfiguredDataDirectory(t *testing.T) {
	appDir := t.TempDir()
	t.Setenv("REQFLOW_DATA_DIR", "")
	data := t.TempDir()
	if err := os.WriteFile(filepath.Join(appDir, "data-dir.cfg"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveDataDir(appDir); err != nil || got != data {
		t.Fatalf("a new install must use its explicit data directory: %q %v", got, err)
	}
}

func TestPortableDetectionAndNavigation(t *testing.T) {
	if !portableExecutable(`E:\apps\ReqFlow-Portable-2.0.0.exe`) || portableExecutable(`E:\apps\ReqFlow.exe`) {
		t.Fatal("portable identity mismatch")
	}
	for _, raw := range []string{"mygo://localhost/", "http://mygo.localhost/index.html"} {
		if !localNavigation(raw) {
			t.Fatal("blocked frontend", raw)
		}
	}
	if localNavigation("http://mygo.localhost.evil/") || allowedExternal("javascript:alert(1)") || !allowedExternal("codex://threads/new") {
		t.Fatal("desktop origin policy")
	}
}
