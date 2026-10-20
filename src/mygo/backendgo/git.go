package backendgo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func desktopCommand(ctx context.Context, program string, args []string, dir string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Dir = dir
	desktopHideCommand(cmd)
	return cmd
}
func desktopRun(ctx context.Context, program string, args []string, dir string, timeout time.Duration) (string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := desktopCommand(ctx, program, args, dir)
	var out, stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	e := cmd.Run()
	if ctx.Err() != nil {
		e = fmt.Errorf("命令超时：%s", program)
	}
	return out.String(), stderr.String(), e
}
func desktopGitError(text string) error {
	lower := strings.ToLower(text)
	if strings.Contains(lower, "tell me who you are") || strings.Contains(lower, "unable to auto-detect") {
		return errors.New("Git 未配置用户名/邮箱，请先执行 git config --global user.name 与 user.email")
	}
	if strings.Contains(lower, "index.lock") || strings.Contains(lower, "another git process") {
		return errors.New("Git 索引被占用，请稍后重试")
	}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
		return errors.New(strings.TrimSpace(lines[len(lines)-1]))
	}
	return errors.New("Git 操作失败")
}
func desktopGitRun(ctx context.Context, args []string, root string) (string, error) {
	out, stderr, e := desktopRun(ctx, "git", args, root, 15*time.Second)
	if e != nil {
		if stderr != "" {
			return out, desktopGitError(stderr)
		}
		return out, e
	}
	return out, nil
}
func desktopPrepareDirectory(value string, create bool) (string, error) {
	if strings.TrimSpace(value) == "" || !filepath.IsAbs(strings.TrimSpace(value)) || strings.ContainsRune(value, 0) {
		return "", errors.New("请填写完整的系统目录绝对路径")
	}
	dir := filepath.Clean(strings.TrimSpace(value))
	info, e := os.Stat(dir)
	if errors.Is(e, os.ErrNotExist) {
		if !create {
			return "", errors.New("目录不存在，请创建目录或开启「不存在时创建」")
		}
		if e = os.MkdirAll(dir, 0755); e != nil {
			return "", e
		}
		info, e = os.Stat(dir)
	}
	if e != nil {
		return "", e
	}
	if !info.IsDir() {
		return "", errors.New("该路径是文件，不是文件夹")
	}
	return filepath.EvalSymlinks(dir)
}
func desktopSamePath(a, b string) bool {
	aa, e := filepath.EvalSymlinks(a)
	if e != nil {
		return false
	}
	bb, e := filepath.EvalSymlinks(b)
	return e == nil && strings.EqualFold(aa, bb)
}
func (b *Backend) desktopRemoteFor(root string) (map[string]any, bool, error) {
	r, e := b.Workspace.Get()
	if e != nil {
		return nil, false, e
	}
	for _, v := range desktopProjects(r) {
		p := desktopMap(v)
		if desktopString(p["dir"]) != "" && desktopSamePath(root, desktopString(p["dir"])) {
			if value, ok := p["remote"]; ok {
				remote, e := ValidateRemote(value)
				return remote, true, e
			}
		}
	}
	return map[string]any{"provider": "github", "url": "", "branch": "main", "sshKeyPath": ""}, false, nil
}
func (b *Backend) desktopCheckout(root string, settings map[string]any, pull bool) (string, error) {
	dir, e := desktopPrepareDirectory(root, false)
	if e != nil {
		return "", e
	}
	key := strings.ToLower(dir)
	b.desktopCheckoutMu.Lock()
	if b.desktopCheckouts[key] {
		b.desktopCheckoutMu.Unlock()
		return "", errors.New("此目录正在拉取，请稍后再试")
	}
	b.desktopCheckouts[key] = true
	b.desktopCheckoutMu.Unlock()
	defer func() { b.desktopCheckoutMu.Lock(); delete(b.desktopCheckouts, key); b.desktopCheckoutMu.Unlock() }()
	git := func(args ...string) (string, error) { return RunRemoteGit(args, dir, settings) }
	entries, e := os.ReadDir(dir)
	if e != nil {
		return "", e
	}
	if !pull && len(entries) == 0 {
		_, e = RunRemoteGit([]string{"clone", "--single-branch", "--branch", desktopString(settings["branch"]), "--", desktopString(settings["url"]), dir}, filepath.Dir(dir), settings)
		return "项目已创建，远程仓库文件已拉取", e
	}
	top, e := git("rev-parse", "--show-toplevel")
	if e != nil {
		return "", errors.New("目录非空且不是独立 Git 仓库，请选择空目录；不会覆盖已有文件")
	}
	if !desktopSamePath(dir, strings.TrimSpace(top)) {
		return "", errors.New("所选目录不是 Git 仓库根目录；不会操作其父目录的仓库")
	}
	changes, e := git("status", "--porcelain=v1", "--untracked-files=all")
	if e != nil {
		return "", e
	}
	if strings.TrimSpace(changes) != "" {
		return "", errors.New("本地有未提交或未跟踪文件，请先提交后再 Pull；不会自动 stash 或覆盖")
	}
	if pull {
		out, e := git("pull", "--ff-only", "--no-rebase")
		if strings.TrimSpace(out) == "" {
			out = "Pull 完成"
		}
		return strings.TrimSpace(out), e
	}
	origin, e := git("config", "--get", "remote.origin.url")
	if e != nil {
		return "", e
	}
	if strings.TrimSpace(origin) != desktopString(settings["url"]) {
		return "", errors.New("现有仓库 origin 与填写地址不一致，请核对后手动拉取；不会改写 origin")
	}
	branch, e := git("symbolic-ref", "--short", "HEAD")
	if e != nil {
		return "", e
	}
	if strings.TrimSpace(branch) != desktopString(settings["branch"]) {
		return "", errors.New("当前分支与项目配置分支不一致，请自行切换后拉取")
	}
	_, e = git("pull", "--ff-only", "--no-rebase", "origin", desktopString(settings["branch"]))
	return "项目已创建，现有仓库已快进拉取", e
}

var desktopBranchPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)

func desktopValidBranch(n string) bool {
	return desktopBranchPattern.MatchString(n) && !strings.Contains(n, "..") && !strings.HasSuffix(n, ".lock") && !strings.HasSuffix(n, "/")
}

var desktopAhead = regexp.MustCompile(`ahead (\d+)`)
var desktopBehind = regexp.MustCompile(`behind (\d+)`)

func desktopParseStatus(out string) map[string]any {
	value := map[string]any{"branch": "", "ahead": 0, "behind": 0, "upstream": false, "changes": []any{}}
	fields := strings.Split(out, "\x00")
	changes := []any{}
	for i := 0; i < len(fields); i++ {
		line := fields[i]
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			head := strings.TrimSpace(line[3:])
			if strings.HasPrefix(head, "No commits yet on ") {
				value["branch"] = strings.TrimPrefix(head, "No commits yet on ")
			} else if strings.HasPrefix(head, "Initial commit on ") {
				value["branch"] = strings.TrimPrefix(head, "Initial commit on ")
			} else {
				branch := strings.SplitN(head, "...", 2)[0]
				branch = strings.SplitN(branch, " ", 2)[0]
				value["branch"] = branch
				value["upstream"] = strings.Contains(head, "...")
			}
			if m := desktopAhead.FindStringSubmatch(head); len(m) > 1 {
				n, _ := strconv.Atoi(m[1])
				value["ahead"] = n
			}
			if m := desktopBehind.FindStringSubmatch(head); len(m) > 1 {
				n, _ := strconv.Atoi(m[1])
				value["behind"] = n
			}
			continue
		}
		if len(line) < 4 {
			continue
		}
		changes = append(changes, map[string]any{"path": line[3:], "index": line[:1], "worktree": line[1:2]})
		if line[0] == 'R' || line[0] == 'C' {
			i++
		}
	}
	value["changes"] = changes
	return value
}

