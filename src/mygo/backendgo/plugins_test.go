package backendgo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPluginCLIReleaseNegotiation(t *testing.T) {
	previous := pluginBundlesJSON
	t.Cleanup(func() { pluginBundlesJSON = previous })
	raw, _ := json.Marshal(map[string]any{"codex": map[string]any{
		"name": "reqflow-agent", "version": "0.3.0", "sha256": "fixture", "files": map[string]string{"plugin.json": `{}`},
	}})
	pluginBundlesJSON = string(raw)
	dir := t.TempDir()
	metadata := coreTestCLI(t, dir, "plugin", "version", "--host", "codex", "--plugin-version", "0.2.1")
	if metadata["updateAvailable"] != true || metadata["version"] != "0.3.0" || metadata["files"] != nil {
		t.Fatal(metadata)
	}
	for _, version := range []string{"0.3.0", "0.4.0"} {
		if coreTestCLI(t, dir, "plugin", "version", "--host", "codex", "--plugin-version", version)["updateAvailable"] != false {
			t.Fatal("must not reinstall or downgrade")
		}
	}
	bundle := coreTestCLI(t, dir, "plugin", "bundle", "--host", "codex")
	if coreMap(bundle["files"])["plugin.json"] != `{}` || bundle["sha256"] != metadata["sha256"] {
		t.Fatal(bundle)
	}
	if _, err := os.Stat(filepath.Join(dir, "requirements.sqlite")); !os.IsNotExist(err) {
		t.Fatal("plugin queries must not initialize workspace storage")
	}
	if _, err := pluginRelease("plugin version", map[string]any{"host": "other"}); err == nil {
		t.Fatal("invalid host accepted")
	}
	if _, err := pluginRelease("plugin version", map[string]any{"host": "codex", "plugin-version": "invalid"}); err == nil {
		t.Fatal("invalid version accepted")
	}
}
