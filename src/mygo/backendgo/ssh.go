package backendgo

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

var sshHostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:-]*$`)
var sshUserPattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$`)

func parseSSHRoot(root string) (*url.URL, error) {
	u, e := url.Parse(root)
	if e != nil || u.Scheme != "ssh" || u.Hostname() == "" || (!sshHostPattern.MatchString(u.Hostname()) && net.ParseIP(u.Hostname()) == nil) || u.RawQuery != "" || u.Fragment != "" || strings.ContainsRune(u.Path, 0) {
		return nil, errors.New("SSH 地址无效")
	}
	if u.User != nil {
		if _, password := u.User.Password(); password || !sshUserPattern.MatchString(u.User.Username()) {
			return nil, errors.New("仅支持 SSH 免密认证，不接受密码")
		}
	}
	if u.Port() != "" {
		n, e := strconv.Atoi(u.Port())
		if e != nil || n < 1 || n > 65535 {
			return nil, errors.New("SSH 端口无效")
		}
	}
	return u, nil
}

// One bounded OpenSSH/SFTP session per request. SSH configuration, agent and
// default keys remain owned by OpenSSH; no credentials enter the workspace.
func withSFTP(ctx context.Context, root string, fn func(*sftp.Client, *url.URL) (any, error)) (any, error) {
	u, e := parseSSHRoot(root)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	args := []string{"-oBatchMode=yes", "-oPreferredAuthentications=publickey", "-oPasswordAuthentication=no", "-oKbdInteractiveAuthentication=no", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=7", "-oServerAliveInterval=3", "-oServerAliveCountMax=2"}
	if u.Port() != "" {
		args = append(args, "-p", u.Port())
	}
	if u.User != nil {
		args = append(args, "-l", u.User.Username())
	}
	args = append(args, "-s", "--", u.Hostname(), "sftp")
	cmd := desktopCommand(ctx, "ssh", args, "")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, e := cmd.StdoutPipe()
	if e != nil {
		return nil, e
	}
	in, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	if e = cmd.Start(); e != nil {
		return nil, fmt.Errorf("无法启动 OpenSSH，请检查本机 ssh：%w", e)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	c, e := sftp.NewClientPipe(out, in)
	if e != nil {
		_ = cmd.Wait()
		return nil, fmt.Errorf("SSH 连接失败；请检查免密密钥与 known_hosts：%s (%v)", strings.TrimSpace(stderr.String()), e)
	}
	defer c.Close()
	r, e := fn(c, u)
	if ctx.Err() != nil {
		return nil, errors.New("SSH 请求超时或连接已中断")
	}
	return r, e
}

func sshWithin(root, target string) bool {
	return target == root || strings.HasPrefix(target, strings.TrimRight(root, "/")+"/")
}

func sshSafePath(c *sftp.Client, root, rel string) (string, error) {
	if strings.ContainsRune(rel, 0) || path.IsAbs(rel) || rel == ".." || strings.HasPrefix(path.Clean(rel), "../") {
		return "", errors.New("路径超出远程项目目录范围")
	}
	base, e := c.RealPath(root)
	if e != nil {
		return "", e
	}
	target, e := c.RealPath(path.Join(base, rel))
	if e != nil {
		return "", e
	}
	if !sshWithin(base, target) {
		return "", errors.New("路径超出远程项目目录范围")
	}
	return target, nil
}

func (b *Backend) desktopSSH(ctx context.Context, channel string, args []any) (any, error) {
	return withSFTP(ctx, desktopText(args, 0), func(c *sftp.Client, u *url.URL) (any, error) { return sshOperation(c, u, channel, args) })
}

func sshOperation(c *sftp.Client, u *url.URL, channel string, args []any) (any, error) {
	dir := u.Path
	if dir == "" {
		dir = "."
	}
	if channel == "ssh:list" || channel == "ssh:status" {
		real, e := c.RealPath(dir)
		if e != nil {
			return nil, e
		}
		info, e := c.Stat(real)
		if e != nil {
			return nil, e
		}
		if !info.IsDir() {
			return nil, errors.New("远程路径不是目录")
		}
		u.Path = real
		if channel == "ssh:status" {
			return desktopOK(nil), nil
		}
		entries, e := c.ReadDir(real)
		if e != nil {
			return nil, e
		}
		values := []map[string]any{}
		for _, f := range entries {
			if f.IsDir() {
				values = append(values, map[string]any{"name": f.Name(), "path": path.Join(real, f.Name())})
			}
		}
		sort.Slice(values, func(i, j int) bool { return desktopString(values[i]["name"]) < desktopString(values[j]["name"]) })
		return desktopOK(map[string]any{"dir": u.String(), "path": real, "entries": values}), nil
	}
	file, e := sshSafePath(c, dir, desktopText(args, 1))
	if e != nil {
		return nil, e
	}
	info, e := c.Stat(file)
	if e != nil {
		return nil, e
	}
	if channel == "fs:list" {
		entries, e := c.ReadDir(file)
		if e != nil {
			return nil, e
		}
		values := []map[string]any{}
		for _, f := range entries {
			isDir := f.IsDir()
			if f.Mode()&os.ModeSymlink != 0 {
				if st, err := c.Stat(path.Join(file, f.Name())); err == nil {
					isDir = st.IsDir()
				}
			}
			values = append(values, map[string]any{"name": f.Name(), "rel": path.Join(desktopText(args, 1), f.Name()), "dir": isDir, "size": f.Size()})
		}
		sort.Slice(values, func(i, j int) bool {
			if values[i]["dir"] != values[j]["dir"] {
				return values[i]["dir"].(bool)
			}
			return desktopString(values[i]["name"]) < desktopString(values[j]["name"])
		})
		return desktopOK(map[string]any{"entries": values}), nil
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("不是可读取的文件")
	}
	if channel == "fs:write" || channel == "fs:reveal" {
		return nil, errors.New("远程文件目前仅支持浏览，请在远程编辑器中修改")
	}
	limit := int64(2 * 1024 * 1024)
	if channel == "fs:readImage" {
		limit = 20 * 1024 * 1024
	}
	if info.Size() > limit {
		return nil, errors.New("远程文件超过预览大小限制")
	}
	f, e := c.Open(file)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil {
		return nil, e
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("远程文件超过预览大小限制")
	}
	if channel == "fs:readImage" {
		mime := desktopImageMIME[strings.TrimPrefix(strings.ToLower(path.Ext(file)), ".")]
		if mime == "" {
			return nil, errors.New("不支持的图片格式")
		}
		return desktopOK(map[string]any{"mime": mime, "dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)}), nil
	}
	if channel != "fs:read" {
		return nil, errors.New("未知远程文件操作")
	}
	if bytes.Contains(raw, []byte{0}) {
		return nil, errors.New("二进制文件，不支持文本预览")
	}
	return desktopOK(map[string]any{"content": string(raw), "size": len(raw)}), nil
}
