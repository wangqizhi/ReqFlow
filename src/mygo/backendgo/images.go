package backendgo

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

// 图片附件外置（性能优化）：上传时的 base64 dataUrl 写入数据目录 images/ 后，
// 工作区只保留 path，不再在需求、批次快照与历史快照里重复内联图片字节。
// 远程同步、备份与导出等需要自包含数据的出口再通过 hydrateImages 回填 dataUrl。

var (
	coreAttachmentIDPattern   = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)
	coreAttachmentFilePattern = regexp.MustCompile(`^[a-zA-Z0-9-]+-[a-f0-9]{16}\.(png|jpeg|webp|gif)$`)
)

func (s *WorkspaceService) imagesDir() string { return filepath.Join(s.store.dir, "images") }

// materializeAttachment 把 dataUrl 写入图片目录并改为 path 引用；已外置的附件只把 path
// 归一到当前数据目录（数据目录迁移后仍可找到文件）。strict 时无效附件报错。
func materializeAttachment(dir string, a map[string]any, strict bool) (bool, error) {
	changed, e := materializeOne(dir, a, strict)
	return changed, e
}
func materializeOne(dir string, a map[string]any, strict bool) (bool, error) {
	data := coreString(a["dataUrl"])
	if data == "" {
		if path := coreString(a["path"]); path != "" {
			if base := filepath.Base(path); coreAttachmentFilePattern.MatchString(base) {
				rebased := filepath.Join(dir, base)
				if _, has := a["dataUrl"]; has {
					delete(a, "dataUrl")
				} else if rebased == path {
					return false, nil
				}
				a["path"] = rebased
				return true, nil
			}
		}
		if strict {
			return false, errors.New("图片附件数据无效")
		}
		return false, nil
	}
	match := coreImagePattern.FindStringSubmatch(data)
	if match == nil || !coreAttachmentIDPattern.MatchString(coreString(a["id"])) {
		if strict {
			return false, errors.New("图片附件数据无效")
		}
		return false, nil
	}
	bytes, e := base64.StdEncoding.DecodeString(match[2])
	if e != nil {
		bytes, e = base64.RawStdEncoding.DecodeString(match[2])
	}
	if e != nil {
		if strict {
			return false, errors.New("图片附件数据无效")
		}
		return false, nil
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return false, e
	}
	file := filepath.Join(dir, coreString(a["id"])+"-"+coreHash(string(bytes))[:16]+"."+match[1])
	if !coreExists(file) {
		if e = coreAtomicWrite(file, bytes); e != nil {
			return false, e
		}
	}
	a["path"] = file
	delete(a, "dataUrl")
	return true, nil
}

// materializeTree 处理任意层级（草稿、历史快照、批次快照）中的 attachments 数组。
func materializeTree(dir string, value any, strict bool) (bool, error) {
	changed := false
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			if key == "attachments" {
				for _, av := range coreList(child) {
					if a, ok := av.(map[string]any); ok {
						c, e := materializeAttachment(dir, a, strict)
						if e != nil {
							return changed, e
						}
						changed = changed || c
					}
				}
				continue
			}
			c, e := materializeTree(dir, child, false)
			if e != nil {
				return changed, e
			}
			changed = changed || c
		}
	case []any:
		for _, child := range v {
			c, e := materializeTree(dir, child, false)
			if e != nil {
				return changed, e
			}
			changed = changed || c
		}
	}
	return changed, nil
}

func (s *WorkspaceService) materializeImages(state map[string]any) error {
	_, e := s.materializeProjects(state)
	return e
}

