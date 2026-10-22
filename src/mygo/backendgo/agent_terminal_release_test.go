package backendgo

import (
	"context"
	"encoding/base64"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type exitingAgentPTY struct {
	exit chan struct{}
	once sync.Once
	code uint32
}

func (p *exitingAgentPTY) Read([]byte) (int, error)             { <-p.exit; return 0, io.EOF }
func (p *exitingAgentPTY) Write(data []byte) (int, error)       { return len(data), nil }
func (p *exitingAgentPTY) Resize(int, int) error                { return nil }
func (p *exitingAgentPTY) Close() error                         { p.once.Do(func() { close(p.exit) }); return nil }
func (p *exitingAgentPTY) Wait(context.Context) (uint32, error) { <-p.exit; return p.code, nil }

func TestAgentExitReleasesAssignedClaims(t *testing.T) {
	for _, exit := range []string{"stop", "normal", "failure"} {
		t.Run(exit, func(t *testing.T) {
			b := NewBackend(t.TempDir(), t.TempDir(), "test")
			state := coreTestGet(t, b.Workspace)
			pid := coreString(coreMap(coreList(coreMap(state["state"])["projects"])[0])["id"])
			mutate := func(action map[string]any) map[string]any {
				action["project"] = pid
				result, err := b.Workspace.Mutate(action, nil)
				if err != nil {
					t.Fatal(err)
				}
				return coreFind(coreList(coreMap(result["state"])["projects"]), pid)
			}
			var ids []any
			for n := 0; n < 7; n++ {
				p := mutate(map[string]any{"op": "item", "body": coreString(n)})
				for _, value := range coreList(p["items"]) {
					id := coreMap(value)["id"]
					found := false
					for _, old := range ids {
						if old == id {
							found = true
						}
					}
					if !found {
						ids = append(ids, id)
					}
				}
			}
			p := mutate(map[string]any{"op": "generate", "ids": ids})
			batch := ScheduledBatch(p, coreFind(coreList(p["items"]), ids[0]))
			pty := &exitingAgentPTY{exit: make(chan struct{})}
			if exit == "failure" {
				pty.code = 1
			}
			r := &agentRun{pty: pty, project: pid, agent: "codex", assignments: map[string]agentAssignment{}}
			for n, id := range ids[:6] {
				r.items = append(r.items, coreString(id))
				r.assignments[coreString(id)] = agentAssignment{version: 1, batch: coreString(batch["id"])}
				if n == 4 {
					r.assignments[coreString(id)] = agentAssignment{version: 2, batch: coreString(batch["id"])}
				}
				if n == 5 {
					r.assignments[coreString(id)] = agentAssignment{version: 1, batch: "old-batch"}
				}
			}
			b.agentRuns = map[string]*agentRun{"terminal": r}
			drained := make(chan struct{})
			go func() { defer close(drained); r.collect() }()
			go b.waitAgent(r, drained)
			// Claims come from a separate plugin process after terminal startup.
			runID := coreUUID()
			claim := func(id any, client string) {
				_, err := NewWorkspaceService(b.DataDir).Mutate(map[string]any{"op": "executionClaim", "project": pid, "run": runID, "client": client, "claims": []any{map[string]any{"id": id, "version": 1, "batchId": batch["id"], "hash": batch["hash"]}}}, nil)
				if err != nil {
					t.Fatal(err)
				}
			}
			for _, id := range []any{ids[0], ids[1], ids[2], ids[4], ids[5], ids[6]} {
				claim(id, "codex")
			}
			claim(ids[3], "pi")
			mutate(map[string]any{"op": "complete", "id": ids[2], "run": runID, "batch": batch["id"], "version": 1, "summary": "already done"})
			if exit == "stop" {
				desktopTestCall(t, b, "agent:stop", "terminal")
			} else {
				_ = pty.Close()
			}
			deadline := time.Now().Add(5 * time.Second)
			var output map[string]any
			for time.Now().Before(deadline) {
				output = desktopTestCall(t, b, "agent:read", "terminal", 0)
				if coreTruthy(output["done"]) {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !coreTruthy(output["done"]) {
				t.Fatal("terminal did not finish cleanup")
			}
			raw, _ := base64.StdEncoding.DecodeString(coreString(output["data"]))
			if !strings.Contains(string(raw), "已释放 2 条任务") {
				t.Fatal(string(raw))
			}
			p, err := b.desktopProject(pid)
			if err != nil {
				t.Fatal(err)
			}
			for n, id := range ids {
				i := coreFind(coreList(p["items"]), id)
				switch n {
				case 0, 1:
					if ActiveAIExecution(i) != nil || coreMap(i["aiExecution"])["outcome"] != "released" || coreMap(i["aiExecution"])["endedAt"] == nil || ScheduledBatch(p, i) == nil {
						t.Fatal("assignment not released to schedule", i)
					}
				case 2:
					if i["status"] != "pending_verification" || coreMap(i["aiExecution"])["outcome"] != "completed" {
						t.Fatal("completed task changed", i)
					}
				default:
					if ActiveAIExecution(i) == nil {
						t.Fatal("unrelated claim released", i)
					}
				}
			}
			if count, err := b.releaseAgentExecutions(r); err != nil || count != 0 {
				t.Fatal("repeat cleanup", count, err)
			}
			if _, err := b.Workspace.Mutate(map[string]any{"op": "complete", "project": pid, "id": ids[0], "run": runID, "batch": batch["id"], "version": 1, "summary": "stale"}, nil); err == nil {
				t.Fatal("released run completed")
			}
		})
	}
}
