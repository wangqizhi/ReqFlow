package backendgo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

type syncSSHRun func(string, time.Duration) (string, error)

func syncSSHCommandError(stderr string, err error) error {
	if err == nil {
		return nil
	}
	detail := strings.TrimSpace(desktopCleanLog(stderr))
	if detail == "" {
		return err
	}
	hint := "SSH 命令失败"
	lower := strings.ToLower(detail)
	switch {
	case strings.Contains(lower, "permission denied"), strings.Contains(lower, "authentication failed"):
		hint = "SSH 认证失败，请使用原部署的用户名和公钥；只填 IP 会使用 SSH 配置或本机用户名"
	case strings.Contains(lower, "host key verification failed"), strings.Contains(lower, "remote host identification has changed"):
		hint = "SSH 主机指纹校验失败，请核对服务器身份及 known_hosts"
	case strings.Contains(lower, "could not resolve hostname"):
		hint = "无法解析 SSH 主机，请检查地址或本机 SSH 别名配置"
	case strings.Contains(lower, "connection refused"), strings.Contains(lower, "timed out"), strings.Contains(lower, "no route to host"):
		hint = "SSH 网络连接失败，请核对 SSH 端口与网络；SSH 端口不同于 Server 的 HTTPS 端口"
	}
	return fmt.Errorf("%s：%s（%w）", hint, detail, err)
}

func syncAgentSSH(target string) (*url.URL, syncSSHRun, error) {
	remote, err := parseSSHRoot("ssh://" + strings.ReplaceAll(target, "#", "%23") + "/./")
	if err != nil {
		return nil, nil, err
	}
	args := []string{"-oBatchMode=yes", "-oPreferredAuthentications=publickey", "-oPasswordAuthentication=no", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10"}
	if remote.Port() != "" {
		args = append(args, "-p", remote.Port())
	}
	if remote.User != nil {
		args = append(args, "-l", remote.User.Username())
	}
	run := func(script string, timeout time.Duration) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		output, stderr, err := desktopRun(ctx, "ssh", append(append([]string{}, args...), "--", remote.Hostname(), script), "", timeout)
		return strings.TrimSpace(output), syncSSHCommandError(stderr, err)
	}
	return remote, run, nil
}

func syncVerifyServerBinary(file, version string) error {
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "build-info.json"))
	if err != nil {
		return errors.New("缺少服务端构建信息，请安装完整的当前版本 ReqFlow")
	}
	var info struct {
		Version        string `json:"version"`
		ServerBinaries []struct {
			Name   string `json:"name"`
			SHA256 string `json:"sha256"`
			Size   int    `json:"size"`
		} `json:"serverBinaries"`
	}
	if json.Unmarshal(raw, &info) != nil || info.Version != version {
		return errors.New("安装目录中的服务端版本与桌面端不一致，请重新安装当前版本 ReqFlow")
	}
	bytes, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("读取服务端程序失败：%w", err)
	}
	digest := sha256.Sum256(bytes)
	for _, binary := range info.ServerBinaries {
		if binary.Name == filepath.Base(file) && binary.Size == len(bytes) && binary.SHA256 == hex.EncodeToString(digest[:]) {
			return nil
		}
	}
	return errors.New("服务端程序与构建校验值不一致，未上传，请重新安装当前版本 ReqFlow")
}

type syncAgentUpdatePlan struct {
	Home, Dir, ConfigPath string
	Config                *syncServerConfig
}

