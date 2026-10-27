package backendgo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

func syncResolveRemoteDataDir(home, input string) (string, error) {
	value := strings.TrimSpace(input)
	if value == "" {
		value = "~/reqflow-server/data"
	}
	if value == "~" {
		value = home
	} else if strings.HasPrefix(value, "~/") {
		value = path.Join(home, value[2:])
	}
	if !path.IsAbs(value) || strings.ContainsAny(value, "\x00\r\n") {
		return "", errors.New("远程数据目录须为绝对路径或 ~/ 开头的路径")
	}
	value = path.Clean(value)
	if value == "/" || value == path.Clean(home) || value == path.Join(home, "reqflow-server") {
		return "", errors.New("请使用独立的数据子目录，不能使用根目录、主目录或程序安装目录")
	}
	return value, nil
}

func syncStopExecutableScript(binary string) string {
	return "binary=" + syncShellQuote(binary) + "\n" + `for entry in /proc/[0-9]*/exe; do
  executable=$(readlink "$entry" 2>/dev/null) || continue
  if [ "$executable" = "$binary" ] || [ "$executable" = "$binary (deleted)" ]; then
    pid=${entry#/proc/}; pid=${pid%/exe}; kill "$pid" 2>/dev/null || true
  fi
done
attempt=0
while [ "$attempt" -lt 20 ]; do
  running=0
  for entry in /proc/[0-9]*/exe; do
    executable=$(readlink "$entry" 2>/dev/null) || continue
    if [ "$executable" = "$binary" ] || [ "$executable" = "$binary (deleted)" ]; then running=1; fi
  done
  if [ "$running" -eq 0 ]; then break; fi
  attempt=$((attempt+1)); sleep 0.5
done
if [ "$running" -ne 0 ]; then exit 1; fi
`
}

func syncRemoveCronScript(binary string) string {
	return "binary=" + syncShellQuote(binary) + "\n" + `if command -v crontab >/dev/null 2>&1; then
  existing=$(crontab -l 2>/dev/null) || existing=""
  printf '%s\n' "$existing" | grep -F -v "$binary" | crontab - || exit 1
fi
`
}

func syncReadSFTPFile(c *sftp.Client, file string) ([]byte, error) {
	f, err := c.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 16<<20))
	return raw, err
}

func syncDeploymentConfig(c *sftp.Client, dir string) (*syncServerConfig, error) {
	raw, err := syncReadSFTPFile(c, path.Join(dir, "server-config.sqlite"))
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		raw, err = syncReadSFTPFile(c, path.Join(dir, "server-config.json"))
		if err != nil {
			return nil, err
		}
		var cfg syncServerConfig
		err = json.Unmarshal(raw, &cfg)
		return &cfg, err
	}
	return syncDecodeConfigBytes(raw)
}

func syncDecodeConfigBytes(raw []byte) (*syncServerConfig, error) {
	temp, err := os.MkdirTemp("", "reqflow-deployment-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temp)
	file := filepath.Join(temp, "config.sqlite")
	if err = os.WriteFile(file, raw, 0600); err != nil {
		return nil, err
	}
	return syncReadConfigSQL(file)
}

// Never follow symlinks when removing a selected deployment data directory.
func syncRemoveSFTPTree(c *sftp.Client, root, current string) error {
	if current != root && !strings.HasPrefix(current, root+"/") {
		return errors.New("清理路径超出数据目录")
	}
	info, err := c.Lstat(current)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return c.Remove(current)
	}
	entries, err := c.ReadDir(current)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "." || entry.Name() == ".." || strings.Contains(entry.Name(), "/") {
			return errors.New("远程目录项无效")
		}
		if err = syncRemoveSFTPTree(c, root, path.Join(current, entry.Name())); err != nil {
			return err
		}
	}
	return c.RemoveDirectory(current)
}

