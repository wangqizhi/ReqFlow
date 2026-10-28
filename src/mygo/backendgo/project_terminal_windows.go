//go:build windows

package backendgo

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os/exec"
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
	script := "$ErrorActionPreference='Stop'; Start-Process -FilePath 'powershell.exe' -WorkingDirectory " + quote(root) + " -WindowStyle Normal -ArgumentList '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand " + encoded + "'"
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
	desktopHideCommand(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("启动系统终端失败：%w：%s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
