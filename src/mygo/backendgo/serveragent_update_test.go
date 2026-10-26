package backendgo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/pkg/sftp"
)

func TestServerUpdatePlanPreservesDeploymentAndChecksOwnership(t *testing.T) {
	left, right := net.Pipe()
	server := sftp.NewRequestServer(left, sftp.InMemHandler())
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { _ = server.Close(); _ = left.Close(); _ = right.Close() })
	c, err := sftp.NewClientPipe(right, right)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	home, err := c.RealPath(".")
	if err != nil {
		t.Fatal(err)
	}
	dir := path.Join(home, "reqflow-server")
	dataDir := path.Join(home, "custom data")
	for _, name := range []string{dir, dataDir} {
		if err = c.MkdirAll(name); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &syncServerConfig{Host: "::", Port: 18877, DataDir: dataDir, Token: "original-token-0123456789abcdef", CertPath: "/ssl/site.pem", KeyPath: "/ssl/private.pem"}
	legacy, _ := json.Marshal(cfg)
	if err = syncUploadAgentFile(c, path.Join(dir, "reqflow-server"), []byte("old binary"), 0755); err != nil {
		t.Fatal(err)
	}
	if err = syncUploadAgentFile(c, path.Join(dir, "server-config.json"), legacy, 0600); err != nil {
		t.Fatal(err)
	}
	secret := syncServerSecret{Token: cfg.Token}
	for _, format := range []string{"json", "sqlite"} {
		if format == "sqlite" {
			raw, err := syncConfigBytes(cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err = syncUploadAgentFile(c, path.Join(dir, "server-config.sqlite"), raw, 0600); err != nil {
				t.Fatal(err)
			}
		}
		plan, err := syncReadAgentUpdatePlan(c, secret)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(plan.Config, cfg) || path.Ext(plan.ConfigPath) != "."+format {
			t.Fatalf("update changed deployment configuration: %+v", plan)
		}
		if _, err = syncReadAgentUpdatePlan(c, syncServerSecret{Token: "wrong-token-0123456789abcdef"}); err == nil {
			t.Fatal("wrong SSH deployment must be rejected before any upload")
		}
		if bytes, err := syncReadSFTPFile(c, path.Join(dir, "reqflow-server")); err != nil || string(bytes) != "old binary" {
			t.Fatal("inspection modified the running binary", err)
		}
	}
}

func TestServerUpdateRequiresVerifiedCurrentBinary(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "reqflow-server-linux-amd64")
	raw := []byte("verified server fixture")
	digest := sha256.Sum256(raw)
	if err := os.WriteFile(binary, raw, 0600); err != nil {
		t.Fatal(err)
	}
	info := map[string]any{"version": "2.12.3", "serverBinaries": []any{map[string]any{"name": filepath.Base(binary), "size": len(raw), "sha256": hex.EncodeToString(digest[:])}}}
	if err := aiWriteJSON(filepath.Join(dir, "build-info.json"), info); err != nil {
		t.Fatal(err)
	}
	if err := syncVerifyServerBinary(binary, "2.12.3"); err != nil {
		t.Fatal(err)
	}
	if err := syncVerifyServerBinary(binary, "2.12.2"); err == nil {
		t.Fatal("stale packaged binaries must not be uploaded")
	}
	if err := os.WriteFile(binary, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := syncVerifyServerBinary(binary, "2.12.3"); err == nil {
		t.Fatal("corrupted server binary passed verification")
	}
}

func TestServerUpdateVerifiesVersionProtocolTokenAndCertificate(t *testing.T) {
	protocol := "flow-v2"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/info" || r.Header.Get("Authorization") != "Bearer original-token-0123456789abcdef" {
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": syncServerRealm, "version": "2.12.3", "protocol": protocol})
	}))
	defer server.Close()
	host, portText, _ := net.SplitHostPort(strings.TrimPrefix(server.URL, "https://"))
	port, _ := strconv.Atoi(portText)
	agent := map[string]any{"host": host, "port": port, "tlsMode": "pin"}
	secret := syncServerSecret{Token: "original-token-0123456789abcdef", Fingerprint: syncCertificateFingerprint(server.Certificate().Raw)}
	if err := syncCheckUpdatedAgent(context.Background(), agent, secret, "2.12.3"); err != nil {
		t.Fatal(err)
	}
	if err := syncCheckUpdatedAgent(context.Background(), agent, secret, "2.12.2"); err == nil {
		t.Fatal("version mismatch must not report update success")
	}
	protocol = "sync-v1"
	if err := syncCheckUpdatedAgent(context.Background(), agent, secret, "2.12.3"); err == nil {
		t.Fatal("legacy flow protocol must not report update success")
	}
	protocol = "flow-v2"
	bad := secret
	bad.Token = "wrong-token-0123456789abcdef"
	if err := syncCheckUpdatedAgent(context.Background(), agent, bad, "2.12.3"); err == nil {
		t.Fatal("wrong token must not report update success")
	}
	bad = secret
	bad.Fingerprint = strings.Repeat("00", 32)
	if err := syncCheckUpdatedAgent(context.Background(), agent, bad, "2.12.3"); err == nil {
		t.Fatal("changed certificate must not report update success")
	}
}

