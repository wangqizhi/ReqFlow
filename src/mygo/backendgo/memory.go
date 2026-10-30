package backendgo

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// REQ-294：ReqFlow 全局记忆。跨项目记录最近工作、项目索引及手动维护的技术方案、
// UI 设计要求等，生成 Markdown 文件到数据目录 memory/，开发 Prompt 只引用文件路径，
// 由开发 AI 在实现前读取。总大小受预留上限约束（默认 100 KB）。
const (
	memoryDefaultLimitKB  = 100
	memoryMinLimitKB      = 10
	memoryMaxLimitKB      = 1024
	memoryDefaultRecent   = 30
	memoryMaxRecent       = 200
	memorySettingsFile    = "settings.json"
	memoryIndexFile       = "README.md"
	memoryProjectBodyRune = 200
)

type memorySection struct {
	Key, File, Title, Hint string
	Auto                   bool
}

var memorySections = []memorySection{
	{"recent", "recent-work.md", "最近工作", "跨项目最近完成与执行中的需求，按时间倒序自动生成。", true},
	{"projects", "projects.md", "项目索引", "全部项目的简介、目录位置与需求概况，自动生成。", true},
	{"tech", "tech-solutions.md", "常用技术方案", "常用技术栈、架构选型、依赖库与可复用的实现方案。", false},
	{"ui", "ui-design.md", "UI 设计要求", "配色、字体、间距、组件风格、交互与可访问性要求。", false},
	{"preferences", "preferences.md", "偏好与协作习惯", "沟通语言、汇报格式、提交与测试习惯等个人偏好。", false},
	{"conventions", "conventions.md", "工程约定", "命名、目录结构、代码风格、版本号与发布流程等约定。", false},
	{"lessons", "lessons.md", "经验与踩坑", "曾经出现的问题、根因与避免方式，防止重复犯错。", false},
	{"environment", "environment.md", "环境与常用命令", "开发环境、工具路径、构建、测试与打包命令。", false},
}

var memoryDataDir struct {
	sync.RWMutex
	dir string
}

// SetMemoryDataDir 指定生成 Prompt 时引用的记忆目录所在的数据目录；为空时 Prompt 不附带全局记忆。
func SetMemoryDataDir(dir string) {
	memoryDataDir.Lock()
	memoryDataDir.dir = dir
	memoryDataDir.Unlock()
}

func memoryDir(dataDir string) string { return filepath.Join(dataDir, "memory") }

type memorySettings struct {
	Enabled     bool
	LimitKB     int
	RecentLimit int
	Notes       map[string]string
}

func (m memorySettings) limitBytes() int { return m.LimitKB * 1024 }
func (m memorySettings) toMap() map[string]any {
	notes := map[string]any{}
	for k, v := range m.Notes {
		notes[k] = v
	}
	return map[string]any{"enabled": m.Enabled, "limitKB": m.LimitKB, "recentLimit": m.RecentLimit, "notes": notes}
}

func readMemorySettings(dataDir string) (memorySettings, error) {
	s := memorySettings{Enabled: true, LimitKB: memoryDefaultLimitKB, RecentLimit: memoryDefaultRecent, Notes: map[string]string{}}
	value, e := desktopReadJSON(filepath.Join(memoryDir(dataDir), memorySettingsFile), nil)
	if e != nil {
		return s, e
	}
	m := desktopMap(value)
	if v, ok := m["enabled"].(bool); ok {
		s.Enabled = v
	}
	if coreSafeInt(m["limitKB"]) && int(coreNum(m["limitKB"])) >= memoryMinLimitKB && int(coreNum(m["limitKB"])) <= memoryMaxLimitKB {
		s.LimitKB = int(coreNum(m["limitKB"]))
	}
	if coreSafeInt(m["recentLimit"]) && coreNum(m["recentLimit"]) >= 1 && coreNum(m["recentLimit"]) <= memoryMaxRecent {
		s.RecentLimit = int(coreNum(m["recentLimit"]))
	}
	for _, sec := range memorySections {
		if text, ok := desktopMap(m["notes"])[sec.Key].(string); ok && !sec.Auto {
			s.Notes[sec.Key] = strings.TrimSpace(text)
		}
	}
	return s, nil
}