func syncValidateCleanup(c *sftp.Client, home, installDir, dataDir string) (string, error) {
	root, err := syncResolveRemoteDataDir(home, dataDir)
	if err != nil {
		return "", err
	}
	if root == installDir || strings.HasPrefix(installDir, root+"/") {
		return "", errors.New("数据目录包含程序目录，拒绝清理")
	}
	info, err := c.Lstat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("数据目录不是普通目录，拒绝清理符号链接")
	}
	actual, err := c.RealPath(root)
	if err != nil {
		return "", err
	}
	if actual != root {
		return "", errors.New("数据目录含符号链接，请核对真实路径后卸载")
	}
	if raw, readErr := syncReadSFTPFile(c, path.Join(root, "deployment.sqlite")); readErr == nil {
		cfg, parseErr := syncDecodeConfigBytes(raw)
		if parseErr != nil || path.Clean(cfg.DataDir) != root {
			return "", errors.New("服务端数据标记与配置不一致，拒绝清理")
		}
	} else {
		if !os.IsNotExist(readErr) {
			return "", readErr
		}
		raw, readErr := syncReadSFTPFile(c, path.Join(root, "reqflow-server.json"))
		var marker map[string]any
		if readErr != nil || json.Unmarshal(raw, &marker) != nil || marker["service"] != syncServerRealm {
			return "", errors.New("未找到 ReqFlow 服务端数据标记，拒绝清理该目录")
		}
	}
	return root, nil
}

