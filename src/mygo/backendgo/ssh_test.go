package backendgo

import (
	"io"
	"net"
	"net/url"
	"os"
	"testing"

	"github.com/pkg/sftp"
)

func TestServerDataCleanupBoundaries(t *testing.T) {
	left, right := net.Pipe()
	server := sftp.NewRequestServer(left, sftp.InMemHandler())
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { _ = server.Close(); _ = left.Close(); _ = right.Close() })
	c, err := sftp.NewClientPipe(right, right)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, dir := range []string{"/data/nested", "/outside", "/unrelated", "/home/user/reqflow-server"} {
		if err = c.MkdirAll(dir); err != nil {
			t.Fatal(err)
		}
	}
	put := func(file string, raw []byte) {
		t.Helper()
		if err := syncUploadAgentFile(c, file, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	put("/outside/keep", []byte("user data"))
	put("/data/nested/item", []byte("remote flow"))
	if _, err = syncValidateCleanup(c, "/home/user", "/home/user/reqflow-server", "/unrelated"); err == nil {
		t.Fatal("unmarked user directories must never be deleted")
	}
	raw, err := syncConfigBytes(&syncServerConfig{DataDir: "/data", Token: "test-token-0123456789abcdef", Port: 8787})
	if err != nil {
		t.Fatal(err)
	}
	put("/data/deployment.sqlite", raw)
	for _, dir := range []string{"/", "/home/user", "/home/user/reqflow-server"} {
		if _, err = syncValidateCleanup(c, "/home/user", "/home/user/reqflow-server", dir); err == nil {
			t.Fatalf("unsafe cleanup accepted: %s", dir)
		}
	}
	root, err := syncValidateCleanup(c, "/home/user", "/home/user/reqflow-server", "/data")
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Symlink("/outside", "/data/link"); err != nil {
		t.Fatal(err)
	}
	if err = c.Symlink("/data", "/data-link"); err != nil {
		t.Fatal(err)
	}
	if _, err = syncValidateCleanup(c, "/home/user", "/home/user/reqflow-server", "/data-link"); err == nil {
		t.Fatal("symlink data root must not be recursively deleted")
	}
	if err = syncRemoveSFTPTree(c, root, "/outside"); err == nil {
		t.Fatal("cleanup must stay within its selected root")
	}
	if err = syncRemoveSFTPTree(c, root, root); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Stat("/data"); !os.IsNotExist(err) {
		t.Fatal("selected data root was not removed", err)
	}
	if raw, err = syncReadSFTPFile(c, "/outside/keep"); err != nil || string(raw) != "user data" {
		t.Fatal("cleanup followed a symlink outside the data directory", err)
	}
	if _, err = c.Stat("/unrelated"); err != nil {
		t.Fatal("unrelated data was deleted", err)
	}
}

func TestSSHAddressValidation(t *testing.T) {
	for _, root := range []string{"ssh://dev@example.com:2222/home/dev", "ssh://my-alias/", "ssh://user@[::1]:22/home/a%20b"} {
		if _, e := parseSSHRoot(root); e != nil {
			t.Fatal(root, e)
		}
	}
	for _, root := range []string{"https://server/path", "ssh://user:password@server/path", "ssh://-oProxyCommand=bad/path", "ssh://server:0/path", "ssh://server:65536/path", "ssh://server/path?command=bad", "ssh://server/path%00bad"} {
		if _, e := parseSSHRoot(root); e == nil {
			t.Fatal("unsafe address accepted", root)
		}
	}
}

func TestSyncAgentUploadReplacement(t *testing.T) {
	left, right := net.Pipe()
	server := sftp.NewRequestServer(left, sftp.InMemHandler())
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { _ = server.Close(); _ = left.Close(); _ = right.Close() })
	client, err := sftp.NewClientPipe(right, right)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, content := range []string{"original server", "updated server"} {
		if err := syncUploadAgentFile(client, "/reqflow-server", []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
		file, err := client.Open("/reqflow-server")
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(file)
		_ = file.Close()
		if err != nil || string(raw) != content {
			t.Fatalf("upload mismatch: %s, %v", raw, err)
		}
	}
	entries, err := client.ReadDir("/")
	if err != nil || len(entries) != 1 || entries[0].Name() != "reqflow-server" {
		t.Fatalf("temporary uploads must be cleaned up: %+v, %v", entries, err)
	}
}

// Exercise the actual SFTP wire protocol against a server with an isolated in-memory
// filesystem; no external server, keys or user files are needed.
func TestSSHDirectoryAndFileOperations(t *testing.T) {
	root := "/project"
	left, right := net.Pipe()
	server := sftp.NewRequestServer(left, sftp.InMemHandler())
	go func() { _ = server.Serve() }()
	t.Cleanup(func() { _ = server.Close(); _ = left.Close(); _ = right.Close() })
	client, e := sftp.NewClientPipe(right, right)
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	if e = client.Mkdir(root); e != nil {
		t.Fatal(e)
	}
	if e = client.Mkdir(root + "/目录 with spaces"); e != nil {
		t.Fatal(e)
	}
	for name, content := range map[string]string{"readme.md": "# Remote 目录", "binary": "a\x00b"} {
		file, err := client.Create(root + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
		_ = file.Close()
	}
	u := &url.URL{Scheme: "ssh", Host: "fixture", Path: root}
	call := func(channel, rel string) (map[string]any, error) {
		r, e := sshOperation(client, u, channel, []any{u.String(), rel})
		return desktopMap(r), e
	}
	r, e := call("ssh:list", "")
	if e != nil {
		t.Fatal(e)
	}
	entries := desktopList(r["entries"])
	if len(entries) != 1 || desktopMap(entries[0])["name"] != "目录 with spaces" {
		t.Fatal(r)
	}
	r, e = call("fs:list", "")
	if e != nil || len(desktopList(r["entries"])) != 3 {
		t.Fatal(r, e)
	}
	r, e = call("fs:read", "readme.md")
	if e != nil || r["content"] != "# Remote 目录" {
		t.Fatal(r, e)
	}
	for _, request := range [][2]string{{"fs:read", "../outside"}, {"fs:read", "/absolute"}, {"fs:read", "binary"}, {"fs:write", "readme.md"}} {
		if _, e = call(request[0], request[1]); e == nil {
			t.Fatal("unsafe request accepted", request)
		}
	}
	file, e := client.Open(root + "/readme.md")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := io.ReadAll(file)
	_ = file.Close()
	if string(raw) != "# Remote 目录" {
		t.Fatal("read-only preview changed data")
	}
	if sshWithin("/project", "/project-other/file") || !sshWithin("/project", "/project/file") {
		t.Fatal("path boundary incorrect")
	}
}
