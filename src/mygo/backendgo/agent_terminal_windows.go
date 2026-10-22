//go:build windows

package backendgo

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"

	"encoding/binary"
	"github.com/UserExistsError/conpty"
	"golang.org/x/sys/windows"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

// Closing this job kills the full descendant tree, including on ReqFlow exit.
func containAgentProcess(cmd *exec.Cmd) (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	err = windows.AssignProcessToJobObject(job, process)
	if err != nil {
		windows.CloseHandle(process)
		windows.CloseHandle(job)
		return nil, err
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { windows.CloseHandle(job) }) }
	// Kill descendants as soon as the parent exits, before exec.Cmd waits for
	// inherited stdout handles held by background children to close.
	go func() {
		windows.WaitForSingleObject(process, windows.INFINITE)
		cleanup()
		windows.CloseHandle(process)
	}()
	return cleanup, nil
}

func startAgentPTY(root, agent, prompt string) (agentPTY, error) {
	// An encoded script passes the prompt as data, including quotes/newlines, and
	// invokes npm's .ps1 shim without interpolating any requirement into code.
	// Codex starts with danger-full-access so the assigned session keeps full
	// machine control instead of hitting sandbox permission denials.
	// pi starts with --approve so the project directory is trusted for the run
	// and startup never blocks on the interactive folder-trust prompt.
	// Claude Code starts with --dangerously-skip-permissions for the same reason.
	// DeepSeek Harness runs the shipped headless profile: one task, log output,
	// then exit; the project directory is the default workspace root.
	invocations := map[string]string{
		"codex":       "& codex --no-alt-screen --sandbox danger-full-access $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
		"pi":          "& pi --approve -- $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
		"claude-code": "& claude --dangerously-skip-permissions $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
		"dsh":         "& dsh --profile headless $p; if ($LASTEXITCODE) { exit $LASTEXITCODE }",
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
