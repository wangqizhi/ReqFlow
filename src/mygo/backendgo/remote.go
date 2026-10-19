package backendgo

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var aiRemoteURL = regexp.MustCompile(`^(?:https://[^\s/@?#]+/[^\s?#]+|ssh://(?:[\w.-]+@)?[\w.-]+(?::\d+)?/[^\s?#]+|[\w.-]+@[\w.-]+:[^\s?#]+)$`)
var aiRemoteBranch = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

func aiRemoteString(value any, fallback string) string {
	if value == nil || value == false || value == "" || value == float64(0) || value == int(0) {
		return fallback
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func ValidateRemote(value any) (map[string]any, error) {
	v := aiMap(value)
	provider := aiString(v["provider"])
	if provider != "github" && provider != "gitlab" {
		return nil, errors.New("请选择 GitHub 或 GitLab")
	}
	url := strings.TrimSpace(aiRemoteString(v["url"], ""))
	if url != "" && !aiRemoteURL.MatchString(url) {
		return nil, errors.New("仓库地址须为 HTTPS 或 SSH 地址，不能包含密码或 Token")
	}
	branch := strings.TrimSpace(aiRemoteString(v["branch"], "main"))
	if branch == "" {
		branch = "main"
	}
	if !aiRemoteBranch.MatchString(branch) || strings.Contains(branch, "..") || strings.Contains(branch, "//") || strings.Contains(branch, "@{") || strings.HasSuffix(branch, "/") || strings.HasSuffix(branch, ".") {
		return nil, errors.New("分支名称无效")
	}
	for _, part := range strings.Split(branch, "/") {
		if strings.HasSuffix(part, ".lock") {
			return nil, errors.New("分支名称无效")
		}
	}
	return map[string]any{"provider": provider, "url": url, "branch": branch, "sshKeyPath": strings.TrimSpace(aiRemoteString(v["sshKeyPath"], ""))}, nil
}

func aiSSHCommand(settings map[string]any) (string, error) {
	command := "ssh -o BatchMode=yes -o ConnectTimeout=15"
	key := aiString(settings["sshKeyPath"])
	if key != "" {
		if strings.ContainsAny(key, "\"`$\r\n\x00") || !filepath.IsAbs(key) {
			return "", errors.New("SSH Key 须为有效的绝对文件路径")
		}
		info, err := os.Stat(key)
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("SSH Key 文件不存在")
		}
		command += ` -o IdentitiesOnly=yes -i "` + strings.ReplaceAll(key, `\`, "/") + `"`
	}
	return command, nil
}

func aiHideCommand(command *exec.Cmd) {
	desktopHideCommand(command)
}

type aiLimitedOutput struct {
	bytes.Buffer
	limit    int
	tooLarge bool
}

func (w *aiLimitedOutput) Write(data []byte) (int, error) {
	n := len(data)
	remaining := w.limit - w.Len()
	if n > remaining {
		w.tooLarge = true
		data = data[:max(remaining, 0)]
	}
	_, _ = w.Buffer.Write(data)
	return n, nil
}

func RunRemoteGit(args []string, root string, settings map[string]any) (string, error) {
	ssh, err := aiSSHCommand(settings)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = root
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=Never", "GIT_SSH_COMMAND="+ssh)
	aiHideCommand(command)
	stdout := &aiLimitedOutput{limit: 8 * 1024 * 1024}
	stderr := &aiLimitedOutput{limit: 1024 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	err = command.Run()
	if ctx.Err() != nil {
		return "", errors.New("Git 连接超时，请检查仓库地址与认证")
	}
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	if stdout.tooLarge {
		return "", errors.New("Git 输出过大")
	}
	return stdout.String(), nil
}

type aiBackupState struct {
	mu        sync.Mutex
	settings  map[string]any
	status    map[string]any
	quit      chan struct{}
	startOnce sync.Once
	stopOnce  sync.Once
}

var aiBackupStates sync.Map

func aiEmptyBackup() map[string]any {
	return map[string]any{"provider": "github", "url": "", "branch": "main", "sshKeyPath": "", "autoSync": false}
}
func aiCloneMap(value map[string]any) map[string]any {
	out := make(map[string]any, len(value))
	for k, v := range value {
		out[k] = v
	}
	return out
}

func (b *Backend) backupState() *aiBackupState {
	if state, ok := aiBackupStates.Load(b); ok {
		return state.(*aiBackupState)
	}
	s := &aiBackupState{settings: aiEmptyBackup(), status: map[string]any{"running": false}, quit: make(chan struct{})}
	var stored map[string]any
	if err := aiReadJSON(filepath.Join(b.DataDir, "backup-settings.json"), &stored); err == nil {
		next, err := aiValidateBackup(stored)
		if err != nil {
			s.status["error"] = "备份配置读取失败：" + err.Error()
		} else {
			s.settings = next
		}
	} else if !os.IsNotExist(err) {
		s.status["error"] = "备份配置读取失败：" + err.Error()
	}
	state, _ := aiBackupStates.LoadOrStore(b, s)
	return state.(*aiBackupState)
}

func aiValidateBackup(value any) (map[string]any, error) {
	v := aiMap(value)
	enabled, ok := v["autoSync"].(bool)
	if !ok {
		return nil, errors.New("自动同步设置无效")
	}
	settings, err := ValidateRemote(value)
	if err != nil {
		return nil, err
	}
	settings["autoSync"] = enabled
	return settings, nil
}

// StartAI restores the existing schedule without performing an immediate network request.
func (b *Backend) StartAI() {
	s := b.backupState()
	s.startOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-s.quit:
					return
				case <-ticker.C:
					s.mu.Lock()
					run := s.settings["autoSync"] == true && aiString(s.settings["url"]) != "" && s.status["running"] != true
					s.mu.Unlock()
					if run {
						_, _ = b.syncBackup()
					}
				}
			}
		}()
	})
}
func (b *Backend) StopAI() {
	if state, ok := aiBackupStates.Load(b); ok {
		state.(*aiBackupState).stopOnce.Do(func() { close(state.(*aiBackupState).quit) })
	}
}

