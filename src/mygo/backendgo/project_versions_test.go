package backendgo

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestReadProjectVersions(t *testing.T) {
	root := t.TempDir()
	manifest := `{"version":"3.0.0","components":{"frontend":"1.2.3","backend":{"version":"2.3.4","file":"backend/package.json"},"bad":12,"empty":{"file":"VERSION"},"multiline":"1\n2"}}`
	for _, test := range []struct {
		name, file, body, source, version string
		components                        map[string]any
	}{
		{"default package", "package.json", `{"version":"1.0.0"}`, "", "1.0.0", nil},
		{"plain text", "VERSION", "\ufeff2.0.0\n", "VERSION", "2.0.0", nil},
		{"manifest", "release.json", manifest, "release.json", "3.0.0", map[string]any{"frontend": "1.2.3", "backend": "2.3.4"}},
		{"components only", "release.json", `{"components":{"frontend":"1.2.3"}}`, "release.json", "", map[string]any{"frontend": "1.2.3"}},
		{"scalar selector", "release.json", manifest, "release.json#components.frontend", "1.2.3", nil},
		{"object selector", "release.json", manifest, "release.json#components.backend", "2.3.4", nil},
		{"nested selector", "release.json", manifest, "release.json#components.backend.version", "2.3.4", nil},
		{"missing selector", "release.json", manifest, "release.json#components.missing", "", nil},
		{"empty selector", "release.json", manifest, "release.json#", "", nil},
		{"invalid JSON", "release.json", `{"version":"1.2.3",`, "release.json", "", nil},
		{"multiline text", "VERSION", "1.2.3\n4.5.6", "VERSION", "", nil},
		{"oversize", "VERSION", strings.Repeat("x", 101), "VERSION", "", nil},
		{"missing explicit source", "package.json", `{"version":"1.0.0"}`, "missing.json", "", nil},
		{"traversal", "VERSION", "1.2.3", "../VERSION", "", nil},
		{"absolute", "VERSION", "1.2.3", filepath.Join(root, "VERSION"), "", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(root, test.file), []byte(test.body), 0600); err != nil {
				t.Fatal(err)
			}
			version, components := readProjectVersions(root, test.source)
			if version != test.version || (len(components) != 0 || len(test.components) != 0) && !reflect.DeepEqual(components, test.components) {
				t.Fatalf("got %q %v, want %q %v", version, components, test.version, test.components)
			}
		})
	}
}

func TestCompletionComponentSnapshot(t *testing.T) {
	for _, remote := range []bool{false, true} {
		t.Run(fmtBool(remote), func(t *testing.T) {
			b := NewBackend(t.TempDir(), t.TempDir(), "99.0.0")
			var sid string
			if remote {
				base, token, stop := startTestSyncServer(t)
				defer stop()
				b, _, sid = syncFixtureBackend(t, base, token)
			}
			r := coreTestGet(t, b.Workspace)
			pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
			root := t.TempDir()
			file := filepath.Join(root, "release-versions.json")
			if err := os.WriteFile(file, []byte(`{"version":"3.0.0","components":{"frontend":"1.2.3","backend":{"version":"2.3.4"}}}`), 0600); err != nil {
				t.Fatal(err)
			}
			coreTestMutate := func(action map[string]any) map[string]any {
				t.Helper()
				action["project"] = pid
				result, err := b.Workspace.Mutate(action, nil)
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			coreTestMutate(map[string]any{"op": "projectDir", "dir": root})
			coreTestMutate(map[string]any{"op": "projectRuntime", "cli": "codex", "versionFile": "release-versions.json"})
			if remote {
				coreTestMutate(map[string]any{"op": "projectSync", "server": sid})
			}
			r = coreTestMutate(map[string]any{"op": "item", "body": "component snapshot"})
			p := coreFind(coreList(coreMap(r["state"])["projects"]), pid)
			id := coreMap(coreList(p["items"])[0])["id"]
			coreTestMutate(map[string]any{"op": "generate", "ids": []any{id}})
			// Exercise the CLI entry, which must preserve the full automatic snapshot.
			if _, err := coreCLIDispatch(b.Workspace, "complete", map[string]any{"project": pid, "id": id}, "99.0.0"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, []byte(`{"version":"4.0.0","components":{"frontend":"9.0.0"}}`), 0600); err != nil {
				t.Fatal(err)
			}
			r = coreTestGet(t, b.Workspace)
			i := coreFind(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), pid)["items"]), id)
			if i["verificationVersion"] != "3.0.0" || !reflect.DeepEqual(coreMap(i["verificationComponents"]), map[string]any{"frontend": "1.2.3", "backend": "2.3.4"}) {
				t.Fatalf("snapshot changed: %v", i)
			}
			// A new development round with an explicit version cannot retain stale components.
			coreTestMutate(map[string]any{"op": "verify", "id": id, "pass": false, "note": "another round"})
			coreTestMutate(map[string]any{"op": "generate", "ids": []any{id}})
			r = coreTestMutate(map[string]any{"op": "complete", "id": id, "verificationVersion": "5.0.0"})
			i = coreFind(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), pid)["items"]), id)
			if i["verificationVersion"] != "5.0.0" || len(coreMap(i["verificationComponents"])) != 0 {
				t.Fatalf("stale components: %v", i)
			}
		})
	}
}
