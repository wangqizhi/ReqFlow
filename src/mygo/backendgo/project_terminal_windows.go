//go:build windows

package backendgo

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"os/exec"
	"syscall"
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
	units := utf16.Encode([]rune("& " + command))
	raw := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(raw[i*2:], u)
	}
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
	cmd.Dir = root
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000010}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
