package backendgo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCompletionNoteLifecycle(t *testing.T) {
	s, p := coreTestState()
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "完成说明"})
	i := coreMap(coreList(p["items"])[0])
	a := map[string]any{"op": "completionNote", "project": p["id"], "id": i["id"], "summary": "说明"}
	if Apply(s, a) == nil {
		t.Fatal("ready item accepted completion note")
	}
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	complete := map[string]any{"op": "complete", "project": p["id"], "id": i["id"], "summary": strings.Repeat("中", 51)}
	if Apply(s, complete) == nil || i["status"] != "ready" {
		t.Fatal("oversize summary changed lifecycle")
	}
	delete(complete, "summary")
	complete["note"] = "[ReqFlow Codex run test]\n已实现CLI字段\n验证：生命周期测试通过"
	coreTestApply(t, s, complete)
	if i["completionNote"] != "已实现CLI字段\n验证：生命周期测试通过" || coreNum(i["completionNoteVersion"]) != coreNum(i["version"]) {
		t.Fatal(i)
	}
	for _, invalid := range []string{"", "   ", strings.Repeat("😀", 51)} {
		a["summary"] = invalid
		if Apply(s, a) == nil {
			t.Fatal("invalid summary accepted")
		}
	}
	a["summary"] = strings.Repeat("😀", 50)
	a["version"] = 99
	if Apply(s, a) == nil {
		t.Fatal("stale version accepted")
	}
	a["version"] = i["version"]
	coreTestApply(t, s, a)
	if len([]rune(coreString(i["completionNote"]))) != 50 {
		t.Fatal("Unicode limit mismatch")
	}
	version := i["version"]
	coreTestApply(t, s, map[string]any{"op": "verify", "project": p["id"], "id": i["id"], "pass": false, "note": "返工"})
	if Apply(s, a) == nil || i["completionNoteVersion"] != version || coreNum(i["version"]) == coreNum(version) {
		t.Fatal("old completion note not version bound")
	}
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	complete["summary"] = "新版本完成并测试"
	coreTestApply(t, s, complete)
	if i["completionNote"] != "新版本完成并测试" || i["completionNoteVersion"] != i["version"] {
		t.Fatal("new completion did not replace note")
	}
}

func TestRevertDraftScheduledItem(t *testing.T) {
	s, p := coreTestState()
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "排期需求"})
	i := coreMap(coreList(p["items"])[0])
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	if ScheduledBatch(p, i) == nil {
		t.Fatal("item not scheduled")
	}
	coreTestApply(t, s, map[string]any{"op": "revert", "project": p["id"], "id": i["id"]})
	if i["status"] != "ready" || ScheduledBatch(p, i) != nil {
		t.Fatal("item still scheduled after revert")
	}
}

func TestVerificationVersionLifecycle(t *testing.T) {
	s, p := coreTestState()
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "验证版本"})
	i := coreMap(coreList(p["items"])[0])
	action := map[string]any{"op": "verificationVersion", "project": p["id"], "id": i["id"], "version": i["version"], "value": "2.13.0"}
	if Apply(s, action) == nil {
		t.Fatal("ready item accepted verification version")
	}
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	coreTestApply(t, s, map[string]any{"op": "complete", "project": p["id"], "id": i["id"]})
	coreTestApply(t, s, action)
	if i["verificationVersion"] != "2.13.0" {
		t.Fatal(i)
	}
	action["version"] = 999
	if Apply(s, action) == nil {
		t.Fatal("stale version accepted")
	}
	coreTestApply(t, s, map[string]any{"op": "verify", "project": p["id"], "id": i["id"], "pass": false, "note": "重做"})
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	coreTestApply(t, s, map[string]any{"op": "complete", "project": p["id"], "id": i["id"]})
	if _, ok := i["verificationVersion"]; ok {
		t.Fatal("old build version carried into new completion")
	}
	// REQ-242：完成时由宿主写入可验证版本，无需用户填写。
	coreTestApply(t, s, map[string]any{"op": "verify", "project": p["id"], "id": i["id"], "pass": false, "note": "再做"})
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	coreTestApply(t, s, map[string]any{"op": "complete", "project": p["id"], "id": i["id"], "verificationVersion": "2.13.1"})
	if i["verificationVersion"] != "2.13.1" {
		t.Fatal(i)
	}
}