func (b *Backend) desktopGit(ctx context.Context, channel string, args []any) (any, error) {
	root := desktopText(args, 0)
	if channel == "dir:prepare" {
		remote := map[string]any{}
		var e error
		if len(args) > 1 && args[1] != nil {
			remote, e = ValidateRemote(args[1])
			if e != nil {
				return nil, e
			}
		}
		dir, e := desktopPrepareDirectory(root, true)
		if e != nil {
			return nil, e
		}
		r := map[string]any{"dir": dir}
		if desktopString(remote["url"]) != "" {
			summary, e := b.desktopCheckout(dir, remote, false)
			if e != nil {
				r["warning"] = "目录已创建，但拉取失败，请调整仓库地址、分支或认证配置：" + e.Error()
			} else {
				r["summary"] = summary
			}
		}
		return desktopOK(r), nil
	}
	if channel == "git:available" {
		_, e := exec.LookPath("git")
		return desktopOK(map[string]any{"available": e == nil}), nil
	}
	if !filepath.IsAbs(root) {
		return nil, errors.New("请提供本地项目目录的绝对路径")
	}
	info, e := os.Stat(root)
	if e != nil {
		return nil, e
	}
	if !info.IsDir() {
		return nil, errors.New("项目目录不存在")
	}
	git := func(values ...string) (string, error) { return desktopGitRun(ctx, values, root) }
	switch channel {
	case "git:milestones":
		// Read-only history feed for the dashboard milestone view. Limited and
		// newest-first; the UI groups commits into milestones.
		limit := 120
		if n, ok := desktopArg(args, 1).(float64); ok && n >= 10 && n <= 300 {
			limit = int(n)
		}
		inside, e := git("rev-parse", "--is-inside-work-tree")
		if e != nil || strings.TrimSpace(inside) != "true" {
			return desktopOK(map[string]any{"repo": false, "branch": "", "total": 0, "commits": []any{}}), nil
		}
		branch, _ := git("symbolic-ref", "--short", "HEAD")
		total := 0
		if count, e := git("rev-list", "--count", "HEAD"); e == nil {
			total, _ = strconv.Atoi(strings.TrimSpace(count))
		}
		history, e := git("log", "-n", strconv.Itoa(limit), "--format=%H%x00%h%x00%an%x00%aI%x00%D%x00%s%x00%b%x1e")
		if e != nil {
			return nil, e
		}
		commits := []any{}
		for _, record := range strings.Split(history, "\x1e") {
			fields := strings.Split(strings.Trim(record, "\r\n"), "\x00")
			if len(fields) < 7 || fields[0] == "" {
				continue
			}
			refs := []any{}
			for _, ref := range strings.Split(fields[4], ", ") {
				if ref = strings.TrimSpace(ref); ref != "" {
					refs = append(refs, ref)
				}
			}
			commits = append(commits, map[string]any{"hash": fields[0], "short": fields[1], "author": fields[2], "date": fields[3], "refs": refs, "subject": strings.TrimSpace(fields[5]), "body": strings.TrimSpace(fields[6])})
		}
		return desktopOK(map[string]any{"repo": true, "branch": strings.TrimSpace(branch), "total": total, "commits": commits}), nil
	case "git:status":
		inside, e := git("rev-parse", "--is-inside-work-tree")
		if e != nil || strings.TrimSpace(inside) != "true" {
			return desktopOK(map[string]any{"repo": false, "branch": "", "ahead": 0, "behind": 0, "upstream": false, "changes": []any{}, "branches": []any{}, "log": []any{}}), nil
		}
		st, e := git("-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-b", "-u")
		if e != nil {
			return nil, e
		}
		r := desktopParseStatus(st)
		r["repo"] = true
		br, _ := git("for-each-ref", "--format=%(refname:short)", "refs/heads/")
		branches := []any{}
		for _, name := range strings.Split(br, "\n") {
			if name = strings.TrimSpace(name); name != "" {
				branches = append(branches, name)
			}
		}
		r["branches"] = branches
		history, _ := git("log", "-30", "--format=%H%x00%an%x00%aI%x00%B%x00%x00")
		logs := []any{}
		for _, record := range strings.Split(history, "\x00\x00") {
			fields := strings.Split(strings.TrimLeft(record, "\r\n"), "\x00")
			if len(fields) >= 4 && fields[0] != "" {
				logs = append(logs, map[string]any{"hash": fields[0], "author": fields[1], "date": fields[2], "message": strings.TrimSpace(fields[3])})
			}
		}
		r["log"] = logs
		return desktopOK(r), nil
	case "git:init":
		_, e := git("init")
		return desktopOK(nil), e
	case "git:stage":
		mode := desktopText(args, 1)
		if mode != "stage" && mode != "unstage" {
			return nil, errors.New("暂存操作无效")
		}
		paths := []string{}
		for _, v := range desktopList(desktopArg(args, 2)) {
			if s := desktopString(v); s != "" {
				paths = append(paths, s)
			}
		}
		values := []string{"--literal-pathspecs", "add", "-A"}
		if mode == "unstage" {
			values = []string{"--literal-pathspecs", "reset", "-q"}
		}
		if len(paths) > 0 {
			if mode == "stage" {
				values = []string{"--literal-pathspecs", "add", "--"}
			} else {
				values = []string{"--literal-pathspecs", "reset", "-q", "HEAD", "--"}
			}
			values = append(values, paths...)
		}
		_, e := git(values...)
		if e != nil && mode == "unstage" {
			low := strings.ToLower(e.Error())
			if strings.Contains(low, "ambiguous argument") || strings.Contains(low, "unknown revision") || strings.Contains(low, "unexpected") {
				fallback := []string{"--literal-pathspecs", "rm", "--cached", "-q"}
				if len(paths) == 0 {
					fallback = append(fallback, "-r", "--", ".")
				} else {
					fallback = append(append(fallback, "--"), paths...)
				}
				_, e = git(fallback...)
			}
		}
		return desktopOK(nil), e
	case "git:commit":
		message := strings.TrimSpace(desktopText(args, 1))
		if message == "" {
			return nil, errors.New("请填写提交信息")
		}
		project := desktopText(args, 2)
		if project != "" {
			p, e := b.desktopProject(project)
			if e != nil {
				return nil, e
			}
			if !desktopSamePath(root, desktopString(p["dir"])) {
				return nil, errors.New("提交目录与需求项目不匹配，请刷新后重试")
			}
		}
		out, e := git("commit", "-m", message)
		if e != nil {
			return nil, e
		}
		r := map[string]any{"summary": strings.TrimSpace(out)}
		items := desktopList(desktopArg(args, 3))
		if project != "" && len(items) > 0 {
			hash, e := git("rev-parse", "HEAD")
			if e == nil {
				_, e = b.Workspace.Mutate(map[string]any{"op": "gitCommitted", "project": project, "items": items, "hash": strings.TrimSpace(hash)}, nil)
			}
			if e != nil {
				r["warning"] = "Git 已提交，但需求标识保存失败：" + e.Error() + "。请勿重复提交。"
			}
		}
		return desktopOK(r), nil
	case "git:branchCreate", "git:branchSwitch":
		name := desktopText(args, 1)
		if !desktopValidBranch(name) {
			return nil, errors.New("分支名无效")
		}
		values := []string{"checkout", name}
		if channel == "git:branchCreate" {
			values = []string{"checkout", "-b", name}
		}
		_, e := git(values...)
		return desktopOK(nil), e
	case "git:pull":
		remote, _, e := b.desktopRemoteFor(root)
		if e != nil {
			return nil, e
		}
		summary, e := b.desktopCheckout(root, remote, true)
		return desktopOK(map[string]any{"summary": summary}), e
	case "git:push":
		remote, bound, e := b.desktopRemoteFor(root)
		if e != nil {
			return nil, e
		}
		if bound {
			run := func(args ...string) (string, error) { return RunRemoteGit(args, root, remote) }
			if _, e := run("rev-parse", "--git-dir"); e != nil {
				return nil, e
			}
			if _, e := run("rev-parse", "--verify", "HEAD"); e != nil {
				return nil, errors.New("还没有提交，先 Commit 后再 Push")
			}
			remotes, e := run("remote")
			if e != nil {
				return nil, e
			}
			exists := false
			for _, name := range strings.Fields(remotes) {
				if name == "origin" {
					exists = true
				}
			}
			values := []string{"remote", "add", "origin", desktopString(remote["url"])}
			if exists {
				values = []string{"remote", "set-url", "origin", desktopString(remote["url"])}
			}
			if _, e = run(values...); e != nil {
				return nil, e
			}
			out, e := run("push", "-u", "origin", "HEAD")
			if strings.TrimSpace(out) == "" {
				out = "已推送当前分支并关联 origin"
			}
			return desktopOK(map[string]any{"summary": strings.TrimSpace(out)}), e
		}
		out, stderr, e := desktopRun(ctx, "git", []string{"push"}, root, 60*time.Second)
		if e != nil {
			return nil, desktopGitError(stderr)
		}
		if strings.TrimSpace(out) == "" {
			out = "已推送"
		}
		return desktopOK(map[string]any{"summary": strings.TrimSpace(out)}), nil
	}
	return nil, errors.New("未知 Git 操作")
}