func (b *Backend) syncAgentUninstall(args []any) (map[string]any, error) {
	input := aiMap(aiArg(args, 0))
	target := strings.TrimSpace(aiString(input["ssh"]))
	if target == "" {
		return nil, errors.New("请填写免密 SSH 目标")
	}
	remote, err := parseSSHRoot("ssh://" + strings.ReplaceAll(target, "#", "%23") + "/./")
	if err != nil {
		return nil, err
	}
	if aiString(input["serverId"]) == "" {
		servers, err := b.syncReadAgents()
		if err != nil {
			return nil, err
		}
		for _, server := range servers {
			if strings.EqualFold(aiString(server["host"]), remote.Hostname()) || strings.TrimSpace(aiString(server["ssh"])) == target {
				return nil, errors.New("请选择对应的服务端配置，确保卸载后正确切换项目")
			}
		}
	}
	if id := aiString(input["serverId"]); id != "" {
		servers, err := b.syncReadAgents()
		if err != nil {
			return nil, err
		}
		matched := false
		for _, server := range servers {
			if aiString(server["id"]) == id {
				saved := strings.TrimSpace(aiString(server["ssh"]))
				matched = (saved != "" && saved == target) || (saved == "" && strings.EqualFold(aiString(server["host"]), remote.Hostname()))
			}
		}
		if !matched {
			return nil, errors.New("所选服务端与 SSH 目标不匹配，请重新选择")
		}
	}
	sshArgs := []string{"-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10"}
	if remote.Port() != "" {
		sshArgs = append(sshArgs, "-p", remote.Port())
	}
	if remote.User != nil {
		sshArgs = append(sshArgs, "-l", remote.User.Username())
	}
	run := func(script string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, stderr, err := desktopRun(ctx, "ssh", append(append([]string{}, sshArgs...), "--", remote.Hostname(), script), "", 30*time.Second)
		return syncSSHCommandError(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := withSFTP(ctx, remote.String(), func(c *sftp.Client, u *url.URL) (any, error) {
		home, err := c.RealPath(".")
		if err != nil {
			return nil, err
		}
		dir := path.Join(home, "reqflow-server")
		info, err := c.Lstat(dir)
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("安装目录为符号链接，拒绝自动卸载")
		}
		cfg, err := syncDeploymentConfig(c, dir)
		if err != nil {
			return nil, fmt.Errorf("读取服务端部署配置失败，未执行卸载：%w", err)
		}
		if input["preview"] == true {
			return map[string]any{"ok": true, "dataDir": cfg.DataDir}, nil
		}
		if aiString(input["confirmedDataDir"]) != cfg.DataDir {
			return nil, errors.New("卸载范围尚未确认或数据目录已变更，请重新检查卸载范围")
		}
		clean := input["cleanData"] == true
		dataRoot := ""
		if clean {
			dataRoot, err = syncValidateCleanup(c, home, dir, cfg.DataDir)
			if err != nil {
				return nil, err
			}
		}
		binary := path.Join(dir, "reqflow-server")
		// Scope process termination to the actual executable, including an inode
		// replaced by an upgrade; never kill by a broad process-name pattern.
		script := "systemctl --user disable --now reqflow-server 2>/dev/null || true\n" + syncStopExecutableScript(binary) + syncRemoveCronScript(binary) +
			"rm -f -- " + syncShellQuote(path.Join(home, ".config/systemd/user/reqflow-server.service")) + "\nsystemctl --user daemon-reload 2>/dev/null || true\n"
		if err = run(script); err != nil {
			return nil, fmt.Errorf("停止远程服务失败，数据保留：%w", err)
		}
		// Verify termination before removing data or configuration.
		if err = run("binary=" + syncShellQuote(binary) + "; for entry in /proc/[0-9]*/exe; do executable=$(readlink \"$entry\" 2>/dev/null) || continue; if [ \"$executable\" = \"$binary\" ] || [ \"$executable\" = \"$binary (deleted)\" ]; then exit 1; fi; done"); err != nil {
			return nil, errors.New("远程服务仍在运行，未删除程序或数据，请稍后重试")
		}
		if clean {
			if err = syncRemoveSFTPTree(c, dataRoot, dataRoot); err != nil {
				return nil, fmt.Errorf("服务已停止，但清理数据失败：%w", err)
			}
		}
		for _, name := range []string{"reqflow-server", "server-config.sqlite", "server-config.sqlite-journal", "server-config.json", "server.log"} {
			if err = c.Remove(path.Join(dir, name)); err != nil && !os.IsNotExist(err) {
				return nil, err
			}
		}
		_ = c.RemoveDirectory(dir) // Nonempty directories and retained data stay.
		return map[string]any{"ok": true, "dataDir": cfg.DataDir, "dataRemoved": clean}, nil
	})
	if err != nil {
		return nil, err
	}
	if input["preview"] != true {
		if err := b.syncRemoveUninstalledAgent(target, aiString(input["serverId"])); err != nil {
			return nil, err
		}
	}

	return aiMap(result), nil
}

// Read the existing deployment token over an authenticated SSH connection; do not rotate it.
func (b *Backend) syncAgentRequestToken(args []any) (map[string]any, error) {
	target := strings.TrimSpace(aiString(aiArg(args, 0)))
	remote, err := parseSSHRoot("ssh://" + strings.ReplaceAll(target, "#", "%23") + "/./")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := withSFTP(ctx, remote.String(), func(c *sftp.Client, _ *url.URL) (any, error) {
		home, err := c.RealPath(".")
		if err != nil {
			return nil, err
		}
		cfg, err := syncDeploymentConfig(c, path.Join(home, "reqflow-server"))
		if err != nil {
			return nil, fmt.Errorf("读取服务端配置失败：%w", err)
		}
		if !syncValidToken(cfg.Token) {
			return nil, errors.New("服务端未配置有效访问令牌")
		}
		return map[string]any{"ok": true, "token": cfg.Token}, nil
	})
	if err != nil {
		return nil, err
	}
	return aiMap(result), nil
}

func (b *Backend) syncRemoveUninstalledAgent(target, selectedID string) error {
	servers, readErr := b.syncReadAgents()
	if readErr != nil {
		return fmt.Errorf("远程已卸载，但读取本地配置失败：%w", readErr)
	}
	for _, server := range servers {
		// Only remove the explicitly selected configuration, or one whose saved SSH target matches exactly.
		id := aiString(server["id"])
		if id != selectedID && strings.TrimSpace(aiString(server["ssh"])) != target {
			continue
		}
		b.syncDisconnect(id)
		record, readErr := b.Workspace.store.read()
		if readErr != nil {
			return fmt.Errorf("远程已卸载，但读取项目备份失败：%w", readErr)
		}
		if record != nil {
			for _, item := range coreList(coreMap(record["data"])["projects"]) {
				project := coreMap(item)
				if aiString(coreMap(project["serverAgent"])["id"]) == id {
					if _, err := b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": project["id"], "server": nil}, nil); err != nil {
						return fmt.Errorf("远程已卸载，但项目切换到本地失败：%w", err)
					}
				}
			}
		}
		if _, err := b.invokeServerAgents("server:agents:delete", []any{id}); err != nil {
			return fmt.Errorf("远程已卸载，但删除本地服务端配置失败：%w", err)
		}
	}
	return nil
}
