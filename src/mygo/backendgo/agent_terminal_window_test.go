package backendgo

import (
	"context"
	"strings"
	"testing"
)

// 指派终端最大化复用发布终端窗口：打开独立窗口、查询状态与关闭窗口都只操作同一个会话。
func TestAgentTerminalWindowLifecycle(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	state := coreTestGet(t, b.Workspace)
	project := coreMap(coreList(coreMap(state["state"])["projects"])[0])
	pid, name := coreString(project["id"]), coreString(project["name"])
	b.agentRuns = map[string]*agentRun{"agent-window": {project: pid, agent: "codex"}}
	detached := false
	b.Native = func(method string, args []any) (any, error) {
		if desktopString(args[0]) != "agent-window" {
			t.Fatal("wrong agent session")
		}
		switch method {
		case "terminal.open":
			if desktopString(args[1]) != name+" · Codex" {
				t.Fatal("wrong terminal title")
			}
			query := desktopString(args[2])
			if !strings.Contains(query, "&agent=codex") || !strings.Contains(query, "&project=") {
				t.Fatal("window query did not describe the agent session")
			}
			detached = true
		case "terminal.close":
			detached = false
		case "terminal.status":
			return detached, nil
		default:
			t.Fatal("unexpected native operation", method)
		}
		return nil, nil
	}
	if desktopBool(desktopTestCall(t, b, "agent:terminal:status", "agent-window")["detached"]) {
		t.Fatal("terminal reported detached before opening")
	}
	desktopTestCall(t, b, "agent:terminal:open", "agent-window")
	if !desktopBool(desktopTestCall(t, b, "agent:terminal:status", "agent-window")["detached"]) {
		t.Fatal("terminal was not detached")
	}
	desktopTestCall(t, b, "agent:terminal:close", "agent-window")
	if desktopBool(desktopTestCall(t, b, "agent:terminal:status", "agent-window")["detached"]) {
		t.Fatal("terminal stayed detached after close")
	}
	result, _ := b.Invoke(context.Background(), "agent:terminal:open", []any{"unknown-session"})
	if desktopMap(result)["ok"] != false {
		t.Fatal("unknown session opened")
	}
}
