package backendgo

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func syncFixtureBackend(t *testing.T, baseURL, token string) (*Backend, string, string) {
	t.Helper()
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	state, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	projectID := aiString(coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"])
	host, portText, _ := net.SplitHostPort(strings.TrimPrefix(baseURL, "https://"))
	port, _ := strconv.Atoi(portText)
	r, err := b.invokeServerAgents("server:agents:save", []any{map[string]any{"id": "agent", "name": "remote", "host": host, "port": port, "tlsMode": "pin", "token": token}})
	if err != nil {
		t.Fatal(err)
	}
	serverID := aiString(coreMap(r)["id"])
	if _, err = b.syncTrust(serverID); err != nil {
		t.Fatal(err)
	}
	return b, projectID, serverID
}

func TestRemoteFlowAuthorityOfflineAndDetach(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()
	b, projectID, serverID := syncFixtureBackend(t, baseURL, token)
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": projectID, "dir": t.TempDir()}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": serverID}, nil); err != nil {
		t.Fatal(err)
	}
	// A fresh service represents the CLI: no desktop runtime connection exists.
	cli := NewWorkspaceService(b.DataDir)
	result, err := cli.Mutate(map[string]any{"op": "item", "project": projectID, "body": "remote requirement"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(result["state"])["projects"]), projectID)
	if len(coreList(p["items"])) != 1 || aiString(p["dir"]) == "" {
		t.Fatal("acknowledged flow and local directory must both survive")
	}
	response, raw := syncTestRequest(t, http.MethodGet, baseURL+"/api/sync/project?id="+projectID, token, nil)
	if response.StatusCode != 200 || !strings.Contains(string(raw), "remote requirement") || strings.Contains(string(raw), `"dir"`) {
		t.Fatalf("remote flow missing or local settings leaked: %s", raw)
	}
	// A second client changes the server after the first client's backup snapshot.
	var remote map[string]any
	_ = json.Unmarshal(raw, &remote)
	response, raw = syncTestRequest(t, http.MethodPost, baseURL+"/api/flow/mutate", token, map[string]any{"action": map[string]any{"op": "item", "project": projectID, "body": "other device"}, "revisions": map[string]any{projectID: remote["revision"]}})
	if response.StatusCode != 200 {
		t.Fatalf("remote mutation: %s", raw)
	}
	before, err := os.ReadFile(cli.DataFile())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = cli.Mutate(map[string]any{"op": "item", "project": projectID, "body": "stale device"}, nil); err == nil {
		t.Fatal("stale backup must not overwrite newer remote flow")
	} else {
		var conflict *VersionConflictError
		if !errors.As(err, &conflict) {
			t.Fatal(err)
		}
	}
	after, _ := os.ReadFile(cli.DataFile())
	if string(before) != string(after) {
		t.Fatal("rejected operation modified local backup")
	}
	refreshed, err := cli.Get()
	if err != nil {
		t.Fatal(err)
	}
	p = coreFind(coreList(coreMap(refreshed["state"])["projects"]), projectID)
	if len(coreList(p["items"])) != 2 {
		t.Fatal("reads must obtain current remote flow")
	}
	stop()
	before, _ = os.ReadFile(cli.DataFile())
	if _, err = cli.Mutate(map[string]any{"op": "item", "project": projectID, "body": "offline write"}, nil); err == nil {
		t.Fatal("linked project must not mutate locally while offline")
	}
	after, _ = os.ReadFile(cli.DataFile())
	if string(before) != string(after) {
		t.Fatal("offline write modified local backup")
	}
	if _, err = cli.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": nil}, nil); err != nil {
		t.Fatal(err)
	}
	result, err = cli.Mutate(map[string]any{"op": "item", "project": projectID, "body": "offline work after detach"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p = coreFind(coreList(coreMap(result["state"])["projects"]), projectID)
	if len(coreList(p["items"])) != 3 || p["serverAgent"] != nil {
		t.Fatal("detach must resume from the acknowledged backup")
	}
}

func TestRemoteAssociationNeverOverwritesExistingFlow(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()
	b, projectID, serverID := syncFixtureBackend(t, baseURL, token)
	for _, action := range []map[string]any{{"op": "projectSync", "project": projectID, "server": serverID}, {"op": "item", "project": projectID, "body": "remote wins"}, {"op": "projectSync", "project": projectID, "server": nil}, {"op": "item", "project": projectID, "body": "offline only"}, {"op": "projectSync", "project": projectID, "server": serverID}} {
		if _, err := b.Workspace.Mutate(action, nil); err != nil {
			t.Fatal(err)
		}
	}
	state, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(state["state"])["projects"]), projectID)
	if len(coreList(p["items"])) != 1 || aiString(coreMap(coreList(p["items"])[0])["body"]) != "remote wins" {
		t.Fatalf("reassociation must adopt remote state: %v", p["items"])
	}
}

func TestServerSQLiteConfigAndLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "server-config.json")
	cfg := &syncServerConfig{Host: "127.0.0.1", Port: 8787, DataDir: filepath.Join(dir, "custom-data"), Token: "test-token-0123456789abcdef"}
	if err := aiWriteJSON(configPath, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := syncLoadConfig(configPath)
	if err != nil || loaded.DataDir != cfg.DataDir {
		t.Fatalf("legacy config: %v %v", loaded, err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "server-config.sqlite"))
	if err != nil || !strings.HasPrefix(string(raw), "SQLite format 3") {
		t.Fatal("configuration must migrate to a SQLite file", err)
	}
	p := MakeProject("legacy project", "")
	p["id"] = "legacy-project"
	s := &syncServer{cfg: cfg}
	if err = aiWriteJSON(s.projectPath("legacy-project"), &syncProjectRecord{ID: "legacy-project", Project: p, Revision: 7}); err != nil {
		t.Fatal(err)
	}
	if err = aiWriteJSON(s.eventsPath("legacy-project"), []any{map[string]any{"event": "legacy event", "time": "2026-10-26"}}); err != nil {
		t.Fatal(err)
	}
	if err = s.migrateStore(); err != nil {
		t.Fatal(err)
	}
	record, err := s.readProject("legacy-project")
	if err != nil || record.Revision != 7 {
		t.Fatal("legacy project migration failed", err)
	}
	// A restart must not restore stale JSON over authoritative SQLite data.
	record.Project["name"] = "sqlite wins"
	db, err := s.openStore()
	if err != nil {
		t.Fatal(err)
	}
	tx, _ := db.Begin()
	_ = syncWriteProjectSQL(tx, record)
	_ = tx.Commit()
	_ = db.Close()
	if err = s.migrateStore(); err != nil {
		t.Fatal(err)
	}
	record, err = s.readProject("legacy-project")
	if err != nil || record.Project["name"] != "sqlite wins" {
		t.Fatal("restart restored stale JSON", err)
	}
	db, _ = s.openStore()
	defer db.Close()
	var count int
	if err = db.QueryRow("SELECT COUNT(*) FROM remote_events").Scan(&count); err != nil || count != 1 {
		t.Fatal("legacy events were lost or duplicated", count, err)
	}
}

func TestRemoteDataDirectoryResolution(t *testing.T) {
	for input, expected := range map[string]string{"": "/root/reqflow-server/data", "~/nas data": "/root/nas data", "/srv/reqflow/data": "/srv/reqflow/data"} {
		actual, err := syncResolveRemoteDataDir("/root", input)
		if err != nil || actual != expected {
			t.Fatalf("%s => %s %v", input, actual, err)
		}
	}
	for _, input := range []string{"/", "~", "/root", "/root/reqflow-server", "relative/path", "/srv/bad\npath"} {
		if _, err := syncResolveRemoteDataDir("/root", input); err == nil {
			t.Fatalf("unsafe directory accepted: %s", input)
		}
	}
}