func validateMemorySettings(value any) (memorySettings, error) {
	m, ok := value.(map[string]any)
	if !ok {
		return memorySettings{}, errors.New("全局记忆设置无效")
	}
	s := memorySettings{Enabled: true, Notes: map[string]string{}}
	if v, ok := m["enabled"].(bool); ok {
		s.Enabled = v
	}
	if !coreSafeInt(m["limitKB"]) || int(coreNum(m["limitKB"])) < memoryMinLimitKB || int(coreNum(m["limitKB"])) > memoryMaxLimitKB {
		return s, fmt.Errorf("预留大小须为 %d–%d KB 的整数", memoryMinLimitKB, memoryMaxLimitKB)
	}
	s.LimitKB = int(coreNum(m["limitKB"]))
	if !coreSafeInt(m["recentLimit"]) || coreNum(m["recentLimit"]) < 1 || coreNum(m["recentLimit"]) > memoryMaxRecent {
		return s, fmt.Errorf("最近工作条数须为 1–%d 的整数", memoryMaxRecent)
	}
	s.RecentLimit = int(coreNum(m["recentLimit"]))
	notes := desktopMap(m["notes"])
	total := 0
	for _, sec := range memorySections {
		if sec.Auto || notes[sec.Key] == nil {
			continue
		}
		text, ok := notes[sec.Key].(string)
		if !ok {
			return s, errors.New(sec.Title + "内容无效")
		}
		s.Notes[sec.Key] = strings.TrimSpace(text)
		total += len(renderMemoryNote(sec, s.Notes[sec.Key]))
	}
	if total > s.limitBytes() {
		return s, fmt.Errorf("手动记忆共 %.1f KB，超过预留的 %d KB，请精简内容或调大预留大小", float64(total)/1024, s.LimitKB)
	}
	return s, nil
}

func renderMemoryNote(sec memorySection, text string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return "# " + sec.Title + "\n\n> " + sec.Hint + "\n\n" + strings.TrimSpace(text) + "\n"
}

func memoryClip(text string, limit int) string {
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit]) + "…"
	}
	return text
}

func memoryItemLabel(p, i map[string]any) string {
	label := coreString(p["name"]) + " · " + coreString(i["number"])
	if t := coreString(i["type"]); t != "" {
		label += " [" + t + "]"
	}
	if title := strings.TrimSpace(coreString(i["title"])); title != "" {
		return label + " " + memoryClip(title, 60)
	}
	return label + " " + memoryClip(coreString(i["body"]), 60)
}

// renderMemoryRecent 生成最近工作，逐条加入直到用尽剩余预算。
func renderMemoryRecent(state map[string]any, s memorySettings, budget int) string {
	type entry struct{ time, line string }
	done, running := []entry{}, []string{}
	for _, pv := range coreList(state["projects"]) {
		p := coreMap(pv)
		for _, iv := range coreList(p["items"]) {
			i := coreMap(iv)
			if i["status"] == "in_progress" && !coreTruthy(i["archived"]) {
				running = append(running, "- "+memoryItemLabel(p, i))
			}
			for _, hv := range coreList(i["history"]) {
				h := coreMap(hv)
				if h["event"] != "实现完成" {
					continue
				}
				line := "- " + memoryClip(coreString(h["time"]), 10) + " · " + memoryItemLabel(p, i)
				if summary := strings.TrimSpace(coreString(h["summary"])); summary != "" {
					line += "\n  完成说明：" + memoryClip(summary, 300)
				}
				done = append(done, entry{coreString(h["time"]), line})
				break // 历史按时间倒序，只取该需求最近一次完成
			}
		}
	}
	sort.SliceStable(done, func(a, b int) bool { return done[a].time > done[b].time })
	sec := memorySections[0]
	text := "# " + sec.Title + "\n\n> " + sec.Hint + "\n"
	add := func(part string) bool {
		if len(text)+len(part) > budget {
			return false
		}
		text += part
		return true
	}
	if len(running) > 0 && add("\n## 执行中\n\n") {
		for _, line := range running {
			if !add(line + "\n") {
				break
			}
		}
	}
	if len(done) > 0 && add("\n## 最近完成\n\n") {
		for n, d := range done {
			if n >= s.RecentLimit || !add(d.line+"\n") {
				break
			}
		}
	}
	if len(running) == 0 && len(done) == 0 {
		add("\n暂无记录。\n")
	}
	if len(text) > budget {
		return ""
	}
	return text
}