func coreTestApply(t *testing.T, s map[string]any, a map[string]any) {
	t.Helper()
	if e := Apply(s, a); e != nil {
		t.Fatalf("%v: %v", a["op"], e)
	}
}
func coreTestState() (map[string]any, map[string]any) {
	p := MakeProject("测试", "项目背景")
	return map[string]any{"projects": []any{p}}, p
}
func TestCoreRequirementLifecycle(t *testing.T) {
	s, p := coreTestState()
	id := p["id"]
	coreTestApply(t, s, map[string]any{"op": "item", "project": id, "title": "登录", "criteria": "可登录\n \n可退出", "scheduledDate": "2026-10-13"})
	i := coreMap(coreList(p["items"])[0])
	iid := i["id"]
	if i["number"] != "REQ-001" || len(coreList(i["criteria"])) != 2 {
		t.Fatal(i)
	}
	coreTestApply(t, s, map[string]any{"op": "generate", "project": id, "ids": []any{iid}})
	b := coreMap(coreList(p["batches"])[0])
	if ScheduledBatch(p, i) == nil || b["hash"] != coreHash(coreString(b["text"])) || !strings.Contains(coreString(b["text"]), "- [ ] 可登录") {
		t.Fatal("prompt/schedule mismatch")
	}
	coreTestApply(t, s, map[string]any{"op": "complete", "project": id, "id": iid, "batch": b["id"], "version": i["version"]})
	if i["status"] != "pending_verification" {
		t.Fatal(i)
	}
	coreTestApply(t, s, map[string]any{"op": "verify", "project": id, "id": iid, "pass": false, "note": "退出未实现"})
	if coreNum(i["version"]) != 2 || i["status"] != "ready" {
		t.Fatal(i)
	}
	if err := Apply(s, map[string]any{"op": "complete", "project": id, "id": iid, "batch": b["id"], "version": int64(1)}); err == nil {
		t.Fatal("stale batch completed")
	}
	coreTestApply(t, s, map[string]any{"op": "generate", "project": id, "ids": []any{iid}})
	b = coreMap(coreList(p["batches"])[0])
	if !strings.Contains(coreString(b["text"]), "退出未实现") {
		t.Fatal("failed verification missing")
	}
	coreTestApply(t, s, map[string]any{"op": "submit", "project": id, "batch": b["id"]})
	if err := Apply(s, map[string]any{"op": "item", "project": id, "id": iid, "title": "不能编辑"}); err == nil {
		t.Fatal("edited running item")
	}
	coreTestApply(t, s, map[string]any{"op": "complete", "project": id, "id": iid})
	coreTestApply(t, s, map[string]any{"op": "verify", "project": id, "id": iid, "pass": true})
	if i["status"] != "archived" || !coreTruthy(i["archived"]) || len(UnresolvedFailures(i)) != 0 {
		t.Fatal(i)
	}
	coreTestApply(t, s, map[string]any{"op": "regress", "project": id, "id": iid, "note": "回归问题"})
	if i["status"] != "ready" || coreNum(i["version"]) != 3 || len(UnresolvedFailures(i)) != 1 {
		t.Fatal(i)
	}
	if len(coreList(i["flowEvents"])) < 8 {
		t.Fatal("timeline incomplete")
	}
}
func TestCoreAssignmentAndAccumulatedBatches(t *testing.T) {
	s, p := coreTestState()
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "work"})
	i := coreMap(coreList(p["items"])[0])
	a := map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}}
	coreTestApply(t, s, a)
	first := coreMap(coreList(p["batches"])[0])
	coreTestApply(t, s, map[string]any{"op": "assign", "project": p["id"], "ids": []any{i["id"]}, "executor": "human"})
	if ScheduledBatch(p, i) == nil || coreMap(coreList(first["items"])[0])["executor"] != "human" {
		t.Fatal("assignment invalidated schedule")
	}
	if e := Apply(s, map[string]any{"op": "complete", "project": p["id"], "id": i["id"], "batch": first["id"], "version": i["version"]}); e == nil {
		t.Fatal("human item accepted AI completion")
	}
	coreTestApply(t, s, map[string]any{"op": "submit", "project": p["id"], "batch": first["id"]})
	coreTestApply(t, s, a)
	second := coreMap(coreList(p["batches"])[0])
	coreTestApply(t, s, map[string]any{"op": "submit", "project": p["id"], "batch": second["id"]})
	coreTestApply(t, s, map[string]any{"op": "cancel", "project": p["id"], "batch": first["id"]})
	if i["status"] != "in_progress" {
		t.Fatal("cancelled item while another batch runs")
	}
	coreTestApply(t, s, map[string]any{"op": "guidance", "project": p["id"], "text": "新引导", "deliveryGuidance": "自定义交付"})
	if i["status"] != "in_progress" || second["status"] != "submitted" || coreNum(i["version"]) != 1 {
		t.Fatal("guidance must preserve the running schedule")
	}
}
func TestCoreValidationAndSettings(t *testing.T) {
	s, p := coreTestState()
	for _, date := range []any{"2026-02-29", "2026-13-01", "0000-01-01", "2026-1-01", true} {
		if _, e := ValidateDate(date); e == nil {
			t.Fatalf("accepted %v", date)
		}
	}
	if _, e := ValidateDate("2024-02-29"); e != nil {
		t.Fatal(e)
	}
	for _, a := range []map[string]any{{"op": "item", "executor": "plugin:bad/command"}, {"op": "item", "type": "bad"}, {"op": "item", "priority": "P3"}, {"op": "item", "deliveryGuidance": ""}, {"op": "item", "attachments": []any{map[string]any{"id": "../x", "label": "图片1", "name": "x", "dataUrl": "data:image/png;base64,AA=="}}}, {"op": "publishScript", "script": "../publish.js"}, {"op": "publishScript", "script": "C:/publish.js"}, {"op": "verifySource", "source": map[string]any{"kind": "file", "value": "x"}}} {
		a["project"] = p["id"]
		if e := Apply(s, a); e == nil {
			t.Fatalf("accepted %v", a)
		}
	}
	coreTestApply(t, s, map[string]any{"op": "folder", "name": "F"})
	folder := coreMap(coreList(s["folders"])[1])
	coreTestApply(t, s, map[string]any{"op": "projectFolder", "project": p["id"], "folderId": folder["id"]})
	coreTestApply(t, s, map[string]any{"op": "deleteFolder", "folderId": folder["id"]})
	if p["folderId"] != "default" {
		t.Fatal("folder removal lost project")
	}
	if e := Apply(s, map[string]any{"op": "deleteProject", "project": p["id"]}); e == nil {
		t.Fatal("deleted last project")
	}
	if !MatchesSchedule("", "through", "2026-10-13") || MatchesSchedule("2026-10-14", "through", "2026-10-13") {
		t.Fatal("date filter")
	}
}
func TestCoreMoveAndVerificationFailures(t *testing.T) {
	s, p := coreTestState()
	coreTestApply(t, s, map[string]any{"op": "project", "name": "目标"})
	target := coreMap(coreList(s["projects"])[1])
	target["deliveryGuidance"] = "目标默认"
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "说明"})
	i := coreMap(coreList(p["items"])[0])
	coreTestApply(t, s, map[string]any{"op": "moveItem", "project": p["id"], "id": i["id"], "targetProject": target["id"]})
	if i["deliveryGuidance"] != "说明改动、未解决的问题。" || coreNum(i["version"]) != 2 || len(coreList(p["items"])) != 0 {
		t.Fatal("moved item settings mismatch")
	}
	i["history"] = []any{map[string]any{"event": "验证失败", "time": "2026-10-13T00:00:00.000Z", "note": "新问题"}, map[string]any{"event": "验证失败", "time": "2026-10-12T00:00:00.000Z", "note": "旧问题"}, map[string]any{"event": "验证失败", "time": "2026-10-11T00:00:00.000Z", "note": "已修复", "resolved": true}}
	fails := UnresolvedFailures(i)
	if len(fails) != 2 || coreMap(fails[0])["current"] != false || coreMap(fails[1])["current"] != true {
		t.Fatal("failure ordering")
	}
	prompt := BuildPrompt(target, []any{i})
	if !strings.Contains(prompt, "【此前问题未修复】旧问题") || !strings.Contains(prompt, "【本轮新问题】新问题") || strings.Contains(prompt, "已修复") {
		t.Fatal(prompt)
	}
}
func TestCoreCanonicalTokenJSON(t *testing.T) {
	var p map[string]any
	_ = json.Unmarshal([]byte(`{"id":"p","revision":99,"unknown":{"10":"ten","2":"two","😀":"astral","\ue000":"private","path":"derived"},"text":"<>&\u2028literal\\u2028","path":"generated"}`), &p)
	expected := "8a648adbc33fff970d06a3dc86ab01c862cc72761478479aeda29387e3542e33"
	if token := ProjectConcurrencyToken(p); token != expected {
		t.Fatalf("TS signature mismatch got %s want %s", token, expected)
	}
	before := ProjectConcurrencyToken(p)
	p["revision"] = int64(100)
	p["path"] = "changed"
	if ProjectConcurrencyToken(p) != before {
		t.Fatal("derived fields changed token")
	}
	p["text"] = "changed"
	if ProjectConcurrencyToken(p) == before {
		t.Fatal("user edit retained token")
	}
	var decoded any
	if e := json.Unmarshal([]byte(coreJSON(p)), &decoded); e != nil {
		t.Fatal("literal escape corrupted JSON", e)
	}
}

