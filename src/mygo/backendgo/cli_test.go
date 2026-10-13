package backendgo

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func coreTestCLI(t *testing.T, dir string, args ...string) map[string]any {
	t.Helper()
	var b bytes.Buffer
	code := RunCLI(args, "2.0.0", dir, &b)
	if code != 0 {
		t.Fatalf("%v: %s", args, b.String())
	}
	var r map[string]any
	if e := json.Unmarshal(b.Bytes(), &r); e != nil {
		t.Fatal(e)
	}
	if r["ok"] != true {
		t.Fatal(r)
	}
	return r
}
func TestCoreCLIProtocolAndLifecycle(t *testing.T) {
	dir := t.TempDir()
	version := coreTestCLI(t, dir, "version")
	if version["protocol"] != "workspace-json-v1" || coreString(coreList(version["capabilities"])[0]) != "scheduled-ai-complete" || version["version"] != "2.0.0" {
		t.Fatal(version)
	}
	help := coreTestCLI(t, dir, "--help")
	if len(coreList(help["groups"])) != 5 {
		t.Fatal("help lost groups")
	}
	p := coreMap(coreTestCLI(t, dir, "project", "create", "--name", "CLI")["project"])
	id := coreString(p["id"])
	item := coreMap(coreTestCLI(t, dir, "item", "add", "--project", id, "--body", "实现CLI", "--criteria", "a;b", "--date", "2026-10-13")["item"])
	iid := coreString(item["id"])
	generated := coreTestCLI(t, dir, "generate", "--project", id, "--items", iid)
	bid := coreString(coreMap(generated["batch"])["id"])
	if coreNum(generated["promptLength"]) <= 0 {
		t.Fatal("empty prompt")
	}
	coreTestCLI(t, dir, "complete", "--project", id, "--id", iid, "--batch", bid, "--item-version", "1")
	coreTestCLI(t, dir, "verify", "--project", id, "--id", iid, "--pass", "true")
	list := coreTestCLI(t, dir, "item", "list", "--project", id, "--status", "archived")
	if coreNum(list["total"]) != 1 {
		t.Fatal(list)
	}
	coreTestCLI(t, dir, "regress", "--project", id, "--id", iid, "--note", "回归")
	coreTestCLI(t, dir, "item", "edit", "--project", id, "--id", iid, "--title", "更新标题")
	out := filepath.Join(dir, "help.json")
	coreTestCLI(t, dir, "help", "--pretty", "--out", out)
	if _, e := os.Stat(out); e != nil {
		t.Fatal(e)
	}
	var b bytes.Buffer
	if RunCLI([]string{"verify", "--project", id, "--id", iid, "--pass", "maybe"}, "2.0.0", dir, &b) != 1 {
		t.Fatal("invalid verify accepted")
	}
	var errorResult map[string]any
	if e := json.Unmarshal(b.Bytes(), &errorResult); e != nil || errorResult["ok"] != false {
		t.Fatal(b.String())
	}
}

func TestCoreCLIExportCanBeImportedDirectly(t *testing.T) {
	source := t.TempDir()
	p := coreMap(coreTestCLI(t, source, "project", "create", "--name", "可恢复项目")["project"])
	id := coreString(p["id"])
	coreTestCLI(t, source, "item", "add", "--project", id, "--body", "恢复需求", "--executor", "plugin:codex")
	file := filepath.Join(t.TempDir(), "workspace-export.json")
	exported := coreTestCLI(t, source, "workspace", "export", "--out", file)
	destination := t.TempDir()
	imported := coreTestCLI(t, destination, "workspace", "import", "--file", file)
	if imported["replaced"] != false || coreNum(imported["projects"]) != int64(len(coreList(coreMap(exported["workspace"])["projects"]))) {
		t.Fatal("CLI export/import counts mismatch")
	}
	restored := coreTestCLI(t, destination, "workspace", "get")
	rp := coreFind(coreList(coreMap(restored["state"])["projects"]), id)
	if rp == nil || rp["name"] != "可恢复项目" || len(coreList(rp["items"])) != 1 || coreMap(coreList(rp["items"])[0])["executor"] != "plugin:codex" {
		t.Fatal("CLI export content lost")
	}
	coreTestCLI(t, destination, "workspace", "import", "--file", file, "--replace")
}
