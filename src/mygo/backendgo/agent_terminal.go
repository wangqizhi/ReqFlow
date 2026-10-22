package backendgo

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type agentPTY interface {
	io.ReadWriteCloser
	Resize(int, int) error
	Wait(context.Context) (uint32, error)
}

// agentTerminalLabel 是终端会话里展示的 Agent 名称；新增交互 Agent 时同步登记。
func agentTerminalLabel(agent string) string {
	if agent == "codex" {
		return "Codex"
	}
	if agent == "zcode" {
		return "ZCode"
	}
	if agent == "pi" {
		return "Pi"
	}
	if agent == "claude-code" {
		return "Claude Code"
	}
	if agent == "dsh" {
		return "DeepSeek Harness"
	}
	return agent
}

type agentRun struct {
	mu          sync.Mutex
	control     sync.Mutex
	pty         agentPTY
	project     string
	items       []string
	assignments map[string]agentAssignment // Protected by Backend.agentMu, like items.
	agent       string
	output      []byte
	total       int64
	lastWrite   int64 // 最近一次 PTY 输出的 Unix 毫秒；total 为 0 时无效
	done        bool
	closeOnce   sync.Once
}

type agentAssignment struct {
	version int64
	batch   string
}

func (r *agentRun) close() { r.closeOnce.Do(func() { _ = r.pty.Close() }) }
func (r *agentRun) idleMilliseconds(now int64) int64 {
	if r.total <= 0 || r.lastWrite <= 0 {
		return 0
	}
	idle := now - r.lastWrite
	if idle < 0 {
		return 0
	}
	return idle
}
func (r *agentRun) collect() {
	buffer := make([]byte, 8192)
	for {
		n, err := r.pty.Read(buffer)
		if n > 0 {
			r.mu.Lock()
			r.output = append(r.output, buffer[:n]...)
			r.total += int64(n)
			r.lastWrite = time.Now().UnixMilli()
			if len(r.output) > 2*1024*1024 {
				r.output = append([]byte(nil), r.output[len(r.output)-2*1024*1024:]...)
			}
			r.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// One interactive session receives a combined prompt for all selected requirements.
func (b *Backend) desktopAgent(channel string, args []any) (any, error) {
	if channel == "agent:start" {
		project, agent := desktopText(args, 0), desktopText(args, 1)
		ids := desktopList(desktopArg(args, 2))
		if agent != "codex" && agent != "pi" && agent != "zcode" && agent != "claude-code" && agent != "dsh" {
			return nil, errors.New("目前支持指派给 Codex、Pi、ZCode、Claude Code 或 DeepSeek Harness")
		}
		if len(ids) == 0 {
			return nil, errors.New("请至少选择一条需求")
		}
		settings, err := desktopReadJSON(filepath.Join(b.DataDir, "local-agents.json"), map[string]any{})
		if err != nil {
			return nil, err
		}
		enabled := agent == "codex"
		for _, value := range desktopList(settings) {
			if value == agent {
				enabled = true
			}
		}
		if !enabled {
			return nil, errors.New("请先在 Local Agent 配置中开启 " + agentTerminalLabel(agent))
		}
		p, err := b.desktopProject(project)
		if err != nil {
			return nil, err
		}
		root := coreString(p["dir"])
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() || !filepath.IsAbs(root) {
			return nil, errors.New("请关联有效的本地项目目录")
		}
		items := []any{}
		itemIDs := []string{}
		labels := []string{}
		assignments := map[string]agentAssignment{}
		for _, value := range ids {
			id := coreString(value)
			item := coreFind(coreList(p["items"]), value)
			if slices.Contains(itemIDs, id) || item == nil || coreExecutor(item) != "ai" || ActiveAIExecution(item) != nil || ScheduledBatch(p, item) == nil || coreTruthy(item["archived"]) || !coreIn(coreString(item["status"]), "ready", "in_progress") {
				return nil, errors.New("需求不可指派，请刷新排期状态")
			}
			items = append(items, item)
			itemIDs = append(itemIDs, id)
			assignments[id] = agentAssignment{version: coreNum(item["version"]), batch: coreString(ScheduledBatch(p, item)["id"])}
			labels = append(labels, coreString(item["number"])+"（需求 ID："+id+"）")
		}
		b.agentMu.Lock()
		defer b.agentMu.Unlock()
		if b.agentRuns == nil {
			b.agentRuns = map[string]*agentRun{}
		}
		prompt := fmt.Sprintf("使用 ReqFlow Agent 执行当前项目需求。仅领取并执行以下 %d 条需求：%s，其他需求不属于本轮。完成后通过 ReqFlow Agent 回写待验证，保留人工验收。\n\n%s", len(items), strings.Join(labels, "、"), BuildPrompt(p, items))
		for id, r := range b.agentRuns {
			r.mu.Lock()
			done := r.done
			r.mu.Unlock()
			if r.project == project && !done {
				// A rejected/edited requirement is a new round. Retire its old TUI
				// before the renderer's asynchronous stop request reaches us.
				if !agentHasCurrentAssignments(p, r) {
					go r.close()
					continue
				}
				if r.agent == agent && len(r.items) == len(itemIDs) && func() bool {
					for _, id := range itemIDs {
						if !slices.Contains(r.items, id) {
							return false
						}
					}
					return true
				}() {
					return desktopOK(map[string]any{"runId": id, "agent": r.agent}), nil
				}
				if agent == "dsh" && r.agent == agent && dshAssignmentsFinished(p, r.items) {
					if err := queueDshPrompt(r, prompt); err != nil {
						return nil, err
					}
					for _, itemID := range itemIDs {
						if !slices.Contains(r.items, itemID) {
							r.items = append(r.items, itemID)
						}
						if r.assignments == nil {
							r.assignments = map[string]agentAssignment{}
						}
						r.assignments[itemID] = assignments[itemID]
					}
					return desktopOK(map[string]any{"runId": id, "agent": r.agent, "items": r.items}), nil
				}
				return nil, errors.New("此项目已有 " + agentTerminalLabel(r.agent) + " 会话，请先完成或停止当前会话")
			}
		}
		var pty agentPTY
		if agent == "zcode" {
			pty, err = startZCodeTask(root, prompt)
		} else if agent == "dsh" {
			pty, err = startDshChatPTY(root, prompt, coreString(p["name"]))
		} else {
			pty, err = startAgentPTY(root, agent, prompt)
		}
		if err != nil {
			return nil, err
		}
		id := coreUUID()
		r := &agentRun{pty: pty, project: project, items: itemIDs, assignments: assignments, agent: agent}
		b.agentRuns[id] = r
		drained := make(chan struct{})
		go func() { defer close(drained); r.collect() }()
		go b.waitAgent(r, drained)
		return desktopOK(map[string]any{"runId": id}), nil
	}
	b.agentMu.Lock()
	r := b.agentRuns[desktopText(args, 0)]
	b.agentMu.Unlock()
	if r == nil {
		return nil, errors.New("终端会话不存在")
	}
	if channel == "agent:read" {
		r.mu.Lock()
		defer r.mu.Unlock()
		offset := desktopInt(desktopArg(args, 1))
		base := r.total - int64(len(r.output))
		truncated := offset < base
		if offset < base || offset > r.total {
			offset = base
		}
		return desktopOK(map[string]any{"data": base64.StdEncoding.EncodeToString(r.output[offset-base:]), "offset": r.total, "done": r.done, "truncated": truncated, "idleMs": r.idleMilliseconds(time.Now().UnixMilli())}), nil
	}
	// 指派的交互终端与发布终端共用窗口机制：最大化后在独立窗口继续同一个会话。
	if channel == "agent:terminal:status" {
		id := desktopText(args, 0)
		_, detached, err := b.terminalWindowID(id)
		return desktopOK(map[string]any{"detached": detached, "peers": b.currentTerminalPeers(id)}), err
	}
	if channel == "agent:terminal:open" || channel == "agent:terminal:close" {
		id := desktopText(args, 0)
		windowID, _, err := b.terminalWindowID(id)
		if err != nil {
			return nil, err
		}
		if channel == "agent:terminal:close" {
			_, err := desktopNative(b, "terminal.close", windowID)
			return desktopOK(nil), err
		}
		name := r.project
		if p, err := b.desktopProject(r.project); err == nil {
			name = coreString(p["name"])
		}
		query := "&agent=" + url.QueryEscape(r.agent) + "&project=" + url.QueryEscape(name)
		_, err = desktopNative(b, "terminal.open", windowID, name+" · "+agentTerminalLabel(r.agent), query)
		return desktopOK(nil), err
	}
	if channel == "agent:status" {
		r.mu.Lock()
		defer r.mu.Unlock()
		return desktopOK(map[string]any{"done": r.done, "idleMs": r.idleMilliseconds(time.Now().UnixMilli())}), nil
	}
	if channel == "agent:stop" {
		go r.close()
		return desktopOK(nil), nil
	}
	r.control.Lock()
	defer r.control.Unlock()
	r.mu.Lock()
	done := r.done
	r.mu.Unlock()
	if done {
		return nil, errors.New(agentTerminalLabel(r.agent) + " 会话已结束")
	}
	switch channel {
	case "agent:write":
		if r.agent == "zcode" {
			return nil, errors.New("ZCode 为任务日志模式，不支持继续输入")
		}
		input := desktopText(args, 1)
		if len(input) > 64*1024 {
			return nil, errors.New("终端输入过长")
		}
		_, err := r.pty.Write([]byte(input))
		return desktopOK(nil), err
	case "agent:resize":
		cols, rows := int(desktopInt(desktopArg(args, 1))), int(desktopInt(desktopArg(args, 2)))
		if cols < 2 || cols > 500 || rows < 2 || rows > 200 {
			return nil, errors.New("终端尺寸无效")
		}
		return desktopOK(nil), r.pty.Resize(cols, rows)
	}
	return nil, errors.New("未知终端操作")
}

// Wait for the CLI to stop before releasing, including a claim made just before
// exit. Mark done only after cleanup so the UI cannot offer reassignment early.
func (b *Backend) waitAgent(r *agentRun, drained <-chan struct{}) {
	code, err := r.pty.Wait(context.Background())
	r.close()
	<-drained
	message := fmt.Sprintf("\r\n[%s 已退出，退出码 %d]\r\n", agentTerminalLabel(r.agent), code)
	if err != nil {
		message = fmt.Sprintf("\r\n[%s 会话结束：%v]\r\n", agentTerminalLabel(r.agent), err)
	}
	count, releaseErr := b.releaseAgentExecutions(r)
	if releaseErr != nil {
		message += fmt.Sprintf("[释放任务失败：%v；请在执行中页面释放剩余任务]\r\n", releaseErr)
	} else if count > 0 {
		message += fmt.Sprintf("[已释放 %d 条任务，可在排期表重新指派]\r\n", count)
	}
	r.mu.Lock()
	r.output = append(r.output, []byte(message)...)
	r.total += int64(len(message))
	r.done = true
	r.mu.Unlock()
}

func (b *Backend) releaseAgentExecutions(r *agentRun) (int, error) {
	b.agentMu.Lock()
	assignments := make(map[string]agentAssignment, len(r.assignments))
	for id, assignment := range r.assignments {
		assignments[id] = assignment
	}
	b.agentMu.Unlock()
	p, err := b.desktopProject(r.project) // Read fresh storage, including external plugin claims.
	if err != nil {
		return 0, err
	}
	count := 0
	var failures []error
	for id, assignment := range assignments {
		item := coreFind(coreList(p["items"]), id)
		if item == nil {
			continue
		}
		execution := ActiveAIExecution(item)
		if execution == nil || execution["client"] != r.agent || coreNum(execution["version"]) != assignment.version || coreString(execution["batchId"]) != assignment.batch {
			continue
		}
		runID := coreString(execution["runId"])
		_, err := b.Workspace.Mutate(map[string]any{"op": "executionRelease", "project": r.project, "id": id, "run": runID, "note": agentTerminalLabel(r.agent) + " 终端会话已结束，任务返回排期表"}, nil)
		if err != nil {
			// Completion or a new owner between the read and mutation is harmless.
			current, readErr := b.desktopProject(r.project)
			if readErr == nil {
				latest := coreFind(coreList(current["items"]), id)
				if latest == nil || ActiveAIExecution(latest) == nil || ActiveAIExecution(latest)["runId"] != runID {
					continue
				}
			}
			failures = append(failures, fmt.Errorf("%s: %w", id, err))
			continue
		}
		count++
	}
	return count, errors.Join(failures...)
}

func dshAssignmentsFinished(project map[string]any, ids []string) bool {
	for _, id := range ids {
		item := coreFind(coreList(project["items"]), id)
		if item != nil && !coreTruthy(item["archived"]) && !coreIn(coreString(item["status"]), "pending_verification", "archived") {
			return false
		}
	}
	return true
}

func agentHasCurrentAssignments(project map[string]any, run *agentRun) bool {
	for id, assignment := range run.assignments {
		item := coreFind(coreList(project["items"]), id)
		if item != nil && !coreTruthy(item["archived"]) && item["status"] != "archived" && coreNum(item["version"]) == assignment.version {
			return true
		}
	}
	return false
}

// Send only a short control line through ConPTY; a full multiline prompt can
// exceed the console line limit or be split into separate chat turns.
func queueDshPrompt(run *agentRun, prompt string) error {
	file, err := os.CreateTemp("", "reqflow-dsh-task-*.txt")
	if err != nil {
		return err
	}
	name := file.Name()
	_, err = file.WriteString(prompt)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		run.control.Lock()
		_, err = run.pty.Write([]byte("/reqflow-task-file " + name + "\r"))
		run.control.Unlock()
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}
