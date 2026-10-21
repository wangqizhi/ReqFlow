//go:build windows

package backendgo

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"

	"encoding/binary"
	"github.com/UserExistsError/conpty"
	"syscall"
	"unicode/utf16"
)

func startAgentPTY(root, agent, prompt string) (agentPTY, error) {
	// An encoded script passes the prompt as data, including quotes/newlines, and
	// invokes npm's .ps1 shim without interpolating any requirement into code.
	// Codex starts with danger-full-access so the assigned session keeps full
	// machine control instead of hitting sandbox permission denials.
	// pi starts with --approve so the project directory is trusted for the run
	// and startup never blocks on the interactive folder-trust prompt.
	invocations := map[string]string{
		"codex": "& codex --no-alt-screen --sandbox danger-full-access $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
		"pi":    "& pi --approve -- $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
	}
	invocation, ok := invocations[agent]
	if !ok {
		return nil, errors.New("不支持的交互 Agent：" + agent)
	}
	program, err := exec.LookPath("powershell.exe")
	if err != nil {
		return nil, err
	}
	file, err := os.CreateTemp("", "reqflow-agent-*.txt")
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
	script := "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encodedPrompt + "')); " + invocation
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
