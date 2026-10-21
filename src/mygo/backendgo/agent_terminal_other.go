//go:build !windows

package backendgo

import "errors"

func startAgentPTY(root, agent, prompt string) (agentPTY, error) {
	return nil, errors.New("交互式 Agent 终端目前仅支持 Windows")
}
