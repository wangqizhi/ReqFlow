//go:build !windows

package backendgo

import "errors"

// macOS Terminal adapter reserved here.
func openProjectTerminal(root, cli string, full bool) error {
	return errors.New("系统 CLI 终端目前仅支持 Windows，macOS 接口已预留")
}
