package backendgo

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultContextRulesLimit = 500
	MinContextRulesLimit     = 50
	MaxContextRulesLimit     = 5000
	// Context documents may carry excerpts of the feature's code; keep them
	// bounded so workspace.json and the Git snapshots stay readable.
	MaxContextCodeRunes = 120000
	MaxContextCodeFiles = 60
)

func ProjectContextRulesLimit(p map[string]any) int {
	if coreSafeInt(p["contextRulesLimit"]) {
		limit := int(coreNum(p["contextRulesLimit"]))
		if limit >= MinContextRulesLimit && limit <= MaxContextRulesLimit {
			return limit
		}
	}
	return DefaultContextRulesLimit
}

func truncateContextRunes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit-1]) + "…"
}

func refreshContextRules(s map[string]any) {
	type linkedContext struct {
		feature string
		title   string
		id      string
	}
	for _, pv := range coreList(s["projects"]) {
		p := coreMap(pv)
		linked := []linkedContext{}
		for _, cv := range coreList(s["contextPrompts"]) {
			c := coreMap(cv)
			if c["projectId"] == p["id"] && coreString(c["feature"]) != "" {
				linked = append(linked, linkedContext{
					feature: coreString(c["feature"]),
					title:   coreString(c["title"]),
					id:      coreString(c["id"]),
				})
			}
		}
		delete(p, "contextRules")
		if coreTruthy(p["contextRulesDisabled"]) || len(linked) == 0 {
			continue
		}
		// Prompt only carries document references; content is loaded on demand.
		limit := ProjectContextRulesLimit(p)
		header := "# " + coreString(p["name"]) + " · 项目守则"
		sections := []string{"ReqFlow.exe --cli context list", header}
		for _, c := range linked {
			line := "- " + c.feature + " → " + c.title + "（" + c.id + "）"
			if len([]rune(strings.Join(sections, "\n")+"\n"+line)) <= limit {
				sections = append(sections, line)
			}
		}
		lookup := "按需用 context show --id <ID> 获取 summary.md 与 files/。"
		if len([]rune(strings.Join(sections, "\n")+"\n"+lookup)) <= limit {
			sections = append(sections, lookup)
		}
		p["contextRules"] = truncateContextRunes(strings.Join(sections, "\n"), limit)
	}
}
func (s *WorkspaceService) contextDir() (string, error) {
	value, e := desktopReadJSON(filepath.Join(s.store.dir, "context-settings.json"), nil)
	if e != nil {
		return "", e
	}
	if dir := desktopString(desktopMap(value)["dir"]); dir != "" {
		return dir, nil
	}
	return filepath.Join(s.store.dir, "contexts"), nil
}
func (s *WorkspaceService) contextSettings() (map[string]any, error) {
	dir, e := s.contextDir()
	if e != nil {
		return nil, e
	}
	_, e = exec.LookPath("git")
	return desktopOK(map[string]any{"dir": dir, "git": e == nil}), nil
}
func contextGit(dir string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	desktopHideCommand(cmd)
	output, e := cmd.CombinedOutput()
	if e != nil {
		return errors.New("上下文 Git 管理失败：" + string(output) + ": " + e.Error())
	}
	return nil
}
func contextFiles(c map[string]any) []string {
	files := []string{}
	seen := map[string]bool{}
	for _, v := range coreList(c["files"]) {
		file := strings.TrimSpace(coreString(v))
		if file != "" && !seen[file] {
			files = append(files, file)
			seen[file] = true
		}
	}
	return files
}