func TestCorePromptMatchesTypeScript(t *testing.T) {
	var fixture map[string]any
	if e := json.Unmarshal([]byte(`{"p":{"id":"p","name":"中文😀测试","description":"背景\n第二行","guidance":"请结合项目背景实现需求，遵循现有技术栈与代码规范。完成后说明改动、运行方式、验证结果与剩余问题。","guideVersion":1,"guideHistory":[],"deliveryGuidance":"说明改动、测试命令和结果、未解决的问题。","aiValidation":false,"items":[],"batches":[],"nextNumber":1},"items":[{"id":"a","number":"REQ-001","title":"登录😀","body":"<form>登录</form>","type":"bug","priority":"P0","criteria":["成功","退出"],"version":2,"history":[{"event":"验证失败","time":"2026-10-13T00:00:00.000Z","note":"新问题"},{"event":"验证失败","time":"2026-10-12T00:00:00.000Z","note":"旧问题"}],"attachments":[{"id":"img","label":"图片1","name":"ref.png","dataUrl":"data:image/png;base64,AA==","path":"E:/ref.png"}]},{"id":"b","number":"REQ-002","title":"","body":"<form>登录</form>","type":"bug","priority":"P0","criteria":["成功","退出"],"version":2,"history":[],"attachments":[],"deliveryGuidance":"独立交付"}]}`), &fixture); e != nil {
		t.Fatal(e)
	}
	prompt := BuildPrompt(coreMap(fixture["p"]), coreList(fixture["items"]))
	if hash := coreHash(prompt); hash != "1c5e43bcc66146b6698673f20459eef5cd036c9f83fa961d9aba43c6d8def563" {
		t.Fatalf("TypeScript prompt mismatch: %s", hash)
	}
}

