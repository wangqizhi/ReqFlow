package backendgo

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// DPAPI is called directly. No PowerShell process or plaintext key file is used.
type aiDataBlob struct {
	size uint32
	data *byte
}

func aiBlob(data []byte) aiDataBlob {
	if len(data) == 0 {
		return aiDataBlob{}
	}
	return aiDataBlob{uint32(len(data)), &data[0]}
}
func aiDPAPI(data []byte, protect bool) ([]byte, error) {
	input := aiBlob(data)
	var output aiDataBlob
	name := "CryptUnprotectData"
	if protect {
		name = "CryptProtectData"
	}
	ok, _, err := syscall.NewLazyDLL("crypt32.dll").NewProc(name).Call(uintptr(unsafe.Pointer(&input)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&output)))
	runtime.KeepAlive(data)
	if ok == 0 {
		return nil, fmt.Errorf("Windows DPAPI 无法处理当前用户密钥：%w", err)
	}
	defer syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree").Call(uintptr(unsafe.Pointer(output.data)))
	if output.size > 16*1024*1024 {
		return nil, errors.New("Windows DPAPI 密钥数据无效")
	}
	return append([]byte(nil), unsafe.Slice(output.data, int(output.size))...), nil
}