func TestRecoverLegacyAttachmentBytesWithoutOverwritingRemoteFlow(t *testing.T) {
	remote := map[string]any{"name": "remote wins", "items": []any{map[string]any{"id": "requirement", "body": "server text", "attachments": []any{map[string]any{"id": "image", "name": "image.png"}, map[string]any{"id": "kept", "dataUrl": "data:image/png;base64,BBBB"}}}}}
	backup := map[string]any{"name": "stale client", "items": []any{map[string]any{"id": "requirement", "body": "old text", "attachments": []any{map[string]any{"id": "image", "dataUrl": "data:image/png;base64,AAAA"}, map[string]any{"id": "kept", "dataUrl": "data:image/png;base64,CCCC"}}}}}
	if !syncRecoverAttachmentBytes(remote, backup) {
		t.Fatal("legacy attachment bytes were not recovered")
	}
	item := coreMap(coreList(remote["items"])[0])
	attachments := coreList(item["attachments"])
	if remote["name"] != "remote wins" || item["body"] != "server text" || coreMap(attachments[0])["dataUrl"] != "data:image/png;base64,AAAA" || coreMap(attachments[1])["dataUrl"] != "data:image/png;base64,BBBB" {
		t.Fatal("attachment recovery overwrote authoritative flow")
	}
	if syncRecoverAttachmentBytes(remote, backup) {
		t.Fatal("recovery should be idempotent")
	}
}

func TestRemoteImageReadsDoNotInvalidateLocalConcurrency(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()
	b, projectID, serverID := syncFixtureBackend(t, baseURL, token)
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": serverID}, nil); err != nil {
		t.Fatal(err)
	}
	result, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": projectID, "body": "image requirement", "attachments": []any{map[string]any{"id": "image-1", "label": "图片1", "name": "x.png", "dataUrl": "data:image/png;base64,AAAA"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	version := coreNum(result["version"])
	for attempt := 0; attempt < 2; attempt++ {
		current, err := b.Workspace.Get()
		if err != nil {
			t.Fatal(err)
		}
		if coreNum(current["version"]) != version {
			t.Fatal("re-materializing image paths must not invalidate editor concurrency")
		}
		p := coreFind(coreList(coreMap(current["state"])["projects"]), projectID)
		attachment := coreMap(coreList(coreMap(coreList(p["items"])[0])["attachments"])[0])
		if !coreExists(aiString(attachment["path"])) {
			t.Fatal("image must remain available in the local backup")
		}
	}
}

