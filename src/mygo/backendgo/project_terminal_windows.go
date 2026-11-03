//go:build windows

package backendgo

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

func openProjectTerminal(root, cli string, full bool) error {
	if cli == "" {
		cli = "codex"
	}
	command := map[string]string{"codex": "codex", "claude-code": "claude", "pi": "pi"}[cli]
	if command == "" {
		return errors.New("不支持的 CLI")
	}
	if full {
		command += map[string]string{"codex": " --dangerously-bypass-approvals-and-sandbox", "claude-code": " --dangerously-skip-permissions", "pi": " --approve"}[cli]
	}
	return launchProjectConsole(root, "try { & "+command+" } catch { Write-Host $_ -ForegroundColor Red }; Write-Host 'CLI 已退出，可在此终端重试。'")
}

// projectShellPath 优先选择已安装的最新 PowerShell（7.x，pwsh.exe），找不到时回退系统自带的
// Windows PowerShell 5.1。先查安装目录中版本最高的正式版，再按用户 PATH 查找（含商店版别名）。
func projectShellPath(env []string) string {
	type shell struct {
		path    string
		major   int
		preview bool
	}
	installed := []shell{}
	for _, name := range []string{"ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"} {
		root := environmentValue(env, name)
		if root == "" {
			continue
		}
		matches, _ := filepath.Glob(filepath.Join(root, "PowerShell", "*", "pwsh.exe"))
		for _, match := range matches {
			version := filepath.Base(filepath.Dir(match))
			major, _ := strconv.Atoi(strings.SplitN(version, "-", 2)[0])
			installed = append(installed, shell{match, major, strings.Contains(strings.ToLower(version), "preview")})
		}
	}
	sort.SliceStable(installed, func(i, j int) bool {
		if installed[i].preview != installed[j].preview {
			return !installed[i].preview
		}
		return installed[i].major > installed[j].major
	})
	if len(installed) > 0 {
		return installed[0].path
	}
	for _, dir := range filepath.SplitList(environmentValue(env, "PATH")) {
		candidate := filepath.Join(strings.Trim(dir, `"`), "pwsh.exe")
		if _, err := os.Lstat(candidate); err == nil {
			return candidate
		}
	}
	return "powershell.exe"
}

func environmentValue(env []string, name string) string {
	for _, item := range env {
		if pair := strings.SplitN(item, "=", 2); len(pair) == 2 && strings.EqualFold(pair[0], name) {
			return pair[1]
		}
	}
	return ""
}

func launchProjectConsole(root, scriptText string) error {
	units := utf16.Encode([]rune(scriptText))
	raw := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(raw[i*2:], u)
	}
	// Launch through Start-Process: a GUI process has null standard handles;
	// passing those handles directly to PowerShell makes its prompt see EOF.
	encoded := base64.StdEncoding.EncodeToString(raw)
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	// 用当前用户的全新环境启动，避免继承 ReqFlow 启动来源（如 Codex）的 NO_COLOR、TERM=dumb，
	// 否则终端中的 Claude Code 等 CLI 会失去颜色。
	env := desktopUserEnvironment()
	script := "$ErrorActionPreference='Stop'; Start-Process -FilePath " + quote(projectShellPath(env)) + " -WorkingDirectory " + quote(root) + " -WindowStyle Normal -ArgumentList '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand " + encoded + "'"
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Env = env
	desktopHideCommand(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("启动系统终端失败：%w：%s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
