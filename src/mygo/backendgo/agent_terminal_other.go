//go:build !windows

package backendgo

import "errors"

func startAgentPTY(root, prompt string) (agentPTY, error) {
	return nil, errors.New("交互式 Codex 实验目前仅支持 Windows")
}
