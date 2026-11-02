package backendgo

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
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
		cmd := desktopCommand(context.Background(), program, []string{"--new-window", "--", dir}, dir)
		if err := cmd.Start(); err != nil {
			return err
		}
		go func() { _ = cmd.Wait() }()
		return nil
	}
	return errors.New("未找到 VS Code，请先安装 VS Code，或将其安装目录加入 PATH")
}
