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

func refreshContextRules(s map[string]any) {
	for _, pv := range coreList(s["projects"]) {
		p := coreMap(pv)
		sections := []string{}
		for _, cv := range coreList(s["contextPrompts"]) {
			c := coreMap(cv)
			if c["projectId"] == p["id"] && coreString(c["feature"]) != "" {
				sections = append(sections, "## "+coreString(c["feature"])+"\n上下文："+coreString(c["title"])+"（"+coreString(c["id"])+"）\n\n"+coreString(c["body"]))
			}
		}
		delete(p, "contextRules")
		if len(sections) > 0 {
			p["contextRules"] = "# " + coreString(p["name"]) + " · 项目守则\n\n" + strings.Join(sections, "\n\n")
		}
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
func writeContextSnapshot(dir string, state map[string]any) error {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	// These two managed files form a portable, versioned context library.
	if e := desktopAtomicJSON(filepath.Join(dir, "index.json"), coreList(state["contextPrompts"])); e != nil {
		return e
	}
	docs := []string{"# ReqFlow 上下文库（自动生成）"}
	for _, cv := range coreList(state["contextPrompts"]) {
		c := coreMap(cv)
		docs = append(docs, "## "+coreString(c["title"])+"\n\n"+coreString(c["body"]))
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
	if e := contextGit(dir, "add", "--", "index.json", "contexts.md"); e != nil {
		return e
	}
	// Empty commits are avoided; local identity never changes the user's Git config.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "diff", "--cached", "--quiet", "--", "index.json", "contexts.md")
	cmd.Dir = dir
	desktopHideCommand(cmd)
	if e := cmd.Run(); e == nil {
		return nil
	} else if exit, ok := e.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
		return e
	}
	return contextGit(dir, "-c", "user.name=ReqFlow", "-c", "user.email=reqflow@localhost", "-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "Update ReqFlow contexts", "--", "index.json", "contexts.md")
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