func TestServerUpdateRollbackNeverTouchesDataOrCredentials(t *testing.T) {
	plan := &syncAgentUpdatePlan{Home: "/home/test user", Dir: "/home/test user/reqflow-server", ConfigPath: "/home/test user/reqflow-server/server-config.json", Config: &syncServerConfig{DataDir: "/srv/private data", Token: "do-not-print-this-token"}}
	prepare, rollback, cleanup := syncAgentUpdateScripts(plan, plan.Dir+"/.update-fixture")
	for _, script := range []string{prepare, rollback, cleanup} {
		if strings.Contains(script, plan.Config.DataDir) || strings.Contains(script, plan.Config.Token) || strings.Contains(script, "rm -rf") || strings.Contains(script, "pkill") {
			t.Fatal("update must only touch the scoped executable and deployment files")
		}
	}
	if !strings.Contains(rollback, " run --config ") || strings.Contains(rollback, " server run ") {
		t.Fatal("rollback must support original standalone server command syntax")
	}
	if !strings.Contains(rollback, "server-config.json") || !strings.Contains(rollback, "/unit") || !strings.Contains(rollback, "/crontab") {
		t.Fatal("rollback must restore the original config and startup configuration")
	}
}

func TestServerAgentSSHUpdateTargetRoundTrip(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	r, err := b.invokeServerAgents("server:agents:save", []any{map[string]any{"name": "NAS", "host": "nas.lan", "port": 8787, "tlsMode": "pin", "ssh": "root@nas.lan:2222"}})
	if err != nil {
		t.Fatal(err)
	}
	listed, err := b.invokeServerAgents("server:agents:get", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(listed)
	var wire map[string]any
	if err = json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	entries := coreList(wire["servers"])
	if len(entries) != 1 || coreMap(entries[0])["ssh"] != "root@nas.lan:2222" || coreMap(entries[0])["id"] != coreMap(r)["id"] {
		t.Fatal("saved SSH update target was not returned to the page")
	}
}

func TestServerUpdateScriptsRestoreActualDeploymentFiles(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if runtime.GOOS == "windows" {
		bash = "C:/Program Files/Git/bin/bash.exe"
		if _, err = os.Stat(bash); err != nil {
			t.Skip("Git Bash is unavailable for the isolated shell test")
		}
	} else if err != nil {
		t.Skip("bash is unavailable")
	}
	home := t.TempDir()
	dir := filepath.Join(home, "reqflow-server")
	unit := filepath.Join(home, ".config/systemd/user/reqflow-server.service")
	stubBin := filepath.Join(home, "stub-bin")
	cron := filepath.Join(home, "crontab")
	put := func(file, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(text), 0700); err != nil {
			t.Fatal(err)
		}
	}
	put(filepath.Join(stubBin, "systemctl"), "#!/bin/sh\nexit 0\n")
	put(filepath.Join(stubBin, "crontab"), "#!/bin/sh\nif [ \"$1\" = \"-l\" ]; then cat \"$REQFLOW_TEST_CRONTAB\"; else cp -- \"$1\" \"$REQFLOW_TEST_CRONTAB\"; fi\n")
	originals := map[string]string{filepath.Join(dir, "reqflow-server"): "old executable", filepath.Join(dir, "server-config.json"): "original config", unit: "original unit", cron: "@reboot original command\n", filepath.Join(home, "data/keep"): "preserve user data"}
	for file, text := range originals {
		put(file, text)
	}
	posix := func(file string) string {
		file = filepath.ToSlash(file)
		if runtime.GOOS == "windows" {
			return "/" + strings.ToLower(file[:1]) + file[2:]
		}
		return file
	}
	plan := &syncAgentUpdatePlan{Home: posix(home), Dir: posix(dir), ConfigPath: posix(filepath.Join(dir, "server-config.json")), Config: &syncServerConfig{DataDir: posix(filepath.Join(home, "data"))}}
	prepare, rollback, cleanup := syncAgentUpdateScripts(plan, plan.Dir+"/.update-fixture")
	run := func(script string) {
		t.Helper()
		// Stubs ensure this test never calls the host's systemd or crontab.
		prefix := "PATH=" + syncShellQuote(posix(stubBin)) + ":\"$PATH\"; export PATH\nREQFLOW_TEST_CRONTAB=" + syncShellQuote(posix(cron)) + "; export REQFLOW_TEST_CRONTAB\n"
		command := exec.Command(bash, "-s")
		command.Stdin = strings.NewReader(prefix + script)
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("isolated deployment script failed: %v\n%s", err, out)
		}
	}
	run(prepare)
	put(filepath.Join(dir, "reqflow-server"), "bad new executable")
	put(filepath.Join(dir, "server-config.sqlite"), "new config")
	put(unit, "new unit")
	put(cron, "new cron\n")
	run(rollback)
	for file, text := range originals {
		raw, err := os.ReadFile(file)
		if err != nil || string(raw) != text {
			t.Fatalf("failed to restore %s: %q %v", file, raw, err)
		}
	}
	if _, err = os.Stat(filepath.Join(dir, "server-config.sqlite")); !os.IsNotExist(err) {
		t.Fatal("rollback must remove the newly migrated config for the legacy binary")
	}
	run(cleanup)
}
