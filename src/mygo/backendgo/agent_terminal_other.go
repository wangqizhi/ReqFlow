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

// startDshChatPTY 的非 Windows 桩：桌面端终端能力仅在 Windows 提供；
// 让 backendgo 可以在 Linux/macOS 交叉编译（独立同步服务端二进制需要）。
func startDshChatPTY(root, prompt, label string) (agentPTY, error) {
	return nil, errors.New("DeepSeek Harness 交互终端目前仅支持 Windows")
}