// Capture bytes at save time, so unrelated workspace changes never replace a
// saved context with a newer (or deleted) working tree file.
func captureContextFiles(state, c map[string]any) (map[string]any, error) {
	result := map[string]any{}
	files := contextFiles(c)
	if len(files) == 0 {
		return result, nil
	}
	p := coreFind(coreList(state["projects"]), c["projectId"])
	root := coreString(p["dir"])
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("保存相关代码需要关联本地项目目录")
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	total := int64(0)
	for _, name := range files {
		if !safeContextPath(name) {
			return nil, fmt.Errorf("相关文件路径必须位于项目内：%s", name)
		}
		source, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			return nil, fmt.Errorf("读取相关文件 %s：%w", name, err)
		}
		rel, err := filepath.Rel(root, source)
		if err != nil || !safeContextPath(filepath.ToSlash(rel)) {
			return nil, errors.New("相关文件不能通过符号链接指向项目外部")
		}
		info, err := os.Stat(source)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() || info.Size() > 2*1024*1024 {
			return nil, fmt.Errorf("相关文件必须是 2 MB 以内的普通文件：%s", name)
		}
		total += info.Size()
		if total > 8*1024*1024 {
			return nil, errors.New("相关代码文件总大小不能超过 8 MB")
		}
		raw, err := os.ReadFile(source)
		if err != nil {
			return nil, err
		}
		result[name] = base64.StdEncoding.EncodeToString(raw)
	}
	return result, nil
}

func safeContextPath(name string) bool {
	if name == "" || strings.ContainsAny(name, "\\:") || filepath.IsAbs(name) {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") {
			return false
		}
	}
	return true
}

