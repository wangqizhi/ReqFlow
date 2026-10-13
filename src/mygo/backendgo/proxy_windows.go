package backendgo

import (
	"net/url"
	"strings"
	"syscall"
	"unsafe"
)

func desktopRegValue(name string) (string, uint32) {
	var key syscall.Handle
	e := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, syscall.StringToUTF16Ptr(`Software\Microsoft\Windows\CurrentVersion\Internet Settings`), 0, syscall.KEY_READ, &key)
	if e != nil {
		return "", 0
	}
	defer syscall.RegCloseKey(key)
	var kind, size uint32
	proc := syscall.NewLazyDLL("advapi32.dll").NewProc("RegQueryValueExW")
	r, _, _ := proc.Call(uintptr(key), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(name))), 0, uintptr(unsafe.Pointer(&kind)), 0, uintptr(unsafe.Pointer(&size)))
	if r != 0 || size == 0 {
		return "", 0
	}
	raw := make([]byte, size)
	r, _, _ = proc.Call(uintptr(key), uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr(name))), 0, uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(&raw[0])), uintptr(unsafe.Pointer(&size)))
	if r != 0 {
		return "", 0
	}
	if kind == syscall.REG_DWORD && len(raw) >= 4 {
		return "", uint32(raw[0]) | uint32(raw[1])<<8 | uint32(raw[2])<<16 | uint32(raw[3])<<24
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = uint16(raw[i*2]) | uint16(raw[i*2+1])<<8
	}
	return syscall.UTF16ToString(units), 0
}
func desktopSystemProxy(scheme string) (*url.URL, error) {
	_, enabled := desktopRegValue("ProxyEnable")
	if enabled == 0 {
		return nil, nil
	}
	value, _ := desktopRegValue("ProxyServer")
	if strings.Contains(value, "=") {
		selected := ""
		for _, entry := range strings.Split(value, ";") {
			parts := strings.SplitN(entry, "=", 2)
			if len(parts) == 2 && strings.TrimSpace(parts[0]) == scheme {
				selected = strings.TrimSpace(parts[1])
			}
		}
		value = selected
	}
	if value == "" {
		return nil, nil
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	return url.Parse(value)
}