func TestPromptReleaseNotesGuidance(t *testing.T) {
	for _, source := range []string{"guidance", "deliveryGuidance", "title", "body", "criteria"} {
		t.Run(source, func(t *testing.T) {
			p := MakeProject("测试项目", "项目背景")
			i := map[string]any{"number": "REQ-001", "title": "普通需求", "body": "修改页面", "type": "feature", "priority": "P1", "criteria": []any{}}
			if source == "guidance" || source == "deliveryGuidance" {
				p[source] = "完成后生成安装包"
			} else if source == "criteria" {
				i[source] = []any{"发布说明符合规范"}
			} else {
				i[source] = "更新 changelog"
			}
			prompt := BuildPrompt(p, []any{i, coreClone(i)})
			if strings.Count(prompt, "## 版本交付与发布说明") != 1 || !strings.HasSuffix(prompt, ReleaseNotesGuidance) {
				t.Fatal("release guidance missing or duplicated")
			}
			for _, required := range []string{"## 主要更新", "docs/release-<版本>.md", "node scripts/release-notes-check.mjs", "不因重试再次升版"} {
				if !strings.Contains(prompt, required) {
					t.Fatalf("missing %s", required)
				}
			}
		})
	}
	p := MakeProject("普通项目", "背景")
	i := map[string]any{"number": "REQ-001", "body": "修改页面", "type": "feature", "priority": "P1", "criteria": []any{}}
	if strings.Contains(BuildPrompt(p, []any{i}), "## 版本交付与发布说明") {
		t.Fatal("unrelated task received release guidance")
	}
}

func TestDeferPoolItem(t *testing.T) {
	s, p := coreTestState()
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "延迟需求"})
	i := coreMap(coreList(p["items"])[0])
	a := map[string]any{"op": "deferItem", "project": p["id"], "id": i["id"], "deferred": true}
	coreTestApply(t, s, a)
	if i["deferred"] != true || coreNum(i["version"]) != 1 || i["status"] != "ready" {
		t.Fatal(i)
	}
	if ids := MutationProjectIDs(a); len(ids) != 1 {
		t.Fatal(ids)
	}
	a["deferred"] = "true"
	if Apply(s, a) == nil {
		t.Fatal("invalid boolean accepted")
	}
	a["deferred"] = false
	coreTestApply(t, s, a)
	if i["deferred"] != false {
		t.Fatal(i)
	}
	a["deferred"] = true
	coreTestApply(t, s, a)
	coreTestApply(t, s, map[string]any{"op": "generate", "project": p["id"], "ids": []any{i["id"]}})
	if Apply(s, a) == nil {
		t.Fatal("scheduled item accepted delay change")
	}
	coreTestApply(t, s, map[string]any{"op": "submit", "project": p["id"], "batch": coreMap(coreList(p["batches"])[0])["id"]})
	if Apply(s, a) == nil {
		t.Fatal("executing item accepted delay change")
	}
}

