//go:build !windows

package backendgo

import "errors"

func aiDPAPI(data []byte, protect bool) ([]byte, error) {
	return nil, errors.New("AI 密钥使用 Windows 当前用户 DPAPI 加密，请在原 Windows 用户下打开")
}