func renderMemoryProjects(state map[string]any, budget int) string {
	sec := memorySections[1]
	text := "# " + sec.Title + "\n\n> " + sec.Hint + "\n"
	folders := map[string]string{}
	for _, fv := range coreList(state["folders"]) {
		f := coreMap(fv)
		folders[coreString(f["id"])] = coreString(f["name"])
	}
	for _, pv := range coreList(state["projects"]) {
		p := coreMap(pv)
		counts := map[string]int{}
		latest := ""
		for _, iv := range coreList(p["items"]) {
			i := coreMap(iv)
			status := coreString(i["status"])
			if coreTruthy(i["archived"]) {
				status = "archived"
			}
			counts[status]++
			for _, hv := range coreList(i["history"]) {
				if t := coreString(coreMap(hv)["time"]); t > latest {
					latest = t
				}
				break
			}
		}
		block := "\n## " + coreString(p["name"]) + "\n\n"
		dir := coreString(p["dir"])
		if dir == "" {
			dir = "未绑定"
		}
		block += "- 目录：" + dir + "\n"
		if folder := folders[coreString(p["folder"])]; folder != "" && folder != "default" {
			block += "- 文件夹：" + folder + "\n"
		}
		if desc := strings.TrimSpace(coreString(p["description"])); desc != "" {
			block += "- 简介：" + memoryClip(desc, memoryProjectBodyRune) + "\n"
		}
		block += fmt.Sprintf("- 需求：待办 %d · 执行中 %d · 待验证 %d · 已归档 %d\n", counts["ready"], counts["in_progress"], counts["pending_verification"], counts["archived"])
		if latest != "" {
			block += "- 最近活动：" + memoryClip(latest, 10) + "\n"
		}
		if len(text)+len(block) > budget {
			break
		}
		text += block
	}
	if len(text) > budget {
		return ""
	}
	return text
}

// renderMemoryFiles 按「手动记忆 → 项目索引 → 最近工作」分配预算，返回文件名到内容（空内容表示删除）。
func renderMemoryFiles(state map[string]any, s memorySettings) map[string]string {
	files := map[string]string{}
	budget := s.limitBytes()
	for _, sec := range memorySections {
		if sec.Auto {
			continue
		}
		text := renderMemoryNote(sec, s.Notes[sec.Key])
		if len(text) > budget {
			text = ""
		}
		files[sec.File] = text
		budget -= len(text)
	}
	// 索引文件约 1 KB，先预留，保证总量不超过上限。
	budget -= 1536
	files[memorySections[1].File] = renderMemoryProjects(state, budget)
	budget -= len(files[memorySections[1].File])
	files[memorySections[0].File] = renderMemoryRecent(state, s, budget)
	total := 0
	lines := []string{}
	for _, sec := range memorySections {
		if text := files[sec.File]; text != "" {
			total += len(text)
			lines = append(lines, fmt.Sprintf("- %s：%s（%.1f KB）— %s", sec.File, sec.Title, float64(len(text))/1024, sec.Hint))
		}
	}
	files[memoryIndexFile] = "# ReqFlow 全局记忆\n\n跨项目共享的开发参考，由 ReqFlow 自动维护。与当前项目引导词或需求冲突时，以引导词和需求为准。\n\n" +
		fmt.Sprintf("已用 %.1f KB / 预留 %d KB\n\n", float64(total)/1024, s.LimitKB) + strings.Join(lines, "\n") + "\n"
	return files
}