// contextSnapshotName reports whether a file name is one of the per-context
// snapshots written by writeContextSnapshot (a UUID plus .md). Cleanup only
// touches managed snapshots and leaves any other files in code/ alone.
func contextSnapshotName(name string) bool {
	if len(name) != 36 {
		return false
	}
	for i, r := range name {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if r != '-' {
				return false
			}
			continue
		}
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}
func writeContextSnapshot(dir string, state map[string]any) error {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	// Upgrade old path-only contexts before replacing any managed snapshots.
	for _, cv := range coreList(state["contextPrompts"]) {
		c := coreMap(cv)
		if c["codeFiles"] == nil && len(contextFiles(c)) > 0 {
			captured, err := captureContextFiles(state, c)
			if err != nil {
				return err
			}
			c["codeFiles"] = captured
		}
	}
	// Each fragment has a portable folder; index.json retains library metadata.
	if e := desktopAtomicJSON(filepath.Join(dir, "index.json"), coreList(state["contextPrompts"])); e != nil {
		return e
	}
	docs := []string{"# ReqFlow 上下文库（自动生成）"}
	managed := map[string]bool{}
	for _, cv := range coreList(state["contextPrompts"]) {
		c := coreMap(cv)
		id := coreString(c["id"])
		if !contextSnapshotName(id) {
			return errors.New("上下文 ID 格式无效")
		}
		managed[id] = true
		folder := filepath.Join(dir, id)
		if info, err := os.Lstat(folder); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return errors.New("上下文目录不能是符号链接")
		}
		if err := os.MkdirAll(folder, 0700); err != nil {
			return err
		}
		if err := desktopAtomicJSON(filepath.Join(folder, "context.json"), c); err != nil {
			return err
		}
		if err := coreAtomicWrite(filepath.Join(folder, "summary.md"), []byte("# "+coreString(c["title"])+"\n\n"+coreString(c["body"])+"\n")); err != nil {
			return err
		}
		codeDir := filepath.Join(folder, "files")
		// Only the generated files subtree is replaced; user files elsewhere stay.
		if err := os.RemoveAll(codeDir); err != nil {
			return err
		}
		for name, encoded := range coreMap(c["codeFiles"]) {
			if !safeContextPath(name) {
				return errors.New("上下文代码路径无效")
			}
			raw, err := base64.StdEncoding.DecodeString(coreString(encoded))
			if err != nil {
				return err
			}
			dest := filepath.Join(codeDir, filepath.FromSlash(name))
			if err = os.MkdirAll(filepath.Dir(dest), 0700); err != nil {
				return err
			}
			if err = coreAtomicWrite(dest, raw); err != nil {
				return err
			}
		}
		docs = append(docs, "## "+coreString(c["title"])+"\n\n"+coreString(c["body"])+"\n\n目录："+id+"/（summary.md 与 files/ 原始代码文件）")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if contextSnapshotName(entry.Name()) && !managed[entry.Name()] {
			if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
				return err
			}
		}
	}
	// Remove only legacy generated excerpt files after upgrading the layout.
	legacyDir := filepath.Join(dir, "code")
	if entries, err := os.ReadDir(legacyDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md") && contextSnapshotName(strings.TrimSuffix(entry.Name(), ".md")) {
				if err := os.Remove(filepath.Join(legacyDir, entry.Name())); err != nil {
					return err
				}
			}
		}
	}
	if e := coreAtomicWrite(filepath.Join(dir, "contexts.md"), []byte(strings.Join(docs, "\n\n"))); e != nil {
		return e
	}
	if _, e := exec.LookPath("git"); e != nil {
		return nil
	}
	if !coreExists(filepath.Join(dir, ".git")) {
		if e := contextGit(dir, "init"); e != nil {
			return e
		}
	}
	paths := []string{"."}
	if e := contextGit(dir, "add", "-A", "--", "."); e != nil {
		return e
	}
	// Empty commits are avoided; local identity never changes the user's Git config.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"diff", "--cached", "--quiet", "--"}, paths...)...)
	cmd.Dir = dir
	desktopHideCommand(cmd)
	if e := cmd.Run(); e == nil {
		return nil
	} else if exit, ok := e.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
		return e
	}
	return contextGit(dir, append([]string{"-c", "user.name=ReqFlow", "-c", "user.email=reqflow@localhost", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "Update ReqFlow contexts", "--"}, paths...)...)
}
func (s *WorkspaceService) syncContexts(state map[string]any) error {
	dir, e := s.contextDir()
	if e != nil {
		return e
	}
	return writeContextSnapshot(dir, state)
}
func (s *WorkspaceService) moveContexts(target string) (map[string]any, error) {
	target = strings.TrimSpace(target)
	if !filepath.IsAbs(target) {
		return nil, errors.New("上下文目录必须是绝对路径")
	}
	target = filepath.Clean(target)
	return s.store.commit(func() (map[string]any, error) {
		current, e := s.contextDir()
		if e != nil {
			return nil, e
		}
		if !strings.EqualFold(current, target) {
			if rel, err := filepath.Rel(current, target); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
				return nil, errors.New("新上下文目录不能放在原目录内部")
			}
			entries, e := os.ReadDir(target)
			if e != nil && !os.IsNotExist(e) {
				return nil, e
			}
			if len(entries) > 0 {
				return nil, errors.New("请选择空目录，避免覆盖已有文件")
			}
		}
		record, e := s.store.read()
		if e != nil {
			return nil, e
		}
		if !strings.EqualFold(current, target) && coreExists(filepath.Join(current, ".git")) {
			// Carry the library's history to the new directory without touching the source.
			sourceGit := filepath.Join(current, ".git")
			if e = filepath.WalkDir(sourceGit, func(file string, entry fs.DirEntry, walkErr error) error {
				if walkErr != nil {
					return walkErr
				}
				if entry.Type()&os.ModeSymlink != 0 {
					return errors.New("上下文 Git 目录包含符号链接，无法自动迁移")
				}
				rel, err := filepath.Rel(sourceGit, file)
				if err != nil {
					return err
				}
				dest := filepath.Join(target, ".git", rel)
				if entry.IsDir() {
					return os.MkdirAll(dest, 0700)
				}
				raw, err := os.ReadFile(file)
				if err != nil {
					return err
				}
				return coreAtomicWrite(dest, raw)
			}); e != nil {
				return nil, e
			}
		}
		if e = writeContextSnapshot(target, coreMap(record["data"])); e != nil {
			return nil, e
		}
		if e = desktopAtomicJSON(filepath.Join(s.store.dir, "context-settings.json"), map[string]any{"dir": target}); e != nil {
			return nil, e
		}
		return desktopOK(map[string]any{"dir": target, "previousDir": current, "summary": "上下文已迁移；原目录保留为恢复副本"}), nil
	})
}
