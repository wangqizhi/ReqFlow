package backendgo

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
		// REQ-298：以普通窗口启动（后台命令的隐藏窗口参数会让 VS Code 窗口不显示），
		// 并去掉会让 Code.exe 以 Node 方式运行的环境变量。
		cmd := exec.Command(program, "--new-window", dir)
		cmd.Dir = dir
		cmd.Env = editorEnvironment(os.Environ())
		desktopGUICommand(cmd)
		if err := cmd.Start(); err != nil {
			return err
		}
		go func() { _ = cmd.Wait() }()
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