// refreshMemoryFiles 根据工作区与手动记忆重写 memory/ 下的 Markdown；内容不变的文件不重写。
func refreshMemoryFiles(dataDir string, state map[string]any) error {
	s, e := readMemorySettings(dataDir)
	if e != nil || !s.Enabled || state == nil {
		return e
	}
	dir := memoryDir(dataDir)
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	for name, text := range renderMemoryFiles(state, s) {
		file := filepath.Join(dir, name)
		if text == "" {
			if e = os.Remove(file); e != nil && !errors.Is(e, os.ErrNotExist) {
				return e
			}
			continue
		}
		if old, err := os.ReadFile(file); err == nil && string(old) == text {
			continue
		}
		if e = desktopAtomic(file, []byte(text), 0600); e != nil {
			return e
		}
	}
	return nil
}

// memoryFiles 列出已生成的记忆文件（索引在前）。
func memoryFiles(dataDir string) []map[string]any {
	dir := memoryDir(dataDir)
	files := []map[string]any{}
	add := func(name, title, hint string, auto bool, key string) {
		info, e := os.Stat(filepath.Join(dir, name))
		if e != nil || info.IsDir() {
			return
		}
		files = append(files, map[string]any{"key": key, "file": name, "title": title, "hint": hint, "auto": auto, "path": filepath.Join(dir, name), "size": info.Size()})
	}
	add(memoryIndexFile, "索引", "记忆文件说明与用量。", true, "index")
	for _, sec := range memorySections {
		add(sec.File, sec.Title, sec.Hint, sec.Auto, sec.Key)
	}
	return files
}

// MemoryPromptSection 返回附加到开发 Prompt 末尾的全局记忆引用；未启用或尚无文件时为空。
func MemoryPromptSection(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	s, e := readMemorySettings(dataDir)
	if e != nil || !s.Enabled {
		return ""
	}
	files := memoryFiles(dataDir)
	if len(files) <= 1 {
		return ""
	}
	lines := []string{}
	for _, f := range files {
		lines = append(lines, "- "+coreString(f["title"])+"："+coreString(f["path"]))
	}
	return "## 全局记忆 · 开发前先阅读\n开始实现前先阅读以下 ReqFlow 跨项目全局记忆文件，参考最近工作、项目位置、常用技术方案与 UI 设计要求；与本项目引导词或需求冲突时，以引导词和需求为准。\n" + strings.Join(lines, "\n")
}

func memoryPromptSuffix() string {
	memoryDataDir.RLock()
	dir := memoryDataDir.dir
	memoryDataDir.RUnlock()
	if section := MemoryPromptSection(dir); section != "" {
		return "\n\n" + section
	}
	return ""
}

func (s *WorkspaceService) memoryInfo() (map[string]any, error) {
	dataDir := s.store.dir
	settings, e := readMemorySettings(dataDir)
	if e != nil {
		return nil, e
	}
	if settings.Enabled {
		record, e := s.store.read()
		if e != nil {
			return nil, e
		}
		if record != nil {
			if e = refreshMemoryFiles(dataDir, coreMap(record["data"])); e != nil {
				return nil, e
			}
		}
	}
	sections := []any{}
	for _, sec := range memorySections {
		sections = append(sections, map[string]any{"key": sec.Key, "file": sec.File, "title": sec.Title, "hint": sec.Hint, "auto": sec.Auto})
	}
	files := []any{}
	used := int64(0)
	for _, f := range memoryFiles(dataDir) {
		if settings.Enabled {
			used += f["size"].(int64)
			if raw, e := os.ReadFile(coreString(f["path"])); e == nil {
				f["content"] = string(raw)
			}
			files = append(files, f)
		}
	}
	return desktopOK(map[string]any{"settings": settings.toMap(), "sections": sections, "files": files, "dir": memoryDir(dataDir), "used": used, "limit": settings.limitBytes(), "prompt": MemoryPromptSection(dataDir), "updatedAt": time.Now().UTC().Format(time.RFC3339)}), nil
}

func (s *WorkspaceService) saveMemory(value any) (map[string]any, error) {
	settings, e := validateMemorySettings(value)
	if e != nil {
		return nil, e
	}
	if e = desktopAtomicJSON(filepath.Join(memoryDir(s.store.dir), memorySettingsFile), settings.toMap()); e != nil {
		return nil, e
	}
	return s.memoryInfo()
}