func (b *Backend) syncBackup() (map[string]any, error) {
	s := b.backupState()
	s.mu.Lock()
	if s.status["running"] == true {
		status := aiCloneMap(s.status)
		s.mu.Unlock()
		return status, errors.New("正在同步，请稍候")
	}
	settings := aiCloneMap(s.settings)
	if aiString(settings["url"]) == "" {
		status := aiCloneMap(s.status)
		s.mu.Unlock()
		return status, errors.New("请先配置备份仓库")
	}
	s.status["running"] = true
	s.mu.Unlock()
	err := b.performBackup(settings)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status["running"] = false
	if err != nil {
		s.status["error"] = err.Error()
	} else {
		s.status = map[string]any{"running": false, "lastSuccess": time.Now().UTC().Format(time.RFC3339Nano)}
	}
	return aiCloneMap(s.status), err
}

func (b *Backend) performBackup(settings map[string]any) error {
	url, branch := aiString(settings["url"]), aiString(settings["branch"])
	digest := sha256.Sum256([]byte(url + "\n" + branch))
	repo := filepath.Join(b.DataDir, "backup-repos", hex.EncodeToString(digest[:])[:24])
	if err := os.MkdirAll(repo, 0700); err != nil {
		return err
	}
	realData, err := filepath.EvalSymlinks(b.DataDir)
	if err != nil {
		return err
	}
	realRepo, err := filepath.EvalSymlinks(repo)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(realData, realRepo)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errors.New("备份目录不能指向数据目录外")
	}
	git := func(args ...string) (string, error) { return RunRemoteGit(args, repo, settings) }
	if _, err := os.Stat(filepath.Join(repo, ".git")); os.IsNotExist(err) {
		if _, err = git("init"); err != nil {
			return err
		}
		if _, err = git("remote", "add", "origin", url); err != nil {
			return err
		}
	}
	// Read the configured identity before Git applies legitimate url.*.insteadOf
	// authentication/transport rewrites. The managed checkout must still belong
	// to the same configured remote, even when its effective transport changes.
	origin, err := git("config", "--get", "remote.origin.url")
	if err != nil {
		return err
	}
	if strings.TrimSpace(origin) != url {
		return errors.New("备份检出目录的 origin 与配置地址不一致")
	}
	refs, err := git("ls-remote", "--heads", "origin", branch)
	if err != nil {
		return err
	}
	if strings.TrimSpace(refs) != "" {
		if _, err = git("fetch", "origin", branch); err != nil {
			return err
		}
		local, _ := git("rev-parse", "--verify", "HEAD")
		if strings.TrimSpace(local) == "" {
			_, err = git("checkout", "-B", branch, "FETCH_HEAD")
		} else {
			_, err = git("merge", "--ff-only", "FETCH_HEAD")
		}
		if err != nil {
			return err
		}
	} else {
		heads, err := git("ls-remote", "--heads", "origin")
		if err != nil {
			return err
		}
		if strings.TrimSpace(heads) != "" {
			return errors.New("远程分支不存在，请填写已有分支或使用空仓库")
		}
		if _, err = git("symbolic-ref", "HEAD", "refs/heads/"+branch); err != nil {
			return err
		}
	}
	workspace, err := b.Workspace.Get()
	if err != nil {
		return err
	}
	state := workspace["state"]
	if state == nil {
		return errors.New("工作区尚未初始化")
	}
	destination := filepath.Join(repo, "reqflow-backup.json")
	if info, err := os.Lstat(destination); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("备份目标不能为符号链接")
	} else if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err = aiWriteJSON(destination, map[string]any{"format": "reqflow-backup-v1", "workspace": state, "settings": map[string]any{"backup": settings}}); err != nil {
		return err
	}
	if _, err = git("add", "--", "reqflow-backup.json"); err != nil {
		return err
	}
	diff, err := git("diff", "--cached", "--name-only", "--", "reqflow-backup.json")
	if err != nil {
		return err
	}
	if strings.TrimSpace(diff) != "" {
		if _, err = git("-c", "user.name=ReqFlow Backup", "-c", "user.email=backup@reqflow.local", "commit", "-m", "backup: sync ReqFlow workspace and settings", "--", "reqflow-backup.json"); err != nil {
			return err
		}
	}
	_, err = git("push", "origin", "HEAD:refs/heads/"+branch)
	return err
}

