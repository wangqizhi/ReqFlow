package backendgo

import (
	"context"
	"errors"
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
		body    string
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
					body:    strings.TrimSpace(coreString(c["body"])),
				})
			}
		}
		delete(p, "contextRules")
		if coreTruthy(p["contextRulesDisabled"]) || len(linked) == 0 {
			continue
		}
		// 守则只保留上下文与功能的简短联系，并按项目设置的字数上限截断，避免把完整架构带进排期 Prompt。
		limit := ProjectContextRulesLimit(p)
		header := "# " + coreString(p["name"]) + " · 项目守则"
		overhead := len([]rune(header))
		for _, c := range linked {
			overhead += len([]rune("## " + c.feature + "\n上下文：" + c.title + "（" + c.id + "）\n\n"))
		}
		share := (limit - overhead) / len(linked)
		if share < 0 {
			share = 0
		}
		sections := make([]string, len(linked))
		for n, c := range linked {
			sections[n] = "## " + c.feature + "\n上下文：" + c.title + "（" + c.id + "）\n\n" + truncateContextRunes(c.body, share)
		}
		p["contextRules"] = truncateContextRunes(header+"\n\n"+strings.Join(sections, "\n\n"), limit)
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
	// index.json, contexts.md and the optional code/ excerpts form a portable,
	// versioned context library that Git can track as a whole.
	if e := desktopAtomicJSON(filepath.Join(dir, "index.json"), coreList(state["contextPrompts"])); e != nil {
		return e
	}
	docs := []string{"# ReqFlow 上下文库（自动生成）"}
	codeDir := filepath.Join(dir, "code")
	codeFiles := map[string]bool{}
	for _, cv := range coreList(state["contextPrompts"]) {
		c := coreMap(cv)
		section := "## " + coreString(c["title"]) + "\n\n" + coreString(c["body"])
		if files := contextFiles(c); len(files) > 0 {
			lines := make([]string, len(files))
			for n, file := range files {
				lines[n] = "- `" + file + "`"
			}
			section += "\n\n相关文件：\n\n" + strings.Join(lines, "\n")
		}
		if code := strings.TrimSpace(coreString(c["code"])); code != "" {
			section += "\n\n### 相关代码\n\n" + code
			if id := coreString(c["id"]); id != "" {
				if e := os.MkdirAll(codeDir, 0700); e != nil {
					return e
				}
				if e := coreAtomicWrite(filepath.Join(codeDir, id+".md"), []byte("# "+coreString(c["title"])+"\n\n"+code+"\n")); e != nil {
					return e
				}
				codeFiles[id] = true
			}
		}
		docs = append(docs, section)
	}
	// Drop excerpts for contexts whose code was removed so Git records the deletion.
	if entries, e := os.ReadDir(codeDir); e == nil {
		for _, entry := range entries {
			name := entry.Name()
			base := strings.TrimSuffix(name, ".md")
			if entry.IsDir() || !strings.HasSuffix(name, ".md") || codeFiles[base] || !contextSnapshotName(base) {
				continue
			}
			if e := os.Remove(filepath.Join(codeDir, name)); e != nil && !os.IsNotExist(e) {
				return e
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
	paths := []string{"index.json", "contexts.md"}
	if info, e := os.Stat(codeDir); e == nil && info.IsDir() {
		paths = append(paths, "code")
	}
	if e := contextGit(dir, append([]string{"add", "--"}, paths...)...); e != nil {
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
