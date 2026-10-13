package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

const installedDataRoot = `E:\Program Files\reqflow-data`

func decodeConfig(data []byte) string {
	if len(data) >= 2 && ((data[0] == 0xff && data[1] == 0xfe) || (data[0] == 0xfe && data[1] == 0xff)) {
		var order binary.ByteOrder = binary.LittleEndian
		if data[0] == 0xfe {
			order = binary.BigEndian
		}
		units := make([]uint16, 0, (len(data)-2)/2)
		for i := 2; i+1 < len(data); i += 2 {
			units = append(units, order.Uint16(data[i:i+2]))
		}
		return strings.TrimSpace(string(utf16.Decode(units)))
	}
	return strings.TrimSpace(strings.TrimPrefix(string(data), "\ufeff"))
}

func existingDataDir(root string) string {
	for _, candidate := range []string{root, filepath.Join(root, "AppData", "Roaming", "ReqFlow"), filepath.Join(root, "AppData", "Roaming", "reqflow-desktop"), filepath.Join(root, "ReqFlow"), filepath.Join(root, "reqflow-desktop")} {
		for _, name := range []string{"workspace.json", "requirements.sqlite"} {
			if info, err := os.Stat(filepath.Join(candidate, name)); err == nil && !info.IsDir() {
				return candidate
			}
		}
	}
	return ""
}

func resolveDataDir(appDir string) (string, error) {
	if value := strings.TrimSpace(os.Getenv("REQFLOW_DATA_DIR")); value != "" {
		if candidate := existingDataDir(value); candidate != "" {
			return candidate, nil
		}
		// An explicit override also supports a fresh, isolated testing directory.
		return filepath.Abs(value)
	}
	if exe, err := os.Executable(); err == nil && portableExecutable(exe) {
		return filepath.Join(appDir, "data"), nil
	}
	if raw, err := os.ReadFile(filepath.Join(appDir, "data-dir.cfg")); err == nil {
		value := decodeConfig(raw)
		if value != "" {
			if !filepath.IsAbs(value) {
				value = filepath.Join(appDir, value)
			}
			if candidate := existingDataDir(value); candidate != "" {
				return candidate, nil
			}
			return filepath.Abs(value)
		}
	}
	if value := registeredDataDir(); value != "" {
		if candidate := existingDataDir(value); candidate != "" {
			return candidate, nil
		}
		return filepath.Abs(value)
	}
	if candidate := existingDataDir(installedDataRoot); candidate != "" {
		return candidate, nil
	}
	if roaming := os.Getenv("APPDATA"); roaming != "" {
		return filepath.Join(roaming, "ReqFlow"), nil
	}
	return "", fmt.Errorf("无法确定 ReqFlow 数据目录，请设置 REQFLOW_DATA_DIR")
}
