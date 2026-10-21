//go:build !windows

package backendgo

import (
	"errors"
	"os/exec"
)

func containAgentProcess(cmd *exec.Cmd) (func(), error) {
	return nil, errors.New("ZCode 指派目前仅支持 Windows")
}

func startAgentPTY(root, agent, prompt string) (agentPTY, error) {
	return nil, errors.New("交互式 Agent 终端目前仅支持 Windows")
}
