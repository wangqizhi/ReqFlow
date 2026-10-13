package backendgo

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

func desktopDirectorySize(root string) int64 {
	var size int64
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, e error) error {
		if e != nil {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if !entry.IsDir() {
			if stat, e := entry.Info(); e == nil {
				size += stat.Size()
			}
		}
		return nil
	})
	return size
}
func (b *Backend) desktopUsage() map[string]any {
	file := b.Workspace.DataFile()
	var size int64
	if st, e := os.Stat(file); e == nil {
		size = st.Size()
	}
	return map[string]any{"dataDir": b.DataDir, "backend": b.Workspace.StorageStatus(), "dirSize": desktopDirectorySize(b.DataDir), "databasePath": file, "databaseSize": size}
}
func desktopArchiveTime(item map[string]any) time.Time {
	for _, value := range desktopList(item["history"]) {
		h := desktopMap(value)
		if desktopString(h["event"]) == "归档" {
			parsed, _ := time.Parse(time.RFC3339, desktopString(h["time"]))
			return parsed
		}
	}
	return time.Time{}
}
func desktopArchiveCollect(state map[string]any, cutoff time.Time) ([]any, []any) {
	projects, batches := []any{}, []any{}
	for _, value := range desktopList(state["projects"]) {
		p := desktopMap(value)
		archived := []any{}
		items := desktopList(p["items"])
		for _, iv := range items {
			i := desktopMap(iv)
			if desktopString(i["status"]) == "archived" && desktopArchiveTime(i).Before(cutoff) {
				archived = append(archived, i)
			}
		}
		if len(archived) > 0 {
			projects = append(projects, map[string]any{"id": p["id"], "name": p["name"], "items": archived})
		}
		for _, bv := range desktopList(p["batches"]) {
			batch := desktopMap(bv)
			stamp, e := time.Parse(time.RFC3339, desktopString(batch["time"]))
			if e == nil && !stamp.Before(cutoff) {
				continue
			}
			inFlight := false
			for _, snapshot := range desktopList(batch["items"]) {
				for _, iv := range items {
					i := desktopMap(iv)
					if i["id"] == desktopMap(snapshot)["id"] && desktopString(i["status"]) != "archived" {
						inFlight = true
					}
				}
			}
			if !inFlight {
				batches = append(batches, map[string]any{"projectId": p["id"], "projectName": p["name"], "batch": batch})
			}
		}
	}
	return projects, batches
}
func (b *Backend) desktopArchive(channel string, args []any) (any, error) {
	if channel == "data:usage" {
		return desktopOK(b.desktopUsage()), nil
	}
	date := desktopText(args, 0)
	cutoff, e := time.ParseInLocation("2006-01-02", date, time.Local)
	if e != nil || cutoff.Format("2006-01-02") != date {
		return nil, errors.New("请选择有效的归档日期")
	}
	r, e := b.Workspace.Get()
	if e != nil {
		return nil, e
	}
	state := desktopMap(r["state"])
	projects, batches := desktopArchiveCollect(state, cutoff)
	count := 0
	for _, v := range projects {
		count += len(desktopList(desktopMap(v)["items"]))
	}
	summary := map[string]any{"items": count, "batches": len(batches)}
	if channel == "data:archivePreview" {
		return desktopOK(summary), nil
	}
	if channel != "data:archive" && channel != "data:archiveExport" && channel != "data:archiveClear" {
		return nil, errors.New("未知数据操作")
	}
	if count == 0 && len(batches) == 0 {
		for k, v := range b.desktopUsage() {
			summary[k] = v
		}
		summary["file"] = ""
		return desktopOK(summary), nil
	}
	file := ""
	if channel != "data:archiveClear" {
		value, e := desktopNative(b, "saveDialog", map[string]any{"title": "保存数据归档", "defaultPath": filepath.Join(b.DataDir, fmt.Sprintf("reqflow-archive-%s.json", time.Now().UTC().Format("2006-01-02-15-04-05"))), "filters": []map[string]any{{"name": "JSON", "extensions": []string{"json"}}}})
		if e != nil {
			return nil, e
		}
		picked := desktopMap(value)
		file = desktopString(picked["filePath"])
		if desktopBool(picked["canceled"]) || file == "" {
			summary["canceled"] = true
			return desktopOK(summary), nil
		}
		if !filepath.IsAbs(file) {
			return nil, errors.New("归档文件路径必须为绝对路径")
		}
		payload := map[string]any{"format": "reqflow-archive-v1", "createdAt": desktopNow(), "before": cutoff.UTC().Format(time.RFC3339Nano), "projects": projects, "batches": batches}
		if e = desktopAtomicJSON(file, payload); e != nil {
			return nil, e
		}
	}
	if channel == "data:archiveExport" {
		summary["file"] = file
		return desktopOK(summary), nil
	}
	removed := map[string]bool{}
	for _, v := range batches {
		removed[desktopString(desktopMap(desktopMap(v)["batch"])["id"])] = true
	}
	for _, pv := range desktopList(state["projects"]) {
		p := desktopMap(pv)
		items := []any{}
		changed := false
		for _, iv := range desktopList(p["items"]) {
			i := desktopMap(iv)
			if desktopString(i["status"]) == "archived" && desktopArchiveTime(i).Before(cutoff) {
				changed = true
			} else {
				items = append(items, iv)
			}
		}
		keptBatches := []any{}
		for _, bv := range desktopList(p["batches"]) {
			if removed[desktopString(desktopMap(bv)["id"])] {
				changed = true
			} else {
				keptBatches = append(keptBatches, bv)
			}
		}
		p["items"], p["batches"] = items, keptBatches
		if changed {
			p["revision"] = desktopInt(p["revision"]) + 1
		}
	}
	if _, e = b.Workspace.WriteState(state, desktopInt(r["version"])); e != nil {
		if channel == "data:archiveClear" {
			return nil, fmt.Errorf("工作区清理失败：%w", e)
		}
		return nil, fmt.Errorf("归档已导出，但工作区清理失败（导出文件已保留）：%w", e)
	}
	summary["file"] = file
	for k, v := range b.desktopUsage() {
		summary[k] = v
	}
	return desktopOK(summary), nil
}