func TestCompletionAutomaticallyRecordsVersion(t *testing.T) {
	for _, remote := range []bool{false, true} {
		t.Run(fmtBool(remote), func(t *testing.T) {
			b := NewBackend(t.TempDir(), t.TempDir(), "2.13.5")
			r := coreTestGet(t, b.Workspace)
			pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"version":"7.8.9"}`), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": pid, "dir": dir}, nil); err != nil {
				t.Fatal(err)
			}
			if remote {
				base, token, stop := startTestSyncServer(t)
				defer stop()
				var sid string
				b, _, sid = syncFixtureBackend(t, base, token)
				r = coreTestGet(t, b.Workspace)
				pid = coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
				if _, err := b.Workspace.Mutate(map[string]any{"op": "projectDir", "project": pid, "dir": dir}, nil); err != nil {
					t.Fatal(err)
				}
				if _, err := b.Workspace.Mutate(map[string]any{"op": "projectSync", "project": pid, "server": sid}, nil); err != nil {
					t.Fatal(err)
				}
			}
			r, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": pid, "body": "automatic version"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			p := coreFind(coreList(coreMap(r["state"])["projects"]), pid)
			id := coreMap(coreList(p["items"])[0])["id"]
			if _, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": pid, "ids": []any{id}}, nil); err != nil {
				t.Fatal(err)
			}
			r, err = b.Workspace.Mutate(map[string]any{"op": "complete", "project": pid, "id": id}, nil)
			if err != nil {
				t.Fatal(err)
			}
			i := coreFind(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), pid)["items"]), id)
			if i["verificationVersion"] != "7.8.9" {
				t.Fatalf("missing automatic version: %v", i)
			}
		})
	}
}
func fmtBool(remote bool) string {
	if remote {
		return "remote"
	}
	return "local"
}

func TestCorePromptTemplateSaveRenderReset(t *testing.T) {
	s, p := coreTestState()
	template := "项目 {{project_name}} / {{requirement_count}} / {{requirement_ids}}\n{{project_prompt}}"
	coreTestApply(t, s, map[string]any{"op": "globalCorePromptTemplate", "text": template})
	coreTestApply(t, s, map[string]any{"op": "item", "project": p["id"], "body": "literal {{requirement_ids}}"})
	got := renderCorePrompt(coreString(NormalizeWorkspace(s)["corePromptTemplate"]), p, coreList(p["items"]), []string{"REQ-1"})
	if !strings.Contains(got, " / 1 / REQ-1") || !strings.Contains(got, "literal {{requirement_ids}}") {
		t.Fatal(got)
	}
	coreTestApply(t, s, map[string]any{"op": "globalCorePromptTemplate", "text": " "})
	if coreString(s["corePromptTemplate"]) != "" {
		t.Fatal("reset failed")
	}
	if got = renderCorePrompt("", p, coreList(p["items"]), []string{"REQ-1"}); !strings.HasPrefix(got, "使用 ReqFlow Agent") {
		t.Fatal(got)
	}
}

func TestOnlyUnfinishedOwnedTasksBlockDesktopClose(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.13.5")
	r := coreTestGet(t, b.Workspace)
	pid := coreMap(coreList(coreMap(r["state"])["projects"])[0])["id"]
	r, err := b.Workspace.Mutate(map[string]any{"op": "item", "project": pid, "body": "owned task"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	id := coreString(coreMap(coreList(coreFind(coreList(coreMap(r["state"])["projects"]), pid)["items"])[0])["id"])
	b.agentRuns = map[string]*agentRun{"test": {agent: "codex", project: coreString(pid), items: []string{id}}}
	if !b.HasRunningAgentTasks() {
		t.Fatal("unfinished owned task must be protected")
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "generate", "project": pid, "ids": []any{id}}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = b.Workspace.Mutate(map[string]any{"op": "complete", "project": pid, "id": id}, nil); err != nil {
		t.Fatal(err)
	}
	if b.HasRunningAgentTasks() {
		t.Fatal("idle terminal must not block close after completion")
	}
}
