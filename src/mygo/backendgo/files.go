package backendgo

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DesktopSafePath checks lexical and resolved paths, including Windows junctions.
func DesktopSafePath(root, rel string) (string, error) {
	if strings.TrimSpace(root) == "" || strings.ContainsRune(root, 0) || strings.ContainsRune(rel, 0) {
		return "", errors.New("路径无效")
	}
	abs, e := filepath.Abs(root)
	if e != nil {
		return "", e
	}
	target := filepath.Join(abs, rel)
	if filepath.IsAbs(rel) {
		target = filepath.Clean(rel)
	}
	if !desktopWithin(abs, target) {
		return "", errors.New("路径超出项目目录范围")
	}
	realRoot, e := filepath.EvalSymlinks(abs)
	if e != nil {
		return "", e
	}
	real, e := filepath.EvalSymlinks(target)
	if e != nil {
		return "", e
	}
	if !desktopWithin(realRoot, real) {
		return "", errors.New("路径超出项目目录范围")
	}
	return target, nil
}
func desktopWithin(root, target string) bool {
	rel, e := filepath.Rel(root, target)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

var desktopImageMIME = map[string]string{"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp", "svg": "image/svg+xml", "ico": "image/x-icon", "avif": "image/avif"}

func (b *Backend) desktopFiles(channel string, args []any) (any, error) {
	root, rel := desktopText(args, 0), desktopText(args, 1)
	file, e := DesktopSafePath(root, rel)
	if e != nil {
		return nil, e
	}
	info, e := os.Stat(file)
	if e != nil {
		return nil, e
	}
	switch channel {
	case "fs:list":
		entries, e := os.ReadDir(file)
		if e != nil {
			return nil, e
		}
		values := make([]map[string]any, 0, len(entries))
		for _, entry := range entries {
			size := int64(0)
			if stat, e := entry.Info(); e == nil && !entry.IsDir() {
				size = stat.Size()
			}
			relative, _ := filepath.Rel(root, filepath.Join(file, entry.Name()))
			values = append(values, map[string]any{"name": entry.Name(), "rel": filepath.ToSlash(relative), "dir": entry.IsDir(), "size": size})
		}
		sort.Slice(values, func(i, j int) bool {
			if values[i]["dir"] != values[j]["dir"] {
				return values[i]["dir"].(bool)
			}
			return desktopString(values[i]["name"]) < desktopString(values[j]["name"])
		})
		return desktopOK(map[string]any{"entries": values}), nil
	case "fs:read":
		if !info.Mode().IsRegular() {
			return nil, errors.New("不是可读取的文件")
		}
		if info.Size() > 2*1024*1024 {
			return nil, errors.New("文本查看/编辑上限为 2MB")
		}
		raw, e := os.ReadFile(file)
		if e != nil {
			return nil, e
		}
		sniff := raw
		if len(sniff) > 8192 {
			sniff = sniff[:8192]
		}
		if bytes.Contains(sniff, []byte{0}) {
			return nil, errors.New("二进制文件，不支持在应用内预览")
		}
		return desktopOK(map[string]any{"content": string(raw), "size": len(raw)}), nil
	case "fs:readImage":
		if !info.Mode().IsRegular() {
			return nil, errors.New("不是图片文件")
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(file), "."))
		mime := desktopImageMIME[ext]
		if mime == "" {
			return nil, errors.New("不支持的图片格式：" + ext)
		}
		if info.Size() > 20*1024*1024 {
			return nil, errors.New("图片超过 20MB，不支持预览")
		}
		raw, e := os.ReadFile(file)
		if e != nil {
			return nil, e
		}
		return desktopOK(map[string]any{"mime": mime, "dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), "size": len(raw)}), nil
	case "fs:write":
		content, ok := desktopArg(args, 2).(string)
		if !ok {
			return nil, errors.New("内容无效")
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New("不是可写入的文件")
		}
		e := desktopAtomic(file, []byte(content), info.Mode().Perm())
		return desktopOK(nil), e
	case "fs:reveal":
		_, e := desktopNative(b, "showItemInFolder", file)
		return desktopOK(nil), e
	}
	return nil, errors.New("未知文件操作")
}
