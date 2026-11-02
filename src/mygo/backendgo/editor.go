package backendgo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Launch the editor directly with argv so spaces and shell metacharacters in
// project paths remain part of the folder name. Never invoke a command shell.
func openProjectEditor(dir string) error {
	candidates := []string{}
	if program, err := exec.LookPath("Code.exe"); err == nil {
		candidates = append(candidates, program)
	}
	if launcher, err := exec.LookPath("code"); err == nil {
		// VS Code's PATH entry is normally its bin/code.cmd launcher.
		candidates = append(candidates, filepath.Join(filepath.Dir(launcher), "..", "Code.exe"))
	}
	for _, location := range []struct{ env, relative string }{
		{"LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"},
		{"ProgramFiles", "Microsoft VS Code/Code.exe"},
		{"ProgramFiles(x86)", "Microsoft VS Code/Code.exe"},
	} {
		if root := os.Getenv(location.env); root != "" {
			candidates = append(candidates, filepath.Join(root, filepath.FromSlash(location.relative)))
		}
	}
	for _, program := range candidates {
		if info, err := os.Stat(program); err != nil || !info.Mode().IsRegular() {
			continue
		}
		// Use the installed CLI, including VS Code's versioned update layout.
		cliCandidates := []string{filepath.Join(filepath.Dir(program), "resources", "app", "out", "cli.js")}
		// Follow code.cmd's selected version rather than an older retained update.
		if script, err := os.ReadFile(filepath.Join(filepath.Dir(program), "bin", "code.cmd")); err == nil {
			match := regexp.MustCompile(`(?i)"%~dp0([^"\r\n]*resources[\\/]app[\\/]out[\\/]cli\.js)"`).FindSubmatch(script)
			if len(match) > 1 {
				cliCandidates = append([]string{filepath.Clean(filepath.Join(filepath.Dir(program), "bin", string(match[1])))}, cliCandidates...)
			}
		}
		versioned, _ := filepath.Glob(filepath.Join(filepath.Dir(program), "*", "resources", "app", "out", "cli.js"))
		cliCandidates = append(cliCandidates, versioned...)
		launcher := ""
		for _, candidate := range cliCandidates {
			if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
				launcher = candidate
				break
			}
		}
		if launcher == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		cmd := exec.CommandContext(ctx, program, launcher, "--new-window", dir)
		cmd.Dir = dir
		cmd.Env = append(editorEnvironment(os.Environ()), "ELECTRON_RUN_AS_NODE=1")
		desktopHideCommand(cmd)
		output, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			return fmt.Errorf("VS Code 打开失败：%w %s", err, strings.TrimSpace(string(output)))
		}

		return nil
	}
	return errors.New("未找到 VS Code，请先安装 VS Code，或将其安装目录加入 PATH")
}

// editorEnvironment 去掉从 VS Code 终端等环境继承、会改变 Code.exe 启动方式的变量。
func editorEnvironment(env []string) []string {
	result := make([]string, 0, len(env))
	for _, item := range env {
		name := strings.ToUpper(strings.SplitN(item, "=", 2)[0])
		if name == "ELECTRON_RUN_AS_NODE" || name == "ELECTRON_NO_ATTACH_CONSOLE" || strings.HasPrefix(name, "VSCODE_") {
			continue
		}
		result = append(result, item)
	}
	return result
}
