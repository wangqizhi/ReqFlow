package backendgo

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const DefaultDelivery = "说明改动、测试命令和结果、未解决的问题。"

func coreCompletionSummary(a map[string]any) (string, error) {
	if coreHas(a, "summary") {
		text, ok := a["summary"].(string)
		text = strings.TrimSpace(text)
		if !ok || text == "" {
			return "", errors.New("完成说明不能为空")
		}
		if len([]rune(text)) > 50 {
			return "", errors.New("完成说明不能超过50字")
		}
		return text, nil
	}
	note := coreString(a["note"])
	if strings.HasPrefix(note, "[ReqFlow") {
		if end := strings.Index(note, "]\n"); end >= 0 {
			note = note[end+2:]
		}
	}
	runes := []rune(strings.TrimSpace(note))
	if len(runes) > 50 {
		runes = runes[:50]
	}
	return string(runes), nil
}

const DefaultGuidance = "请结合项目背景实现需求，遵循现有技术栈与代码规范。完成后说明改动、运行方式、验证结果与剩余问题。"
const DefaultBaselineTemplate = "完善项目基线配置：\n1. 检查 .gitignore：构建产物、依赖与运行时生成目录（如 node_modules、dist、release、日志等）应已被忽略；\n2. 安装包输出：如项目会生成安装包，指定固定的生成目录，并确认该目录的忽略策略正确；\n3. 运行包：如项目有可独立运行的运行包/绿色版，指定固定的输出或运行目录；\n4. 编译与发布脚本：在固定位置 scripts/ 下提供编译脚本与发布脚本（可直接运行，注明用法与依赖）；\n5. 核对以上配置与当前项目结构一致，缺失或失效的项请补齐或修正。\n完成后说明改动、脚本用法与未解决的问题。"
const legacyPublishTemplate = "配置项目发布与部署脚本：\n1. 检查项目现有部署脚本及发布配置，优先复用用户已有的部署流程；\n2. 如果没有部署脚本，先与用户确认目标位置、部署方式、运行环境、所需凭据与产物、覆盖及回滚策略，再创建可部署到该目标的脚本，不猜测部署细节；\n3. 在 scripts/ 或项目根目录提供 publish 入口（如 publish.mjs、publish.py、publish.bat），点击应用的「发布」按钮时实际调用用户的部署脚本；仅构建或生成安装包不能视为部署完成；\n4. 按项目交付引导构建并生成产物，再部署到用户确认的目标位置；脚本失败时返回非零退出码，成功时打印部署目标与结果；\n5. 注明脚本运行方式、依赖及配置方法，不将凭据写入代码仓库，并验证发布入口能够触发部署流程。\n完成后说明发布入口、实际部署脚本、目标位置、验证结果与未解决的问题。"
const DefaultPublishTemplate = "配置项目发布与部署脚本：\n1. 先检查项目类型、现有发布脚本与更新配置，优先复用已跑通的流程。明确使用以下哪种模式；混合项目分别完成两条链路。\n2. 客户端模式：按交付引导构建安装包或可运行程序，上传到指定服务器或用户确认的分发平台（如 GitHub Releases），提供可访问的版本化下载地址；部署版本元数据、更新清单及校验值，接入客户端检查更新、下载校验和安装或替换能力，验证旧版本能发现并获取新版本。参考 ReqFlow 的构建打包、Release 分发与自动更新流程。\n3. 网页服务模式：构建并上传服务程序、网页资源与运行依赖到指定服务器；先识别目标操作系统及可用守护工具，随产物部署匹配的服务定义、环境配置示例和安装/更新脚本（如 systemd 的 .service 与 systemctl、OpenRC、Supervisor 或 Windows 服务），核对用户、目录、权限、端口、启动命令及开机自启；部署后重载服务配置并重启，验证守护程序已启用、服务运行和 HTTP 健康检查均成功，核对线上版本及静态资源。参考 release-watch 的发布入口、部署脚本、服务定义和远端校验流程。\n4. 从已有配置读取目标地址、目录、部署方式及认证；缺少必要信息时再向用户确认，不猜测服务器或凭据。分发平台与服务器均以用户配置为准，禁止把参考项目的主机、账号或路径写成新项目默认值。\n5. 在 scripts/ 或项目根目录提供 publish 入口（如 publish.mjs、publish.py、publish.ps1），供应用的「发布」按钮实际调用部署脚本；明确区分仅构建、仅打包与完成部署。支持发布前预检、重复发布保护、失败重试及必要的备份/回滚，保护服务器业务数据与现有配置。\n6. 校验上传产物完整性；任一步骤失败返回非零退出码，不打印发布成功，记录具体失败阶段。成功时打印模式、版本、部署目标、下载地址或服务地址及验证结果。凭据仅存环境变量或忽略的本地配置，不写入仓库或日志。\n完成后说明发布入口与用法、部署配置、产物及更新或守护脚本、实际部署和验证结果；没有完成远端部署或校验时明确列出未完成项。"

func coreMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}
func coreList(v any) []any {
	if a, ok := v.([]any); ok && a != nil {
		return a
	}
	if a, ok := v.([]string); ok {
		r := make([]any, len(a))
		for i, v := range a {
			r[i] = v
		}
		return r
	}
	return []any{}
}
func coreString(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case []any:
		a := []string{}
		for _, v := range x {
			a = append(a, coreString(v))
		}
		return strings.Join(a, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return fmt.Sprint(v)
	}
}
func coreNum(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	}
	return 0
}
func coreSafeInt(v any) bool {
	switch x := v.(type) {
	case int, int64:
		return math.Abs(float64(coreNum(x))) <= 9007199254740991
	case float64:
		return !math.IsNaN(x) && !math.IsInf(x, 0) && math.Trunc(x) == x && math.Abs(x) <= 9007199254740991
	case json.Number:
		f, e := x.Float64()
		return e == nil && coreSafeInt(f)
	}
	return false
}
func coreTruthy(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case int, int64:
		return coreNum(v) != 0
	case float64:
		return x != 0 && !math.IsNaN(x)
	case json.Number:
		f, e := x.Float64()
		return e == nil && f != 0 && !math.IsNaN(f)
	}
	return true
}
func coreHas(m map[string]any, k string) bool { _, ok := m[k]; return ok }
func coreJSON(v any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(v)
	text := strings.TrimSuffix(b.String(), "\n")
	var out strings.Builder
	for n := 0; n < len(text); n++ {
		if text[n] == '\\' && n+1 < len(text) {
			if text[n+1] == '\\' {
				out.WriteString(text[n : n+2])
				n++
				continue
			}
			if strings.HasPrefix(text[n:], `\u2028`) {
				out.WriteRune('\u2028')
				n += 5
				continue
			}
			if strings.HasPrefix(text[n:], `\u2029`) {
				out.WriteRune('\u2029')
				n += 5
				continue
			}
		}
		out.WriteByte(text[n])
	}
	return out.String()
}