func (b *Backend) invokeRemote(channel string, args []any) (any, error) {
	s := b.backupState()
	switch channel {
	case "backup:get":
		s.mu.Lock()
		defer s.mu.Unlock()
		return map[string]any{"ok": true, "settings": aiCloneMap(s.settings), "status": aiCloneMap(s.status)}, nil
	case "backup:save":
		next, err := aiValidateBackup(aiArg(args, 0))
		if err != nil {
			return nil, err
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.status["running"] == true {
			return nil, errors.New("备份正在同步，请完成后再修改配置")
		}
		if err = aiWriteJSON(filepath.Join(b.DataDir, "backup-settings.json"), next); err != nil {
			return nil, err
		}
		s.settings = next
		s.status = map[string]any{"running": false}
		return map[string]any{"ok": true}, nil
	case "backup:sync":
		status, err := b.syncBackup()
		if err != nil {
			return map[string]any{"ok": false, "error": err.Error(), "status": status}, nil
		}
		return map[string]any{"ok": true, "status": status}, nil
	case "backup:import":
		return b.importBackup(args...)
	case "remote:test":
		settings, err := ValidateRemote(aiArg(args, 0))
		if err != nil {
			return nil, err
		}
		if aiString(settings["url"]) == "" {
			return nil, errors.New("请填写仓库地址")
		}
		scratch, err := os.MkdirTemp("", "reqflow-connection-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(scratch)
		_, err = RunRemoteGit([]string{"ls-remote", "--symref", "--", aiString(settings["url"]), "HEAD"}, scratch, settings)
		if err != nil {
			return nil, fmt.Errorf("仓库连接失败，请检查地址、SSH Key 或系统凭据：%w", err)
		}
		return map[string]any{"ok": true}, nil
	case "remote:apply":
		project, err := b.aiProject(aiString(aiArg(args, 0)))
		if err != nil {
			return nil, err
		}
		root := aiString(project["dir"])
		remote := aiMap(project["remote"])
		if root == "" || aiString(remote["url"]) == "" {
			return nil, errors.New("请先关联本地目录并保存仓库配置")
		}
		settings, err := ValidateRemote(remote)
		if err != nil {
			return nil, err
		}
		ssh, err := aiSSHCommand(settings)
		if err != nil {
			return nil, err
		}
		git := func(args ...string) (string, error) { return RunRemoteGit(args, root, settings) }
		if _, err = git("rev-parse", "--git-dir"); err != nil {
			return nil, err
		}
		remotes, err := git("remote")
		if err != nil {
			return nil, err
		}
		exists := false
		for _, name := range strings.Fields(remotes) {
			if name == "origin" {
				exists = true
			}
		}
		verb := "add"
		if exists {
			verb = "set-url"
		}
		if _, err = git("remote", verb, "origin", aiString(settings["url"])); err != nil {
			return nil, err
		}
		if aiString(settings["sshKeyPath"]) != "" {
			_, err = git("config", "--local", "core.sshCommand", ssh)
			if err != nil {
				return nil, err
			}
		} else {
			_, _ = git("config", "--local", "--unset-all", "core.sshCommand")
		}
		return map[string]any{"ok": true}, nil
	}
	return nil, errors.New("未知远程通道")
}
