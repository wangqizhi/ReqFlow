//go:build windows

package backendgo

import (
	"encoding/base64"
	"os"
	"os/exec"

	"encoding/binary"
	"github.com/UserExistsError/conpty"
	"syscall"
	"unicode/utf16"
)

func startAgentPTY(root, prompt string) (agentPTY, error) {
	// An encoded script passes the prompt as data, including quotes/newlines, and
	// invokes npm's codex.ps1 shim without interpolating any requirement into code.
	program, err := exec.LookPath("powershell.exe")
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp("", "reqflow-codex-*.txt")
	if err != nil {
		return nil, err
	}
	name := file.Name()
	if _, err = file.WriteString(prompt); err != nil {
		file.Close()
		os.Remove(name)
		return nil, err
	}
	file.Close()
	// Keep arbitrarily long requirement text out of the Windows command line.
	encodedPrompt := base64.StdEncoding.EncodeToString([]byte("请读取 UTF-8 任务文件并执行其中的单条需求：" + name))
	script := "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedPrompt + "')); & codex --no-alt-screen $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }"
	units := utf16.Encode([]rune(script))
	raw := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(raw[i*2:], u)
	}
	command := syscall.EscapeArg(program) + " -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand " + base64.StdEncoding.EncodeToString(raw)
	pty, err := conpty.Start(command, conpty.ConPtyWorkDir(root), conpty.ConPtyDimensions(100, 24))
	if err != nil {
		os.Remove(name)
		return nil, err
	}
	return &agentPromptPTY{agentPTY: pty, file: name}, nil
}

type agentPromptPTY struct {
	agentPTY
	file string
}

func (p *agentPromptPTY) Close() error { err := p.agentPTY.Close(); _ = os.Remove(p.file); return err }