// materializeProjects 外置图片并返回内容因此变化的项目 id。
func (s *WorkspaceService) materializeProjects(state map[string]any) (map[string]bool, error) {
	dir := s.imagesDir()
	changed := map[string]bool{}
	for _, pv := range coreList(state["projects"]) {
		p := coreMap(pv)
		id := coreString(p["id"])
		// 当前需求与批次需求沿用原有严格校验（无效附件报错）；其他层级只做外置。
		strictItems := coreList(p["items"])
		for _, bv := range coreList(p["batches"]) {
			strictItems = append(append([]any{}, strictItems...), coreList(coreMap(bv)["items"])...)
		}
		for _, iv := range strictItems {
			for _, av := range coreList(coreMap(iv)["attachments"]) {
				c, e := materializeAttachment(dir, coreMap(av), true)
				if e != nil {
					return changed, e
				}
				changed[id] = changed[id] || c
			}
		}
		c, e := materializeTree(dir, p, false)
		if e != nil {
			return changed, e
		}
		changed[id] = changed[id] || c
		if !changed[id] {
			delete(changed, id)
		}
	}
	return changed, nil
}

// readAttachmentDataURL 读取已外置的图片；仅允许数据目录 images/ 下的附件文件。
func readAttachmentDataURL(dir, path string) (string, error) {
	base := filepath.Base(path)
	match := coreAttachmentFilePattern.FindStringSubmatch(base)
	if match == nil {
		return "", errors.New("图片附件路径无效")
	}
	raw, e := os.ReadFile(filepath.Join(dir, base))
	if e != nil {
		return "", errors.New("图片附件文件不存在")
	}
	return "data:image/" + match[1] + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

// hydrateImages 在 value（调用方的副本）中为只有 path 的附件回填 dataUrl，
// 供远程同步、备份与导出等需要自包含图片的出口使用。读取失败的附件保持原样。
func (s *WorkspaceService) hydrateImages(value any) {
	dir := s.imagesDir()
	cache := map[string]string{}
	var walk func(any)
	walk = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				if key == "attachments" {
					for _, av := range coreList(child) {
						a, ok := av.(map[string]any)
						if !ok || coreString(a["dataUrl"]) != "" || coreString(a["path"]) == "" {
							continue
						}
						path := coreString(a["path"])
						data, seen := cache[path]
						if !seen {
							data, _ = readAttachmentDataURL(dir, path)
							cache[path] = data
						}
						if data != "" {
							a["dataUrl"] = data
						}
					}
					continue
				}
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(value)
}

// coreDeepCopy 结构化复制 JSON 值（字符串共享，不经过序列化），远快于 coreClone。
func coreDeepCopy(value any) any {
	switch v := value.(type) {
	case map[string]any:
		r := make(map[string]any, len(v))
		for k, child := range v {
			r[k] = coreDeepCopy(child)
		}
		return r
	case []any:
		r := make([]any, len(v))
		for n, child := range v {
			r[n] = coreDeepCopy(child)
		}
		return r
	}
	return value
}

// projectView 是发送给界面的项目视图：历史快照只保留界面展示所需的标题、正文、
// 验收标准与版本（完整快照仍保存在数据库中），其余字段与存储一致。
func projectView(project map[string]any) map[string]any {
	view := coreMap(coreDeepCopy(project))
	var walk func(any)
	walk = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for key, child := range v {
				if key == "history" {
					for _, hv := range coreList(child) {
						h, ok := hv.(map[string]any)
						if !ok {
							continue
						}
						if snapshot, ok := h["snapshot"].(map[string]any); ok {
							h["snapshot"] = historySnapshotView(snapshot)
						}
					}
					continue
				}
				walk(child)
			}
		case []any:
			for _, child := range v {
				walk(child)
			}
		}
	}
	walk(view)
	return view
}

func historySnapshotView(snapshot map[string]any) map[string]any {
	light := map[string]any{}
	for _, key := range []string{"title", "body", "criteria", "version"} {
		if value, ok := snapshot[key]; ok {
			light[key] = value
		}
	}
	return light
}

// workspaceView 返回界面视图：所有项目按 projectView 精简。
func workspaceView(state map[string]any) map[string]any {
	view := map[string]any{}
	for k, v := range state {
		view[k] = v
	}
	projects := []any{}
	for _, p := range coreList(state["projects"]) {
		projects = append(projects, projectView(coreMap(p)))
	}
	view["projects"] = projects
	return view
}