func syncReadAgentUpdatePlan(c *sftp.Client, secret syncServerSecret) (*syncAgentUpdatePlan, error) {
	home, err := c.RealPath(".")
	if err != nil {
		return nil, err
	}
	dir := path.Join(home, "reqflow-server")
	info, err := c.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("部署目录不是普通目录，拒绝自动更新")
	}
	actual, err := c.RealPath(dir)
	if err != nil {
		return nil, err
	}
	if actual != dir {
		return nil, errors.New("部署目录含符号链接，拒绝自动更新")
	}
	cfg, err := syncDeploymentConfig(c, dir)
	if err != nil {
		return nil, fmt.Errorf("读取原部署配置失败，未更新：%w", err)
	}
	if !syncValidToken(secret.Token) || syncTokenHash(cfg.Token) != syncTokenHash(secret.Token) {
		return nil, errors.New("SSH 部署的访问令牌与当前 Server Agent 不一致，请核对 SSH 用户和目标，未修改服务器")
	}
	if cfg.Port < 1 || cfg.Port > 65535 || !path.IsAbs(cfg.DataDir) || strings.ContainsAny(cfg.DataDir, "\x00\r\n") {
		return nil, errors.New("原服务端端口或数据目录配置无效，未更新")
	}
	if data, statErr := c.Stat(cfg.DataDir); statErr != nil || !data.IsDir() {
		return nil, errors.New("原配置的数据目录不存在或不可访问，未更新；请先核对原部署数据")
	}
	configPath := path.Join(dir, "server-config.sqlite")
	if _, err = c.Stat(configPath); err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		configPath = path.Join(dir, "server-config.json")
	}
	configInfo, err := c.Lstat(configPath)
	if err != nil {
		return nil, err
	}
	if !configInfo.Mode().IsRegular() {
		return nil, errors.New("原部署配置不是普通文件，拒绝自动更新")
	}
	info, err = c.Lstat(path.Join(dir, "reqflow-server"))
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("原服务端程序不是普通文件，拒绝自动更新")
	}
	return &syncAgentUpdatePlan{Home: home, Dir: dir, ConfigPath: configPath, Config: cfg}, nil
}

func syncAgentUpdateScripts(plan *syncAgentUpdatePlan, backup string) (prepare, rollback, cleanup string) {
	q := syncShellQuote
	binary := path.Join(plan.Dir, "reqflow-server")
	unit := path.Join(plan.Home, ".config/systemd/user/reqflow-server.service")
	prepare = "umask 077\nmkdir " + q(backup) + " && cp -p -- " + q(binary) + " " + q(backup+"/binary") + " && cp -p -- " + q(plan.ConfigPath) + " " + q(backup+"/config") + " || exit 1\n" +
		"if [ -f " + q(unit) + " ]; then cp -p -- " + q(unit) + " " + q(backup+"/unit") + " || exit 1; fi\n" +
		"if command -v crontab >/dev/null 2>&1; then crontab -l > " + q(backup+"/crontab") + " 2>/dev/null || :; fi\n"
	oldStart := q(binary) + " run --config " + q(plan.ConfigPath) + " >> " + q(plan.Dir+"/server.log") + " 2>&1 < /dev/null"
	rollback = "systemctl --user stop reqflow-server 2>/dev/null || true\n" + syncStopExecutableScript(binary) +
		"cp -p -- " + q(backup+"/binary") + " " + q(backup+"/restored") + " && mv -f -- " + q(backup+"/restored") + " " + q(binary) + " && cp -p -- " + q(backup+"/config") + " " + q(plan.ConfigPath) + " || exit 1\n"
	if path.Ext(plan.ConfigPath) == ".json" {
		rollback += "rm -f -- " + q(plan.Dir+"/server-config.sqlite") + "\n"
	}
	rollback += "if [ -f " + q(backup+"/unit") + " ]; then cp -p -- " + q(backup+"/unit") + " " + q(unit) + " || exit 1; else rm -f -- " + q(unit) + "; fi\n" +
		"if [ -f " + q(backup+"/crontab") + " ]; then crontab " + q(backup+"/crontab") + " || exit 1; fi\n" +
		"systemctl --user daemon-reload 2>/dev/null || true\n" +
		"if [ -f " + q(backup+"/unit") + " ] && systemctl --user restart reqflow-server 2>/dev/null; then :; else nohup " + oldStart + " &\nfi\n"
	cleanup = "rm -f -- " + q(backup+"/binary") + " " + q(backup+"/config") + " " + q(backup+"/unit") + " " + q(backup+"/crontab") + " " + q(backup+"/restored") + " && rmdir -- " + q(backup)
	return
}