// JSON.stringify enumerates integer keys before other sorted UTF-16 keys.
// This matches the TypeScript content-token replacer even for unknown fields.
func coreCanonicalJSON(v any) string {
	switch x := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		index := func(k string) (uint64, bool) {
			n, e := strconv.ParseUint(k, 10, 32)
			return n, e == nil && n < 4294967295 && strconv.FormatUint(n, 10) == k
		}
		sort.Slice(keys, func(i, j int) bool {
			a, ai := index(keys[i])
			b, bi := index(keys[j])
			if ai && bi {
				return a < b
			}
			if ai != bi {
				return ai
			}
			ar, br := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
			for n := 0; n < len(ar) && n < len(br); n++ {
				if ar[n] != br[n] {
					return ar[n] < br[n]
				}
			}
			return len(ar) < len(br)
		})
		parts := []string{}
		for _, k := range keys {
			parts = append(parts, coreJSON(k)+":"+coreCanonicalJSON(x[k]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case []any:
		parts := []string{}
		for _, v := range x {
			parts = append(parts, coreCanonicalJSON(v))
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		return coreJSON(v)
	}
}
func coreClone(v any) any { var r any; _ = json.Unmarshal([]byte(coreJSON(v)), &r); return r }
func coreUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func coreNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func coreParseTime(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC1123, time.RFC1123Z, "2006-01-02", "2006-01-02T15:04:05", "2006-01-02 15:04:05"} {
		if t, e := time.Parse(layout, value); e == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("invalid date")
}
func coreHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func coreFind(values []any, id any) map[string]any {
	for _, v := range values {
		m := coreMap(v)
		if m["id"] == id {
			return m
		}
	}
	return nil
}
func coreContains(a []any, v any) bool {
	for _, x := range a {
		if coreString(x) == coreString(v) {
			return true
		}
	}
	return false
}
func coreIn(s string, values ...string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func coreRemove(a []any, id any) []any {
	r := []any{}
	for _, v := range a {
		if coreMap(v)["id"] != id {
			r = append(r, v)
		}
	}
	return r
}
func coreHistory(i map[string]any, h map[string]any) {
	i["history"] = append([]any{h}, coreList(i["history"])...)
}
func coreNeed(v any, label string) (string, error) {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return "", errors.New("请填写" + label)
	}
	return strings.TrimSpace(s), nil
}
func MakeProject(name, description string) map[string]any {
	return map[string]any{"id": coreUUID(), "name": name, "description": description, "guidance": DefaultGuidance, "guideVersion": int64(1), "guideHistory": []any{}, "deliveryGuidance": DefaultDelivery, "aiValidation": false, "items": []any{}, "batches": []any{}, "nextNumber": int64(1)}
}

func ValidateDate(v any) (string, error) {
	if v == "" {
		return "", nil
	}
	s, ok := v.(string)
	if !ok || !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(s) {
		return "", errors.New("需求日期须为 YYYY-MM-DD")
	}
	t, e := time.Parse("2006-01-02", s)
	if e != nil || t.Year() < 1 {
		return "", errors.New("需求日期无效")
	}
	return s, nil
}
func MatchesSchedule(date, mode, selected string) bool {
	if mode == "all" {
		return true
	}
	if mode == "exact" {
		return date == selected
	}
	return date == "" || date <= selected
}
func NormalizeWorkspace(s map[string]any) map[string]any {
	folders := coreList(s["folders"])
	if coreFind(folders, "default") == nil {
		folders = append([]any{map[string]any{"id": "default", "name": "default"}}, folders...)
	}
	s["folders"] = folders
	for _, k := range []string{"baselineTemplate", "publishTemplate"} {
		v, ok := s[k].(string)
		if ok && strings.TrimSpace(v) != "" {
			s[k] = strings.TrimSpace(v)
		} else {
			delete(s, k)
		}
	}
	if s["publishTemplate"] == legacyPublishTemplate {
		s["publishTemplate"] = DefaultPublishTemplate
	}
	for _, pv := range coreList(s["projects"]) {
		p := coreMap(pv)
		if !coreSafeInt(p["revision"]) || coreNum(p["revision"]) < 0 {
			p["revision"] = int64(0)
		}
		if coreFind(folders, p["folderId"]) == nil {
			p["folderId"] = "default"
		}
		if _, ok := p["deliveryGuidance"].(string); !ok {
			p["deliveryGuidance"] = DefaultDelivery
		}
		if _, ok := p["aiValidation"].(bool); !ok {
			p["aiValidation"] = false
		}
		if coreSafeInt(p["contextRulesLimit"]) {
			limit := int(coreNum(p["contextRulesLimit"]))
			if limit >= MinContextRulesLimit && limit <= MaxContextRulesLimit {
				p["contextRulesLimit"] = int64(limit)
			} else {
				delete(p, "contextRulesLimit")
			}
		} else {
			delete(p, "contextRulesLimit")
		}
		for _, k := range []string{"dir", "baselineTemplate"} {
			v, ok := p[k].(string)
			if !ok || strings.TrimSpace(v) == "" {
				delete(p, k)
			} else if k == "baselineTemplate" {
				p[k] = strings.TrimSpace(v)
			}
		}
		if coreTruthy(p["verifySource"]) {
			vs := coreMap(p["verifySource"])
			value, ok := vs["value"].(string)
			if !ok || strings.TrimSpace(value) == "" || !coreIn(coreString(vs["kind"]), "exe", "url") {
				delete(p, "verifySource")
			} else {
				p["verifySource"] = map[string]any{"kind": vs["kind"], "value": strings.TrimSpace(value)}
			}
		}
		for _, iv := range coreList(p["items"]) {
			i := coreMap(iv)
			if !coreHas(i, "executor") {
				i["executor"] = "ai"
			}
			if !coreTruthy(i["flowEvents"]) {
				ev := []any{}
				h := coreList(i["history"])
				stages := map[string]string{"创建": "ready", "标记待提交": "ready", "取消执行": "ready", "退回待执行": "ready", "验证失败": "ready", "回归退回": "ready", "实现完成": "pending_verification", "归档": "archived", "验证通过": "archived"}
				for n := len(h) - 1; n >= 0; n-- {
					hm := coreMap(h[n])
					stage := stages[coreString(hm["event"])]
					if strings.HasPrefix(coreString(hm["event"]), "确认提交") {
						stage = "in_progress"
					}
					_, e := coreParseTime(coreString(hm["time"]))
					if stage != "" && e == nil {
						version := hm["version"]
						if version == nil {
							version = coreMap(hm["snapshot"])["version"]
						}
						if version == nil {
							version = int64(0)
						}
						ev = append(ev, map[string]any{"operation": hm["event"], "stage": stage, "time": hm["time"], "version": version, "source": "history"})
					}
				}
				i["flowEvents"] = ev
			}
			if coreTruthy(i["archived"]) || i["status"] == "verified" {
				i["status"] = "archived"
				i["archived"] = true
			} else if i["status"] == "draft" {
				i["status"] = "ready"
				i["version"] = coreNum(i["version"]) + 1
			}
		}
	}
	refreshContextRules(s)
	return s
}
func coreFailureEntries(i map[string]any) []any {
	r := []any{}
	for _, v := range coreList(i["history"]) {
		h := coreMap(v)
		if h["event"] == "验证通过" {
			break
		}
		if coreIn(coreString(h["event"]), "验证失败", "回归退回") {
			r = append(r, v)
		}
	}
	return r
}
func UnresolvedFailures(i map[string]any) []any {
	h := []any{}
	for _, v := range coreFailureEntries(i) {
		if !coreTruthy(coreMap(v)["resolved"]) {
			h = append(h, v)
		}
	}
	if len(h) == 0 {
		return []any{}
	}
	oldest := []any{}
	noted := []any{}
	for n := len(h) - 1; n >= 0; n-- {
		oldest = append(oldest, h[n])
		if strings.TrimSpace(coreString(coreMap(h[n])["note"])) != "" {
			noted = append(noted, h[n])
		}
	}
	use := noted
	if len(use) == 0 {
		use = oldest[len(oldest)-1:]
	}
	r := []any{}
	for _, v := range use {
		m := coreMap(v)
		note := coreString(m["note"])
		if note == "" {
			note = "验证未通过，请重新检查需求实现。"
		}
		r = append(r, map[string]any{"time": m["time"], "note": note, "current": len(noted) == 0 || coreJSON(m) == coreJSON(h[0])})
	}
	return r
}
func RequirementSettings(p, i map[string]any) map[string]any {
	delivery := i["deliveryGuidance"]
	if delivery == nil {
		delivery = p["deliveryGuidance"]
	}
	if delivery == DefaultDelivery {
		delivery = "说明改动、未解决的问题。"
	}
	return map[string]any{"aiValidation": false, "deliveryGuidance": delivery}
}
func BuildPrompt(p map[string]any, items []any) string {
	sections := []string{}
	type group struct {
		text string
		nums []string
	}
	groups := []group{}
	for n, v := range items {
		i := coreMap(v)
		title := ""
		if coreTruthy(i["title"]) {
			title = " · " + coreString(i["title"])
		}
		section := fmt.Sprintf("### %d. %s%s [%s / %s]\n%s", n+1, coreString(i["number"]), title, coreString(i["type"]), coreString(i["priority"]), coreString(i["body"]))
		attachments := coreList(i["attachments"])
		if len(attachments) > 0 {
			lines := []string{}
			for _, a := range attachments {
				m := coreMap(a)
				location := coreString(m["path"])
				if location == "" {
					location = coreString(m["dataUrl"])
				}
				lines = append(lines, "- "+coreString(m["label"])+" · "+coreString(m["name"])+": "+location)
			}
			section += "\n\n参考图片（在正文中使用图片标识指定）：\n" + strings.Join(lines, "\n")
		}
		failures := UnresolvedFailures(i)
		if len(failures) > 0 {
			lines := []string{}
			for j, f := range failures {
				m := coreMap(f)
				mark := "【此前问题未修复】"
				if coreTruthy(m["current"]) {
					mark = ""
					if len(failures) > 1 {
						mark = "【本轮新问题】"
					}
				}
				lines = append(lines, fmt.Sprintf("- %d. %s%s", j+1, mark, coreString(m["note"])))
			}
			section += "\n\n未通过的问题（本轮需修复）：\n" + strings.Join(lines, "\n")
		}
		if c := coreList(i["criteria"]); len(c) > 0 {
			lines := []string{}
			for _, v := range c {
				lines = append(lines, "- [ ] "+coreString(v))
			}
			section += "\n\n验收条件：\n" + strings.Join(lines, "\n")
		}
		sections = append(sections, section)
		delivery := coreString(RequirementSettings(p, i)["deliveryGuidance"])
		found := false
		for j := range groups {
			if groups[j].text == delivery {
				groups[j].nums = append(groups[j].nums, coreString(i["number"]))
				found = true
				break
			}
		}
		if !found {
			groups = append(groups, group{delivery, []string{coreString(i["number"])}})
		}
	}
	guidance := coreString(p["guidance"])
	if guidance == DefaultGuidance {
		guidance = strings.Replace(guidance, "、验证结果", "", 1)
	}
	tail := []string{}
	for _, g := range groups {
		label := "本轮全部需求"
		if len(groups) > 1 {
			label = strings.Join(g.nums, "、")
		}
		tail = append(tail, "交付引导（"+label+"）：\n"+g.text)
	}
	releaseContext := []string{guidance}
	for _, v := range items {
		i := coreMap(v)
		releaseContext = append(releaseContext, coreString(i["title"]), coreString(i["body"]), coreString(RequirementSettings(p, i)["deliveryGuidance"]))
		for _, criterion := range coreList(i["criteria"]) {
			releaseContext = append(releaseContext, coreString(criterion))
		}
	}
	if regexp.MustCompile(`(?i)发布|安装包|打包|升版|版本(?:说明|更新|交付)|\b(?:release|changelog)\b`).MatchString(strings.Join(releaseContext, "\n")) {
		tail = append(tail, ReleaseNotesGuidance)
	}
	rules := ""
	if text := coreString(p["contextRules"]); text != "" {
		rules = "\n\n## 项目守则（自动生成）\n" + text
	}
	r := "# 项目：" + coreString(p["name"]) + "\n\n## 项目上下文\n" + coreString(p["description"]) + "\n\n## 引导词 · v" + coreString(p["guideVersion"]) + " - 请开发过程中严格执行引导词中的要求。\n" + guidance + rules + "\n\n## 本轮目标\n实现以下需求，按列出的顺序执行。\n\n" + strings.Join(sections, "\n\n")
	if len(tail) > 0 {
		r += "\n\n" + strings.Join(tail, "\n\n")
	}
	return r
}

const ReleaseNotesGuidance = "## 版本交付与发布说明\n" +
	"本轮涉及版本交付或编写发布说明时，必须遵守以下要求：\n" +
	"- 使用本轮确定的交付版本；发布重试沿用该版本，不因重试再次升版。按仓库约定编写发布说明；无约定时使用 docs/release-<版本>.md。\n" +
	"- 发布说明必须包含一级标题「# 项目名 <版本>」，以及独立的二级标题「## 主要更新」；在该章节下用「- 」列表列出本版本实际完成的功能、改进或修复，不能把更新列表直接放在一级标题下。\n" +
	"- 「## 主要更新」只写实际产品变化，不写交付引导、开发指令、测试命令或安装步骤；不得只有安装说明，不得将未完成事项写成已完成，不得保留待填写占位内容。\n" +
	"- 交付前核对发布说明中的版本与交付版本一致，并运行仓库已有的发布说明校验或发布预检；ReqFlow 仓库运行 node scripts/release-notes-check.mjs，并调用 releaseNotes 校验当前版本文件。校验失败先修正，再报告结果。"

func ProjectConcurrencyToken(p map[string]any) string {
	var clean func(any) any
	clean = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			r := map[string]any{}
			for k, v := range x {
				if k != "path" {
					r[k] = clean(v)
				}
			}
			return r
		case []any:
			r := []any{}
			for _, v := range x {
				r = append(r, clean(v))
			}
			return r
		}
		return v
	}
	m := coreMap(clean(p))
	delete(m, "revision")
	return coreHash(coreCanonicalJSON(m))
}
func MutationProjectIDs(a map[string]any) []string {
	if !coreIn(coreString(a["op"]), "deleteProject", "projectFolder", "projectDescription", "projectRemote", "projectDir", "projectSync", "guidance", "verifySource", "publishScript", "baselineTemplate", "assign", "deferItem", "item", "aiItems", "deleteItem", "moveItem", "generate", "submit", "cancel", "ready", "complete", "executionClaim", "executionRelease", "completionNote", "verificationVersion", "revert", "verify", "regress", "archive", "gitCommitted", "requirementDraft") {
		return nil
	}
	id, ok := a["project"].(string)
	if !ok {
		return nil
	}
	r := []string{id}
	if a["op"] == "moveItem" && coreString(a["targetProject"]) != id {
		r = append(r, coreString(a["targetProject"]))
	}
	return r
}
func ScheduledBatch(p, i map[string]any) map[string]any {
	ev := coreList(i["flowEvents"])
	for n := len(ev) - 1; n >= 0; n-- {
		e := coreMap(ev[n])
		if coreIn(coreString(e["operation"]), "generate", "revert", "cancel", "guidance", "verify", "regress") {
			if e["operation"] != "generate" {
				return nil
			}
			break
		}
	}
	for _, bv := range coreList(p["batches"]) {
		b := coreMap(bv)
		old := coreFind(coreList(b["items"]), i["id"])
		if b["mode"] == "develop" && b["status"] != "cancelled" && old != nil {
			if coreNum(b["guideVersion"]) == coreNum(p["guideVersion"]) && coreNum(old["version"]) == coreNum(i["version"]) && coreExecutor(old) == coreExecutor(i) {
				return b
			}
			return nil
		}
	}
	return nil
}
func coreExecutor(i map[string]any) string {
	e := coreString(i["executor"])
	if e == "" {
		e = "ai"
	}
	return e
}
func PendingCommitItems(p map[string]any) []any {
	r := []any{}
	for _, v := range coreList(p["items"]) {
		i := coreMap(v)
		if coreIn(coreString(i["status"]), "pending_verification", "archived") && coreNum(i["gitCommittedVersion"]) < coreNum(i["version"]) {
			r = append(r, v)
		}
	}
	return r
}
func BuildCommitMessage(items []any) string {
	r := []string{}
	for _, v := range items {
		i := coreMap(v)
		prefix := "feat"
		if i["type"] == "bug" {
			prefix = "bugfix"
		} else if i["type"] == "improvement" {
			prefix = "update"
		}
		title := coreString(i["title"])
		if title == "" {
			title = strings.Join(strings.Fields(coreString(i["body"])), " ")
			title = coreCLIPreview(title, 60)
		}
		r = append(r, prefix+": "+coreString(i["number"])+" "+title)
	}
	return strings.Join(r, "\n")
}
func CompareArchivedItems(a, b map[string]any) bool {
	stamp := func(i map[string]any) time.Time {
		h := coreList(i["history"])
		var use map[string]any
		if len(h) > 0 {
			use = coreMap(h[0])
		}
		for _, v := range h {
			if coreMap(v)["event"] == "归档" {
				use = coreMap(v)
				break
			}
		}
		t, _ := coreParseTime(coreString(use["time"]))
		return t
	}
	at, bt := stamp(a), stamp(b)
	if !at.Equal(bt) {
		return bt.Before(at)
	}
	an, bn := coreString(a["number"]), coreString(b["number"])
	ai, ae := strconv.ParseInt(strings.TrimPrefix(an, "REQ-"), 10, 64)
	bi, be := strconv.ParseInt(strings.TrimPrefix(bn, "REQ-"), 10, 64)
	if ae == nil && be == nil && ai != bi {
		return ai > bi
	}
	return an > bn
}

func Apply(s, a map[string]any) error {
	NormalizeWorkspace(s)
	before := map[string]string{}
	revisions := map[string]int64{}
	type prior struct {
		status, time, event string
		events              int
	}
	oldItems := map[string]prior{}
	for _, pv := range coreList(s["projects"]) {
		p := coreMap(pv)
		id := coreString(p["id"])
		before[id] = coreJSON(p)
		revisions[id] = coreNum(p["revision"])
		for _, iv := range coreList(p["items"]) {
			i := coreMap(iv)
			h := coreList(i["history"])
			hm := map[string]any{}
			if len(h) > 0 {
				hm = coreMap(h[0])
			}
			oldItems[coreString(i["id"])] = prior{coreString(i["status"]), coreString(hm["time"]), coreString(hm["event"]), len(coreList(i["flowEvents"]))}
		}
	}
	if err := coreApplyOperation(s, a); err != nil {
		return err
	}
	for _, pv := range coreList(s["projects"]) {
		p := coreMap(pv)
		for _, iv := range coreList(p["items"]) {
			i := coreMap(iv)
			old, exists := oldItems[coreString(i["id"])]
			h := coreList(i["history"])
			hm := map[string]any{}
			if len(h) > 0 {
				hm = coreMap(h[0])
			}
			if len(coreList(i["flowEvents"])) > old.events {
				continue
			}
			if !exists || old.status != coreString(i["status"]) || old.time != coreString(hm["time"]) || old.event != coreString(hm["event"]) {
				t := coreString(hm["time"])
				if t == "" {
					t = coreNow()
				}
				e := map[string]any{"operation": a["op"], "stage": i["status"], "time": t, "version": i["version"]}
				if exists {
					e["from"] = old.status
				}
				i["flowEvents"] = append(coreList(i["flowEvents"]), e)
				// The original edit snapshot shares the live timeline array during this
				// operation; the outer bookkeeping appends the edit event to both views.
				if a["op"] == "item" && hm["event"] == "编辑" {
					snapshot := coreMap(hm["snapshot"])
					snapshot["flowEvents"] = coreClone(i["flowEvents"])
				}
			}
		}
		id := coreString(p["id"])
		if prev, exists := before[id]; !exists || prev != coreJSON(p) {
			p["revision"] = revisions[id] + 1
		}
	}
	return nil
}

var coreExecutorPattern = regexp.MustCompile(`^(ai|human|(?:plugin|agent):[a-zA-Z0-9_.-]+)$`)

func coreApplyOperation(s, a map[string]any) error {
	NormalizeWorkspace(s)
	op := coreString(a["op"])
	projects := coreList(s["projects"])
	folders := coreList(s["folders"])
	switch op {
	case "contextPrompt", "deleteContextPrompt":
		prompts := coreList(s["contextPrompts"])
		old := coreFind(prompts, a["id"])
		if coreString(a["id"]) != "" && old == nil {
			return errors.New("提示词不存在，请刷新后重试")
		}
		if op == "deleteContextPrompt" {
			if old == nil {
				return errors.New("提示词不存在")
			}
			s["contextPrompts"] = coreRemove(prompts, a["id"])
			refreshContextRules(s)
			return nil
		}
		title, e := coreNeed(a["title"], "提示词标题")
		if e != nil {
			return e
		}
		body, e := coreNeed(a["body"], "提示词内容")
		if e != nil {
			return e
		}
		list, ok := a["tags"].([]any)
		if !ok {
			return errors.New("标签格式无效")
		}
		tags, seen := []any{}, map[string]bool{}
		for _, value := range list {
			tag, ok := value.(string)
			if !ok {
				return errors.New("标签格式无效")
			}
			tag = strings.TrimSpace(tag)
			if tag != "" && !seen[tag] {
				tags = append(tags, tag)
				seen[tag] = true
			}
		}
		if old == nil {
			old = map[string]any{"id": coreUUID(), "code": "", "files": []any{}}
			prompts = append(prompts, old)
		}
		if a["projectId"] != nil {
			projectID, feature := coreString(a["projectId"]), strings.TrimSpace(coreString(a["feature"]))
			if projectID != "" && (coreFind(coreList(s["projects"]), projectID) == nil || feature == "") {
				return errors.New("关联项目不存在或功能名称为空")
			}
			old["projectId"], old["feature"] = projectID, feature
		}
		if raw, exists := a["code"]; exists {
			code, ok := raw.(string)
			if !ok {
				return errors.New("相关代码格式无效")
			}
			code = strings.TrimSpace(code)
			if len([]rune(code)) > MaxContextCodeRunes {
				return errors.New("相关代码过多，请只保留关键片段后重试")
			}
			old["code"] = code
		}
		if raw, exists := a["files"]; exists {
			list, ok := raw.([]any)
			if !ok {
				return errors.New("相关文件格式无效")
			}
			files, seen := []any{}, map[string]bool{}
			for _, value := range list {
				file, ok := value.(string)
				if !ok {
					return errors.New("相关文件格式无效")
				}
				file = strings.TrimPrefix(strings.TrimSpace(strings.ReplaceAll(file, "\\", "/")), "./")
				if file == "" || len([]rune(file)) > 300 || seen[file] {
					continue
				}
				if len(files) >= MaxContextCodeFiles {
					break
				}
				files = append(files, file)
				seen[file] = true
			}
			old["files"] = files
			captured, err := captureContextFiles(s, old)
			if err != nil {
				return err
			}
			old["codeFiles"] = captured
		}
		old["title"], old["body"], old["tags"] = title, body, tags
		s["contextPrompts"] = prompts
		refreshContextRules(s)
		return nil
	case "folder":
		name, e := coreNeed(a["name"], "文件夹名称")
		if e != nil {
			return e
		}
		for _, v := range folders {
			if coreMap(v)["name"] == name {
				return errors.New("文件夹名称已存在")
			}
		}
		s["folders"] = append(folders, map[string]any{"id": coreUUID(), "name": name})
		return nil
	case "deleteFolder":
		if a["folderId"] == "default" {
			return errors.New("default 文件夹不可删除")
		}
		f := coreFind(folders, a["folderId"])
		if f == nil {
			return errors.New("文件夹不存在")
		}
		s["folders"] = coreRemove(folders, a["folderId"])
		for _, v := range projects {
			p := coreMap(v)
			if p["folderId"] == a["folderId"] {
				p["folderId"] = "default"
			}
		}
		return nil
	case "project":
		name, e := coreNeed(a["name"], "项目名称")
		if e != nil {
			return e
		}
		p := MakeProject(name, coreString(a["description"]))
		if coreHas(a, "dir") {
			d, ok := a["dir"].(string)
			if !ok {
				return errors.New("项目目录格式无效")
			}
			if strings.TrimSpace(d) != "" {
				p["dir"] = strings.TrimSpace(d)
			}
		}
		if coreHas(a, "remote") {
			remote, e := ValidateRemote(a["remote"])
			if e != nil {
				return e
			}
			p["remote"] = remote
		}
		if coreHas(a, "newFolderName") {
			name, e := coreNeed(a["newFolderName"], "文件夹名称")
			if e != nil {
				return e
			}
			for _, v := range folders {
				if coreMap(v)["name"] == name {
					return errors.New("文件夹名称已存在")
				}
			}
			f := map[string]any{"id": coreUUID(), "name": name}
			p["folderId"] = f["id"]
			s["folders"] = append(folders, f)
		} else if coreHas(a, "folderId") {
			if coreFind(folders, a["folderId"]) == nil {
				return errors.New("文件夹不存在")
			}
			p["folderId"] = a["folderId"]
		}
		s["projects"] = append(projects, p)
		return nil
	case "globalBaselineTemplate", "globalPublishTemplate":
		k := "baselineTemplate"
		if op == "globalPublishTemplate" {
			k = "publishTemplate"
		}
		t := strings.TrimSpace(coreString(a["text"]))
		if t == "" {
			delete(s, k)
		} else {
			s[k] = t
		}
		return nil
	}
	p := coreFind(projects, a["project"])
	if p == nil {
		return errors.New("项目不存在")
	}
	if e := guardAIExecution(p, a); e != nil {
		return e
	}
	now := coreNow()
	items := coreList(p["items"])
	batches := coreList(p["batches"])
	switch op {
	case "requirementDraft":
		draft, ok := a["draft"].(map[string]any)
		if !ok {
			return errors.New("草稿格式无效")
		}
		p["requirementDraft"] = coreClone(draft)
		return nil
	case "projectVisibility":
		hidden, ok := a["hidden"].(bool)
		if !ok {
			return errors.New("项目隐藏状态无效")
		}
		p["hidden"] = hidden
		return nil
	case "projectReorder":
		// REQ-167：远程项目并入各文件夹后，排序分组只看文件夹，不再按本地/远程拆分
		peers := []any{}
		for _, v := range projects {
			pr := coreMap(v)
			if pr["folderId"] == p["folderId"] {
				peers = append(peers, v)
			}
		}
		position := coreString(a["position"])
		var target map[string]any
		if position == "top" && len(peers) > 0 {
			target = coreMap(peers[0])
		} else {
			target = coreFind(peers, a["target"])
		}
		if !coreIn(position, "top", "before", "after") || target == nil {
			return errors.New("排序目标无效")
		}
		if target["id"] == p["id"] {
			return nil
		}
		ordered := coreRemove(peers, p["id"])
		for n, v := range ordered {
			if coreMap(v)["id"] == target["id"] {
				if position == "after" {
					n++
				}
				ordered = append(ordered, nil)
				copy(ordered[n+1:], ordered[n:])
				ordered[n] = p
				break
			}
		}
		n := 0
		for i, v := range projects {
			if coreFind(peers, coreMap(v)["id"]) != nil {
				projects[i] = ordered[n]
				n++
			}
		}
		s["projects"] = projects
		return nil
	case "projectMove":
		if !coreIn(coreString(a["direction"]), "up", "down") {
			return errors.New("排序方向无效")
		}
		peers := []int{}
		current := -1
		for n, v := range projects {
			pr := coreMap(v)
			if pr["folderId"] == p["folderId"] {
				if pr["id"] == p["id"] {
					current = len(peers)
				}
				peers = append(peers, n)
			}
		}
		next := current + 1
		if a["direction"] == "up" {
			next = current - 1
		}
		if current >= 0 && next >= 0 && next < len(peers) {
			from, to := peers[current], peers[next]
			projects[from], projects[to] = projects[to], projects[from]
			s["projects"] = projects
		}
		return nil
	case "projectFolder":
		if coreFind(folders, a["folderId"]) == nil {
			return errors.New("文件夹不存在")
		}
		p["folderId"] = a["folderId"]
		return nil
	case "aiItems":
		list, ok := a["items"].([]any)
		if !ok || len(list) == 0 || len(list) > 20 {
			return errors.New("需求列表无效")
		}
		for _, v := range list {
			action := coreMap(coreClone(v))
			delete(action, "id")
			action["attachments"] = []any{}
			action["op"] = "item"
			action["project"] = p["id"]
			if e := Apply(s, action); e != nil {
				return e
			}
		}
		return nil
	case "deleteProject":
		if len(projects) <= 1 {
			return errors.New("至少保留一个项目，最后一个项目不可删除")
		}
		s["projects"] = coreRemove(projects, p["id"])
		return nil
	case "projectDescription":
		p["description"] = coreString(a["description"])
		p["guideVersion"] = coreNum(p["guideVersion"]) + 1
		return nil
	case "projectRemote":
		remote, e := ValidateRemote(a["remote"])
		if e != nil {
			return e
		}
		p["remote"] = remote
		return nil
	case "projectSync":
		// REQ-240：项目关联 / 解除关联 Server Agent；解除后继续使用本地数据。
		server := coreMap(a["server"])
		id := strings.TrimSpace(coreString(server["id"]))
		if a["server"] == nil || a["server"] == "" {
			delete(p, "serverAgent")
			return nil
		}
		if id == "" {
			id = strings.TrimSpace(coreString(a["server"]))
		}
		if id == "" {
			return errors.New("请选择要关联的 Server Agent")
		}
		p["serverAgent"] = map[string]any{"id": id}
		return nil
	case "projectDir":
		if coreHas(a, "dir") {
			d := strings.TrimSpace(coreString(a["dir"]))
			if d == "" {
				delete(p, "dir")
			} else {
				p["dir"] = d
			}
		}
		return nil
	case "guidance":
		text, e := coreNeed(a["text"], "项目引导词")
		if e != nil {
			return e
		}
		delivery := coreString(p["deliveryGuidance"])
		if coreHas(a, "deliveryGuidance") {
			delivery, e = coreNeed(a["deliveryGuidance"], "交付引导")
			if e != nil {
				return e
			}
		}
		limit := ProjectContextRulesLimit(p)
		if coreHas(a, "contextRulesLimit") {
			if !coreSafeInt(a["contextRulesLimit"]) {
				return errors.New("守则字数上限必须是整数")
			}
			limit = int(coreNum(a["contextRulesLimit"]))
			if limit < MinContextRulesLimit || limit > MaxContextRulesLimit {
				return errors.New("守则字数上限需在 50 到 5000 字之间")
			}
		}
		if disabled, ok := a["contextRulesDisabled"].(bool); ok {
			p["contextRulesDisabled"] = disabled
			refreshContextRules(s)
		}
		guideChanged := text != p["guidance"] || delivery != p["deliveryGuidance"]
		limitChanged := limit != ProjectContextRulesLimit(p)
		if !guideChanged && !limitChanged {
			return nil
		}
		if limitChanged {
			p["contextRulesLimit"] = int64(limit)
			refreshContextRules(s)
		}
		if !guideChanged {
			return nil
		}
		p["guideHistory"] = append([]any{map[string]any{"version": p["guideVersion"], "text": p["guidance"], "deliveryGuidance": p["deliveryGuidance"], "aiValidation": p["aiValidation"], "time": now}}, coreList(p["guideHistory"])...)
		p["guidance"] = text
		scheduled := map[string]bool{}
		for _, v := range items {
			i := coreMap(v)
			if coreIn(coreString(i["status"]), "ready", "in_progress") && (i["deliveryGuidance"] == nil || i["deliveryGuidance"] == p["deliveryGuidance"] || (!coreTruthy(p["aiValidation"]) && p["deliveryGuidance"] == DefaultDelivery && i["deliveryGuidance"] == "说明改动、未解决的问题。")) {
				if delivery != p["deliveryGuidance"] {
					i["deliveryGuidance"] = delivery
					i["version"] = coreNum(i["version"]) + 1
				}
			}
			if !coreTruthy(i["archived"]) && i["status"] == "in_progress" {
				scheduled[coreString(i["id"])] = true
				i["status"] = "ready"
				i["version"] = coreNum(i["version"]) + 1
				coreHistory(i, map[string]any{"event": "引导词变化，退回需求池", "time": now})
			}
		}
		p["deliveryGuidance"] = delivery
		p["guideVersion"] = coreNum(p["guideVersion"]) + 1
		for _, v := range batches {
			b := coreMap(v)
			for _, iv := range coreList(b["items"]) {
				if b["status"] != "cancelled" && scheduled[coreString(coreMap(iv)["id"])] {
					b["status"] = "cancelled"
					break
				}
			}
		}
		return nil
	case "publishScript":
		if a["script"] == nil {
			delete(p, "publishScript")
		} else {
			script := strings.ReplaceAll(strings.TrimSpace(coreString(a["script"])), "\\", "/")
			if script != "" && (strings.HasPrefix(script, "/") || regexp.MustCompile(`(?i)^[a-z]:`).MatchString(script) || coreIn("..", strings.Split(script, "/")...) || !regexp.MustCompile(`(?i)\.(mjs|js|cjs|bat|cmd|ps1|sh|py)$`).MatchString(script)) {
				return errors.New("发布脚本须为项目内的相对路径及支持的脚本类型")
			}
			p["publishScript"] = script
		}
		return nil
	case "verifySource":
		if a["source"] == nil || a["source"] == "" {
			delete(p, "verifySource")
			return nil
		}
		vs := coreMap(a["source"])
		value := strings.TrimSpace(coreString(vs["value"]))
		if !coreIn(coreString(vs["kind"]), "exe", "url") || value == "" {
			return errors.New("验证源配置无效：请选择类型并填写程序路径或网页地址")
		}
		p["verifySource"] = map[string]any{"kind": vs["kind"], "value": value}
		return nil
	case "baselineTemplate":
		text := strings.TrimSpace(coreString(a["text"]))
		if text == "" {
			delete(p, "baselineTemplate")
		} else {
			p["baselineTemplate"] = text
		}
		return nil
	case "gitCommitted":
		for _, v := range coreList(a["items"]) {
			snap := coreMap(v)
			i := coreFind(items, snap["id"])
			version := coreNum(snap["version"])
			if i != nil && coreSafeInt(snap["version"]) && version > 0 && version <= coreNum(i["version"]) {
				if version > coreNum(i["gitCommittedVersion"]) {
					i["gitCommittedVersion"] = version
				}
				i["gitCommitHash"] = coreString(a["hash"])
			}
		}
		return nil
	case "assign":
		executor, ok := a["executor"].(string)
		if !ok || !coreExecutorPattern.MatchString(executor) {
			return errors.New("执行方式无效")
		}
		ids, ok := a["ids"].([]any)
		if !ok {
			return errors.New("可指派需求已变化")
		}
		unique := map[string]bool{}
		for _, v := range ids {
			id, ok := v.(string)
			if !ok {
				return errors.New("可指派需求已变化")
			}
			unique[id] = true
		}
		selected := []any{}
		for _, v := range items {
			i := coreMap(v)
			if unique[coreString(i["id"])] {
				selected = append(selected, v)
				if coreTruthy(i["archived"]) || !coreIn(coreString(i["status"]), "ready", "in_progress", "pending_verification") {
					return errors.New("可指派需求已变化")
				}
			}
		}
		if len(selected) == 0 || len(selected) != len(unique) {
			return errors.New("可指派需求已变化")
		}
		for _, v := range selected {
			i := coreMap(v)
			if coreExecutor(i) == executor {
				continue
			}
			i["executor"] = executor
			for _, bv := range batches {
				b := coreMap(bv)
				if b["mode"] == "develop" && b["status"] != "cancelled" {
					old := coreFind(coreList(b["items"]), i["id"])
					if old != nil && coreNum(old["version"]) == coreNum(i["version"]) {
						old["executor"] = executor
						b["hash"] = coreHash(coreJSON(b["items"]) + coreString(b["text"]))
					}
				}
			}
		}
		return nil
	case "executionClaim":
		return claimAIExecution(p, a, now)
	case "executionRelease":
		i := coreFind(items, a["id"])
		if i == nil || ActiveAIExecution(i) == nil {
			return errors.New("需求没有正在执行的 AI 任务")
		}
		if coreString(a["run"]) != "" && ActiveAIExecution(i)["runId"] != a["run"] {
			return errors.New("AI 任务属于另一运行记录")
		}
		finishAIExecution(i, now, "released")
		coreHistory(i, map[string]any{"event": "释放 AI 任务", "time": now, "note": coreString(a["note"]), "execution": coreClone(i["aiExecution"])})
		return nil
	case "deferItem":
		i := coreFind(items, a["id"])
		if i == nil || coreTruthy(i["archived"]) || i["status"] != "ready" || ActiveAIExecution(i) != nil || ScheduledBatch(p, i) != nil {
			return errors.New("只能标记需求池中的需求")
		}
		deferred, ok := a["deferred"].(bool)
		if !ok {
			return errors.New("延迟标记无效")
		}
		if coreTruthy(i["deferred"]) != deferred {
			i["deferred"] = deferred
			event := "取消延迟"
			if deferred {
				event = "延迟需求"
			}
			coreHistory(i, map[string]any{"event": event, "time": now})
		}
		return nil
	case "item":
		return coreApplyItem(p, a, now)
	case "generate":
		if coreTruthy(a["mode"]) && a["mode"] != "develop" {
			return errors.New("已取消协助验证模式，请从待执行需求生成 Prompt")
		}
		selected := []any{}
		for _, id := range coreList(a["ids"]) {
			i := coreFind(items, id)
			if i == nil || coreTruthy(i["archived"]) || !coreIn(coreString(i["status"]), "ready", "in_progress") {
				return errors.New("请选择待执行或执行中的需求")
			}
			selected = append(selected, i)
		}
		if len(selected) == 0 {
			return errors.New("请选择待执行或执行中的需求")
		}
		snapshots := []any{}
		for _, v := range selected {
			i := coreMap(v)
			i["flowEvents"] = append(coreList(i["flowEvents"]), map[string]any{"operation": "generate", "stage": i["status"], "time": now, "version": i["version"]})
			snapshot := coreMap(coreClone(i))
			for k, v := range RequirementSettings(p, i) {
				snapshot[k] = v
			}
			snapshots = append(snapshots, snapshot)
		}
		text := BuildPrompt(p, snapshots)
		p["batches"] = append([]any{map[string]any{"id": coreUUID(), "number": int64(len(batches) + 1), "mode": "develop", "status": "draft", "text": text, "hash": coreHash(text), "guideVersion": p["guideVersion"], "templateVersion": int64(5), "items": snapshots, "time": now}}, batches...)
		return nil
	case "submit", "cancel":
		b := coreFind(batches, a["batch"])
		if b == nil {
			return errors.New("批次不存在")
		}
		if op == "submit" {
			if b["status"] != "draft" || b["mode"] != "develop" {
				return errors.New("该批次不能提交")
			}
			if coreNum(b["guideVersion"]) != coreNum(p["guideVersion"]) {
				return errors.New("源内容或状态已变化，请重新生成批次")
			}
			for _, v := range coreList(b["items"]) {
				old := coreMap(v)
				i := coreFind(items, old["id"])
				if i == nil || coreNum(i["version"]) != coreNum(old["version"]) || !coreIn(coreString(i["status"]), "ready", "in_progress") || coreTruthy(i["archived"]) {
					return errors.New("源内容或状态已变化，请重新生成批次")
				}
			}
			b["status"] = "submitted"
			b["submittedAt"] = now
			for _, v := range coreList(b["items"]) {
				old := coreMap(v)
				i := coreFind(items, old["id"])
				i["status"] = "in_progress"
				i["executionVersion"] = old["version"]
				coreHistory(i, map[string]any{"event": "确认提交 · 批次 " + coreString(b["number"]), "time": now})
			}
		} else {
			if b["status"] != "submitted" {
				return errors.New("只能取消已提交批次")
			}
			b["status"] = "cancelled"
			for _, v := range coreList(b["items"]) {
				old := coreMap(v)
				i := coreFind(items, old["id"])
				running := false
				for _, ov := range batches {
					o := coreMap(ov)
					if o["id"] != b["id"] && o["status"] == "submitted" && coreFind(coreList(o["items"]), old["id"]) != nil {
						running = true
					}
				}
				if i != nil && i["status"] == "in_progress" && !running {
					i["status"] = "ready"
					coreHistory(i, map[string]any{"event": "取消执行", "time": now})
				}
			}
		}
		return nil
	}
	i := coreFind(items, a["id"])
	if i == nil {
		return errors.New("需求不存在")
	}
	switch op {
	case "moveItem", "deleteItem":
		if i["status"] != "ready" || coreTruthy(i["archived"]) {
			return errors.New("只有待执行需求可迁移或删除")
		}
		if op == "deleteItem" {
			p["items"] = coreRemove(items, i["id"])
			return nil
		}
		target := coreFind(projects, a["targetProject"])
		if target == nil {
			return errors.New("目标项目不存在")
		}
		if target["id"] == p["id"] {
			return errors.New("请选择其他项目")
		}
		if coreFind(coreList(target["items"]), i["id"]) != nil {
			return errors.New("目标项目已有相同需求")
		}
		oldNumber := coreString(i["number"])
		for k, v := range RequirementSettings(p, i) {
			i[k] = v
		}
		i["number"] = fmt.Sprintf("REQ-%03d", coreNum(target["nextNumber"]))
		target["nextNumber"] = coreNum(target["nextNumber"]) + 1
		i["version"] = coreNum(i["version"]) + 1
		delete(i, "executionVersion")
		coreHistory(i, map[string]any{"event": "迁移项目", "time": now, "note": coreString(p["name"]) + " · " + oldNumber + " → " + coreString(target["name"]) + " · " + coreString(i["number"]), "sourceProject": p["id"], "targetProject": target["id"]})
		p["items"] = coreRemove(items, i["id"])
		target["items"] = append(coreList(target["items"]), i)
		return nil
	case "ready":
		if i["status"] != "draft" {
			return errors.New("只有草稿可标记待提交")
		}
		i["status"] = "ready"
		i["version"] = coreNum(i["version"]) + 1
		coreHistory(i, map[string]any{"event": "标记待提交", "time": now})
		return nil
	case "complete":
		summary, e := coreCompletionSummary(a)
		if e != nil {
			return e
		}
		if coreTruthy(a["batch"]) {
			batch := ScheduledBatch(p, i)
			if batch == nil || batch["id"] != a["batch"] || coreExecutor(i) != "ai" || !coreIn(coreString(i["status"]), "ready", "in_progress") || coreTruthy(i["archived"]) || !coreSafeInt(a["version"]) || coreNum(a["version"]) != coreNum(i["version"]) {
				return errors.New("AI 排期任务或版本已变化")
			}
			i["executionVersion"] = i["version"]
		} else if i["status"] != "in_progress" {
			if i["status"] != "ready" || coreTruthy(i["archived"]) || ScheduledBatch(p, i) == nil {
				return errors.New("需求不在执行中或有效排期中")
			}
			i["executionVersion"] = i["version"]
		}
		finishAIExecution(i, now, "completed")
		i["status"] = "pending_verification"
		delete(i, "verificationVersion")
		// REQ-242：完成时记录包含该实现的版本，告诉验证人员从哪个版本起可以验证。
		if v := strings.TrimSpace(coreString(a["verificationVersion"])); v != "" && len([]rune(v)) <= 100 && !strings.ContainsAny(v, "\r\n") {
			i["verificationVersion"] = v
		}
		i["link"] = coreString(a["link"])
		history := map[string]any{"event": "实现完成", "time": now, "link": i["link"], "note": coreString(a["note"])}
		if coreHas(i, "aiExecution") {
			history["execution"] = coreClone(i["aiExecution"])
		}
		if summary != "" {
			i["completionNote"] = summary
			i["completionNoteVersion"] = i["version"]
			history["summary"] = summary
		} else {
			delete(i, "completionNote")
			delete(i, "completionNoteVersion")
		}
		coreHistory(i, history)
		return nil
	case "verificationVersion":
		if i["status"] != "pending_verification" || coreNum(i["executionVersion"]) != coreNum(i["version"]) {
			return errors.New("只能为当前待验证需求设置验证版本")
		}
		if !coreSafeInt(a["version"]) || coreNum(a["version"]) != coreNum(i["version"]) {
			return errors.New("需求版本已变化")
		}
		v := strings.TrimSpace(coreString(a["value"]))
		if len([]rune(v)) > 100 || strings.ContainsAny(v, "\r\n") {
			return errors.New("验证版本须为 100 字以内的单行文字")
		}
		if v == "" {
			delete(i, "verificationVersion")
		} else {
			i["verificationVersion"] = v
		}
		return nil
	case "completionNote":
		if i["status"] != "pending_verification" || !coreHas(i, "executionVersion") || coreNum(i["executionVersion"]) != coreNum(i["version"]) {
			return errors.New("只能为当前版本的待验证需求写入完成说明")
		}
		if coreHas(a, "version") && (!coreSafeInt(a["version"]) || coreNum(a["version"]) != coreNum(i["version"])) {
			return errors.New("需求版本已变化")
		}
		summary, e := coreCompletionSummary(map[string]any{"summary": a["summary"]})
		if e != nil {
			return e
		}
		i["completionNote"] = summary
		i["completionNoteVersion"] = i["version"]
		coreHistory(i, map[string]any{"event": "更新完成说明", "time": now, "summary": summary, "version": i["version"]})
		return nil
	case "revert":
		if i["status"] != "in_progress" && !(i["status"] == "ready" && ScheduledBatch(p, i) != nil) {
			return errors.New("需求不在执行中")
		}
		i["status"] = "ready"
		coreHistory(i, map[string]any{"event": "退回待执行", "time": now, "note": coreString(a["note"])})
		return nil
	case "verify":
		if i["status"] != "pending_verification" {
			return errors.New("需求不在待验证")
		}
		pass, ok := a["pass"].(bool)
		if !ok {
			return errors.New("请确认验证结果")
		}
		if pass && (!coreHas(i, "executionVersion") || coreNum(i["executionVersion"]) != coreNum(i["version"])) {
			return errors.New("需求版本已变化，请重新实现后验证")
		}
		if !pass && coreHas(a, "fixed") {
			fixed, ok := a["fixed"].([]any)
			if !ok {
				return errors.New("已修复标记无效")
			}
			prior := []any{}
			for _, v := range coreFailureEntries(i) {
				if !coreTruthy(coreMap(v)["resolved"]) {
					prior = append([]any{v}, prior...)
				}
			}
			for _, v := range fixed {
				n := coreNum(v)
				number, e := strconv.ParseFloat(coreString(v), 64)
				if e != nil || math.Trunc(number) != number || n < 0 || n >= int64(len(prior)) {
					return errors.New("已修复标记无效")
				}
				coreMap(prior[n])["resolved"] = true
			}
		}
		event := "验证失败"
		if pass {
			event = "验证通过"
		}
		coreHistory(i, map[string]any{"event": event, "time": now, "note": coreString(a["note"]), "confirmation": "用户手动确认", "version": i["version"]})
		if pass {
			i["status"] = "archived"
			i["archived"] = true
			coreHistory(i, map[string]any{"event": "归档", "time": now, "reason": "验证通过后自动归档"})
		} else {
			i["status"] = "ready"
			i["archived"] = false
			i["version"] = coreNum(i["version"]) + 1
		}
		return nil
	case "regress":
		if !coreTruthy(i["archived"]) && i["status"] != "archived" {
			return errors.New("需求尚未归档")
		}
		coreHistory(i, map[string]any{"event": "回归退回", "time": now, "note": coreString(a["note"])})
		i["status"] = "ready"
		i["archived"] = false
		i["version"] = coreNum(i["version"]) + 1
		return nil
	case "archive":
		if i["status"] == "in_progress" {
			return errors.New("请先取消执行")
		}
		i["archived"] = true
		i["status"] = "archived"
		coreHistory(i, map[string]any{"event": "归档", "time": now})
		return nil
	}
	return errors.New("未知操作")
}
func coreApplyItem(p, a map[string]any, now string) error {
	existing := coreFind(coreList(p["items"]), a["id"])
	value := func(k string, defaultValue any) any {
		if v, ok := a[k]; ok {
			if v != nil || !coreIn(k, "type", "priority", "executor") {
				return v
			}
		}
		if v, ok := existing[k]; ok {
			if v != nil {
				return v
			}
		}
		return defaultValue
	}
	criteria := coreList(existing["criteria"])
	if coreHas(a, "criteria") {
		criteria = []any{}
		for _, s := range strings.Split(coreString(a["criteria"]), "\n") {
			if t := strings.TrimSpace(s); t != "" {
				criteria = append(criteria, t)
			}
		}
	}
	attachments := value("attachments", []any{})
	list, ok := attachments.([]any)
	if !ok || len(list) > 12 {
		return errors.New("图片附件无效（最多 12 张，每张最多 10MB，支持 PNG/JPG/WebP/GIF）")
	}
	ids, labels := map[string]bool{}, map[string]bool{}
	for _, v := range list {
		x := coreMap(v)
		id, label := coreString(x["id"]), coreString(x["label"])
		_, nameok := x["name"].(string)
		url, urlok := x["dataUrl"].(string)
		if !nameok || !urlok || !regexp.MustCompile(`^[a-zA-Z0-9-]+$`).MatchString(id) || !regexp.MustCompile(`^图片[1-9]\d*$`).MatchString(label) || !regexp.MustCompile(`^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$`).MatchString(url) || len(url) > 14*1024*1024 || ids[id] || labels[label] {
			return errors.New("图片附件无效（最多 12 张，每张最多 10MB，支持 PNG/JPG/WebP/GIF）")
		}
		ids[id] = true
		labels[label] = true
	}
	date := existing["scheduledDate"]
	if coreHas(a, "scheduledDate") {
		v, e := ValidateDate(a["scheduledDate"])
		if e != nil {
			return e
		}
		if v == "" {
			date = nil
		} else {
			date = v
		}
	}
	title := coreString(value("title", ""))
	if coreHas(a, "title") {
		if a["title"] == nil {
			title = "null"
		}
		title = strings.TrimSpace(title)
	}
	body := coreString(value("body", ""))
	if coreHas(a, "body") && a["body"] == nil {
		body = "null"
	}
	typ := coreString(value("type", "feature"))
	priority := coreString(value("priority", "P1"))
	executor := coreString(value("executor", "ai"))
	if !coreExecutorPattern.MatchString(executor) {
		return errors.New("执行方式无效")
	}
	delivery := coreString(value("deliveryGuidance", p["deliveryGuidance"]))
	if coreHas(a, "deliveryGuidance") {
		var e error
		delivery, e = coreNeed(a["deliveryGuidance"], "交付引导")
		if e != nil {
			return e
		}
	}
	if !coreIn(typ, "feature", "improvement", "bug") || !coreIn(priority, "P0", "P1", "P2") {
		return errors.New("类型或优先级无效")
	}
	i := existing
	if i != nil {
		if !coreIn(coreString(i["status"]), "draft", "ready") {
			return errors.New("请先取消执行或退回，再编辑需求")
		}
		snapshot := coreMap(coreClone(i))
		delete(snapshot, "history")
		coreHistory(i, map[string]any{"event": "编辑", "time": now, "snapshot": snapshot})
		i["version"] = coreNum(i["version"]) + 1
	} else {
		i = map[string]any{"id": coreUUID(), "number": fmt.Sprintf("REQ-%03d", coreNum(p["nextNumber"])), "version": int64(1), "history": []any{map[string]any{"event": "创建", "time": now}}}
		if coreTruthy(a["clearDraft"]) {
			delete(p, "requirementDraft")
		}
		p["nextNumber"] = coreNum(p["nextNumber"]) + 1
		p["items"] = append(coreList(p["items"]), i)
	}
	for k, v := range map[string]any{"title": title, "body": body, "attachments": attachments, "criteria": criteria, "aiValidation": false, "deliveryGuidance": delivery, "type": typ, "priority": priority, "executor": executor, "status": "ready"} {
		i[k] = v
	}
	if date == nil {
		delete(i, "scheduledDate")
	} else {
		i["scheduledDate"] = date
	}
	return nil
}

// Keep deterministic sorting available to reporting callers without changing state.
func SortArchivedItems(items []any) {
	sort.SliceStable(items, func(i, j int) bool { return CompareArchivedItems(coreMap(items[i]), coreMap(items[j])) })
}
