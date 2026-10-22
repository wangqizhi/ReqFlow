package backendgo

import "testing"

func TestTerminalDockSharesDetachedWindow(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "test")
	b.agentRuns = map[string]*agentRun{
		"cli-session": {project: "project-one", agent: "dsh"},
		"other-cli":   {project: "project-two", agent: "codex"},
	}
	window := ""
	opens := 0
	b.Native = func(method string, args []any) (any, error) {
		id := desktopString(args[0])
		switch method {
		case "terminal.status":
			return id == window, nil
		case "terminal.open":
			if window != "" && window != id {
				t.Fatal("opened a second window instead of reusing the dock")
			}
			window = id
			opens++
		case "terminal.close":
			if id != window {
				t.Fatal("closed the wrong window")
			}
			window = ""
		}
		return nil, nil
	}
	state := map[string]any{"projectId": "project-one", "project": "同名项目", "running": true, "startedAt": 1, "revision": 1}
	desktopTestCall(t, b, "publish:terminal:sync", "publish-session", state)
	desktopTestCall(t, b, "publish:terminal:sync", "other-publish", map[string]any{"projectId": "project-two", "project": "同名项目", "running": true, "startedAt": 1, "revision": 1})
	for _, first := range []string{"cli-session", "publish-session"} {
		channel := "agent:terminal:open"
		if first == "publish-session" {
			channel = "publish:terminal:open"
		}
		desktopTestCall(t, b, channel, first)
		for _, entry := range []struct{ channel, id string }{{"agent:terminal:status", "cli-session"}, {"publish:terminal:get", "publish-session"}} {
			result := desktopTestCall(t, b, entry.channel, entry.id)
			peers := result["peers"].([]terminalPeer)
			if result["detached"] != true || len(peers) != 2 {
				t.Fatalf("missing shared dock tabs: %#v", result)
			}
			for _, peer := range peers {
				if peer.RunID != "cli-session" && peer.RunID != "publish-session" {
					t.Fatal("mixed projects")
				}
			}
		}
		if desktopTestCall(t, b, "agent:terminal:status", "other-cli")["detached"] != false {
			t.Fatal("another project detached")
		}
		desktopTestCall(t, b, "agent:terminal:open", "cli-session")
		desktopTestCall(t, b, "publish:terminal:open", "publish-session")
		desktopTestCall(t, b, "agent:terminal:close", "cli-session")
		if desktopTestCall(t, b, "publish:terminal:get", "publish-session")["detached"] != false {
			t.Fatal("dock failed to reattach")
		}
	}
	if opens != 6 {
		t.Fatal("missing focus operations", opens)
	}
	b.desktopTerminalSessions["old-publish"] = publishTerminalSession{ProjectID: "project-one", Project: "同名项目", StartedAt: 0}
	b.agentRuns["old-cli"] = &agentRun{project: "project-one", agent: "dsh", done: true, lastWrite: 1000}
	peers := b.currentTerminalPeers("publish-session")
	if len(peers) != 2 || peers[0].RunID != "cli-session" || peers[1].RunID != "publish-session" {
		t.Fatal("historical runs duplicated dock tabs", peers)
	}
}