func syncCheckUpdatedAgent(ctx context.Context, agent map[string]any, secret syncServerSecret, version string) error {
	client, _, err := syncBuildClient(agent, secret)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, "GET", syncAgentBaseURL(agent)+"/api/info", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+secret.Token)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var info struct {
		OK       bool   `json:"ok"`
		Version  string `json:"version"`
		Protocol string `json:"protocol"`
		Service  string `json:"service"`
	}
	if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&info) != nil {
		return fmt.Errorf("更新后认证检查失败（HTTP %d）", response.StatusCode)
	}
	if !info.OK || info.Service != syncServerRealm || info.Version != version || info.Protocol != "flow-v2" {
		return fmt.Errorf("更新后版本或接口不匹配：检测到 %s / %s，预期 %s / flow-v2", info.Version, info.Protocol, version)
	}
	return nil
}

func (b *Backend) syncAgentUpdate(args []any) (result map[string]any, resultErr error) {
	input := aiMap(aiArg(args, 0))
	id := strings.TrimSpace(aiString(input["id"]))
	agent, secret, err := b.syncAgentConfig(id)
	if err != nil {
		return nil, err
	}
	if aiString(agent["tlsMode"]) != "ca" && secret.Fingerprint == "" {
		return nil, errors.New("请先测试连接并确认原服务端证书指纹，再更新 Server")
	}
	target := strings.TrimSpace(aiString(input["ssh"]))
	if target == "" {
		target = aiString(agent["ssh"])
	}
	if target == "" {
		return nil, errors.New("请填写原部署使用的 SSH 目标，如 root@nas.lan")
	}
	remote, run, err := syncAgentSSH(target)
	if err != nil {
		return nil, err
	}
	platform, err := run("uname -s && uname -m", 20*time.Second)
	if err != nil {
		return nil, fmt.Errorf("SSH 连接失败，未更新：%w", err)
	}
	parts := strings.Fields(platform)
	if len(parts) != 2 || parts[0] != "Linux" {
		return nil, errors.New("更新目前支持 Linux Server Agent")
	}
	arch := map[string]string{"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}[parts[1]]
	if arch == "" {
		return nil, fmt.Errorf("暂不支持的服务器架构：%s", parts[1])
	}
	localBinary := filepath.Join(b.AppDir, "reqflow-server-linux-"+arch)
	if err = syncVerifyServerBinary(localBinary, b.Version); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	value, err := withSFTP(ctx, remote.String(), func(c *sftp.Client, u *url.URL) (any, error) { return syncReadAgentUpdatePlan(c, secret) })
	if err != nil {
		return nil, err
	}
	plan := value.(*syncAgentUpdatePlan)
	configBytes, err := syncConfigBytes(plan.Config)
	if err != nil {
		return nil, err
	}
	backup := path.Join(plan.Dir, ".update-"+coreUUID())
	prepare, rollback, cleanup := syncAgentUpdateScripts(plan, backup)
	if _, err = run(prepare, 20*time.Second); err != nil {
		return nil, fmt.Errorf("备份原程序失败，未更新：%w", err)
	}
	defer func() {
		if resultErr != nil {
			if _, err := run(rollback, 30*time.Second); err != nil {
				resultErr = fmt.Errorf("更新失败且自动恢复未完成；原程序备份在 %s，请检查服务状态：%w", backup, resultErr)
			} else {
				resultErr = fmt.Errorf("更新失败，已恢复原程序和部署配置：%w", resultErr)
			}
		} else {
			_, _ = run(cleanup, 15*time.Second)
		}
	}()
	if err = b.syncUploadOverSSH(remote.String(), configBytes, localBinary); err != nil {
		return nil, err
	}
	if _, err = syncStartAgentDeployment(run, plan.Home, plan.Dir); err != nil {
		return nil, err
	}
	healthCtx, healthCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer healthCancel()
	for {
		err = syncCheckUpdatedAgent(healthCtx, agent, secret, b.Version)
		if err == nil {
			break
		}
		select {
		case <-healthCtx.Done():
			return nil, fmt.Errorf("更新后的服务检查失败：%w", err)
		case <-time.After(500 * time.Millisecond):
		}
	}
	warning := ""
	if servers, readErr := b.syncReadAgents(); readErr == nil {
		for _, server := range servers {
			if server["id"] == id && server["host"] == agent["host"] && coreNum(server["port"]) == coreNum(agent["port"]) {
				server["ssh"] = target
			}
		}
		if writeErr := b.syncWriteAgents(servers); writeErr != nil {
			warning = "服务已更新，但保存 SSH 目标失败，下次更新需重新填写"
		}
	} else {
		warning = "服务已更新，但未能保存 SSH 目标"
	}
	paused := b.syncReadStatus()[id]["paused"] == true
	b.syncDisconnect(id)
	b.syncUpdateStatus(id, map[string]any{"version": b.Version, "lastUpdatedAt": coreNow(), "dataDir": plan.Config.DataDir, "paused": paused})
	if !paused {
		_, _ = b.syncConnect(id, true)
	}
	return map[string]any{"ok": true, "version": b.Version, "dataDir": plan.Config.DataDir, "warning": warning}, nil
}

func syncStartAgentDeployment(run syncSSHRun, home, remoteDir string) ([]string, error) {
	var err error
	startCommand := syncShellQuote(remoteDir+"/reqflow-server") + " server run --config " + syncShellQuote(remoteDir+"/server-config.sqlite")
	summary := []string{}
	unit := syncAgentSystemdUnit(remoteDir)
	unitPath := path.Join(home, ".config/systemd/user/reqflow-server.service")
	installService := "mkdir -p " + syncShellQuote(path.Dir(unitPath)) + " && printf '%s' " + syncShellQuote(unit) + " > " + syncShellQuote(unitPath) + " && systemctl --user daemon-reload && systemctl --user enable reqflow-server && systemctl --user restart reqflow-server"
	if _, err = run(installService, 20*time.Second); err == nil {
		summary = append(summary, "已启用并启动 systemd 用户服务")
		if _, cronErr := run(syncRemoveCronScript(remoteDir+"/reqflow-server"), 15*time.Second); cronErr != nil {
			summary = append(summary, "清理旧 crontab 启动项失败，请手动检查")
		}
	} else {
		if _, stopErr := run("systemctl --user stop reqflow-server 2>/dev/null || true\n"+syncStopExecutableScript(remoteDir+"/reqflow-server"), 20*time.Second); stopErr != nil {
			return nil, errors.New("旧服务端未能停止，未启动新的后台进程")
		}
		background := startCommand + " >> " + syncShellQuote(remoteDir+"/server.log") + " 2>&1"
		cronLine := "@reboot " + strings.ReplaceAll(background, "%", `\%`)
		if _, cronErr := run("(crontab -l 2>/dev/null | grep -v 'reqflow-server.*run --config'; printf '%s\\n' "+syncShellQuote(cronLine)+") | crontab -", 15*time.Second); cronErr == nil {
			summary = append(summary, "已添加 crontab @reboot 开机自启")
		} else {
			summary = append(summary, "无法配置开机自启，请手动配置："+startCommand)
		}
		if _, err = run("nohup "+background+" < /dev/null &", 15*time.Second); err != nil {
			return nil, errors.New("服务端启动命令失败：" + err.Error())
		}
	}
	return summary, nil
}
