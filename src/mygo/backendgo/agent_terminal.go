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
	mu        sync.Mutex
	control   sync.Mutex
	pty       agentPTY
	project   string
	items     []string
	agent     string
	output    []byte
	total     int64
	lastWrite int64 // 最近一次 PTY 输出的 Unix 毫秒；total 为 0 时无效
	done      bool
	closeOnce sync.Once
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
		for _, value := range ids {
			id := coreString(value)
			item := coreFind(coreList(p["items"]), value)
			if slices.Contains(itemIDs, id) || item == nil || coreExecutor(item) != "ai" || ActiveAIExecution(item) != nil || ScheduledBatch(p, item) == nil || coreTruthy(item["archived"]) || !coreIn(coreString(item["status"]), "ready", "in_progress") {
				return nil, errors.New("需求不可指派，请刷新排期状态")
			}
			items = append(items, item)
			itemIDs = append(itemIDs, id)
			labels = append(labels, coreString(item["number"])+"（需求 ID："+id+"）")
		}
		b.agentMu.Lock()
		defer b.agentMu.Unlock()
		if b.agentRuns == nil {
			b.agentRuns = map[string]*agentRun{}
		}
		for id, r := range b.agentRuns {
			r.mu.Lock()
			done := r.done
			r.mu.Unlock()
			if r.project == project && !done {
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
				return nil, errors.New("此项目已有 " + agentTerminalLabel(r.agent) + " 会话，请先完成或停止当前会话")
			}
		}
		prompt := fmt.Sprintf("使用 ReqFlow Agent 执行当前项目需求。仅领取并执行以下 %d 条需求：%s，其他需求不属于本轮。完成后通过 ReqFlow Agent 回写待验证，保留人工验收。\n\n%s", len(items), strings.Join(labels, "、"), BuildPrompt(p, items))
		var pty agentPTY
		if agent == "zcode" {
			pty, err = startZCodeTask(root, prompt)
		} else {
			pty, err = startAgentPTY(root, agent, prompt)
		}
		if err != nil {
			return nil, err
		}
		id := coreUUID()
		r := &agentRun{pty: pty, project: project, items: itemIDs, agent: agent}
		b.agentRuns[id] = r
		drained := make(chan struct{})
		go func() { defer close(drained); r.collect() }()
		go func() {
			code, err := pty.Wait(context.Background())
			r.close()
			<-drained
			r.mu.Lock()
			message := fmt.Sprintf("\r\n[%s 已退出，退出码 %d]\r\n", agentTerminalLabel(agent), code)
			if err != nil {
				message = fmt.Sprintf("\r\n[%s 会话结束：%v]\r\n", agentTerminalLabel(agent), err)
			}
			r.output = append(r.output, []byte(message)...)
			r.total += int64(len(message))
			r.done = true
			r.mu.Unlock()
		}()
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
		status, err := desktopNative(b, "terminal.status", desktopText(args, 0))
		return desktopOK(map[string]any{"detached": status == true}), err
	}
	if channel == "agent:terminal:open" || channel == "agent:terminal:close" {
		id := desktopText(args, 0)
		if channel == "agent:terminal:close" {
			_, err := desktopNative(b, "terminal.close", id)
			return desktopOK(nil), err
		}
		name := r.project
		if p, err := b.desktopProject(r.project); err == nil {
			name = coreString(p["name"])
		}
		query := "&agent=" + url.QueryEscape(r.agent) + "&project=" + url.QueryEscape(name)
		_, err := desktopNative(b, "terminal.open", id, name+" · "+agentTerminalLabel(r.agent), query)
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