func TestRemoteManualDisconnectBlocksFlowUntilReconnected(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()
	b, projectID, serverID := syncFixtureBackend(t, baseURL, token)
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": serverID}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := b.invokeServerAgents("server:disconnect", []any{serverID}); err != nil {
		t.Fatal(err)
	}
	if _, err := NewWorkspaceService(b.DataDir).Mutate(map[string]any{"op": "item", "project": projectID, "body": "paused write"}, nil); err == nil {
		t.Fatal("manual disconnect was bypassed by a fresh CLI service")
	}
	if result, err := b.invokeServerAgents("server:connect", []any{serverID}); err != nil || coreMap(result)["ok"] != true {
		t.Fatal(result, err)
	}
	if _, err := NewWorkspaceService(b.DataDir).Mutate(map[string]any{"op": "item", "project": projectID, "body": "after reconnect"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestRemoteFlowArchiveReplacementAndProjectMove(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()
	b, first, serverID := syncFixtureBackend(t, baseURL, token)
	added, err := b.Workspace.Mutate(map[string]any{"op": "project", "name": "second project"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	projects := coreList(coreMap(added["state"])["projects"])
	second := aiString(coreMap(projects[len(projects)-1])["id"])
	for _, id := range []string{first, second} {
		if _, err = b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": id, "server": serverID}, nil); err != nil {
			t.Fatal(err)
		}
	}
	result, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": first, "body": "move between remote projects"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(result["state"])["projects"]), first)
	itemID := coreMap(coreList(p["items"])[0])["id"]
	result, err = b.Workspace.Mutate(map[string]any{"op": "moveItem", "project": first, "targetProject": second, "id": itemID}, nil)
	if err != nil {
		t.Fatal(err)
	}
	projects = coreList(coreMap(result["state"])["projects"])
	if len(coreList(coreFind(projects, first)["items"])) != 0 || len(coreList(coreFind(projects, second)["items"])) != 1 {
		t.Fatal("cross-project move was not applied atomically")
	}
	state := coreMap(result["state"])
	coreFind(coreList(state["projects"]), second)["items"] = []any{}
	if _, err = b.Workspace.WriteState(state, coreNum(result["version"])); err != nil {
		t.Fatal(err)
	}
	response, raw := syncTestRequest(t, http.MethodGet, baseURL+"/api/sync/project?id="+second, token, nil)
	var remote map[string]any
	_ = json.Unmarshal(raw, &remote)
	if response.StatusCode != 200 || len(coreList(coreMap(remote["project"])["items"])) != 0 {
		t.Fatalf("archive replacement was not executed remotely: %s", raw)
	}
}

func TestUninstalledAgentDetachesOnlyMatchingProjects(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	b.Workspace.localOnly = true
	state, err := b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	projectID := coreString(coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"])
	if err = b.syncWriteAgents([]map[string]any{{"id": "one", "name": "one", "host": "one.test", "ssh": "root@one.test"}, {"id": "two", "name": "two", "host": "two.test", "ssh": "root@two.test"}}); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "item", "project": projectID, "body": "local backup"}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": "one"}, nil); err != nil {
		t.Fatal(err)
	}
	b.Workspace.localOnly = false
	if err = b.syncRemoveUninstalledAgent("root@one.test", "one"); err != nil {
		t.Fatal(err)
	}
	servers, err := b.syncReadAgents()
	if err != nil || len(servers) != 1 || servers[0]["id"] != "two" {
		t.Fatalf("remaining servers: %#v %v", servers, err)
	}
	state, err = b.Workspace.Get()
	if err != nil {
		t.Fatal(err)
	}
	p := coreFind(coreList(coreMap(state["state"])["projects"]), projectID)
	if p["serverAgent"] != nil || len(coreList(p["items"])) != 1 {
		t.Fatalf("local backup not preserved: %#v", p)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "item", "project": projectID, "body": "offline edit"}, nil); err != nil {
		t.Fatal(err)
	}
}

// REQ-242：关联远程后完成需求，可验证版本必须写入远程记录并回到本地备份。
func TestRemoteCompleteKeepsVerificationVersion(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()
	b, projectID, serverID := syncFixtureBackend(t, baseURL, token)
	if _, err := b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": serverID}, nil); err != nil {
		t.Fatal(err)
	}
	result, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": projectID, "body": "remote verify version"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	itemID := coreMap(coreList(coreFind(coreList(coreMap(result["state"])["projects"]), projectID)["items"])[0])["id"]
	if _, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": projectID, "ids": []any{itemID}}, nil); err != nil {
		t.Fatal(err)
	}
	result, err = b.Workspace.Mutate(map[string]any{"op": "complete", "project": projectID, "id": itemID, "verificationVersion": "2.13.3", "usage": []any{map[string]any{"model": "remote-provider-model", "inputTokens": 90, "outputTokens": 10, "reasoningEffort": "high", "source": "provider-report"}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	i := coreFind(coreList(coreFind(coreList(coreMap(result["state"])["projects"]), projectID)["items"]), aiString(itemID))
	if i["status"] != "pending_verification" || i["verificationVersion"] != "2.13.3" {
		t.Fatal(i)
	}
	if coreNum(coreMap(coreList(coreMap(coreList(i["history"])[0])["usage"])[0])["totalTokens"]) != 100 {
		t.Fatal("remote usage lost", i)
	}
	_, raw := syncTestRequest(t, http.MethodGet, baseURL+"/api/sync/project?id="+projectID, token, nil)
	if !strings.Contains(string(raw), `"model":"remote-provider-model"`) {
		t.Fatal("remote provider metadata lost")
	}
	if !strings.Contains(string(raw), `"verificationVersion":"2.13.3"`) {
		t.Fatalf("remote record lost verification version: %s", raw)
	}
}
