package backendgo

import (
	"encoding/json"
	"errors"
	"strings"
)

// Frontend-owned release progress also covers Git/AI steps before the script starts.
// Keep it in memory so all terminal windows can observe the same session.
type publishTerminalSession struct {
	ProjectID string `json:"projectId,omitempty"`
	Project   string `json:"project"`
	Idle      bool   `json:"idle,omitempty"`
	Running   bool   `json:"running"`
	Step      string `json:"step"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt"`
	Revision  int64  `json:"revision"`
	Result    *struct {
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	} `json:"result"`
}

func (b *Backend) desktopPublishTerminal(channel string, args []any) (any, error) {
	id := desktopText(args, 0)
	if !desktopTerminalID.MatchString(id) {
		return nil, errors.New("发布终端标识无效")
	}
	if channel == "publish:terminal:sync" {
		raw, err := json.Marshal(desktopArg(args, 1))
		if err != nil {
			return nil, err
		}
		var session publishTerminalSession
		if err = json.Unmarshal(raw, &session); err != nil {
			return nil, err
		}
		if strings.TrimSpace(session.Project) == "" || len(session.Project) > 1000 || len(session.Step) > 1000 || session.StartedAt <= 0 || session.Revision <= 0 || (!session.Running && session.EndedAt < session.StartedAt) {
			return nil, errors.New("发布终端状态无效")
		}
		b.desktopPublishMu.Lock()
		defer b.desktopPublishMu.Unlock()
		if b.desktopTerminalSessions == nil {
			b.desktopTerminalSessions = make(map[string]publishTerminalSession)
		}
		previous, exists := b.desktopTerminalSessions[id]
		if exists && session.Revision <= previous.Revision {
			return desktopOK(nil), nil
		}
		if !exists && len(b.desktopTerminalSessions) >= 20 {
			oldest := ""
			for key, entry := range b.desktopTerminalSessions {
				if !entry.Running && (oldest == "" || entry.StartedAt < b.desktopTerminalSessions[oldest].StartedAt) {
					oldest = key
				}
			}
			if oldest == "" {
				return nil, errors.New("同时执行的发布任务过多")
			}
			delete(b.desktopTerminalSessions, oldest)
		}
		b.desktopTerminalSessions[id] = session
		return desktopOK(nil), nil
	}
	b.desktopPublishMu.Lock()
	session, exists := b.desktopTerminalSessions[id]
	b.desktopPublishMu.Unlock()
	if channel == "publish:terminal:get" {
		if !exists {
			return desktopOK(map[string]any{"session": nil, "detached": false}), nil
		}
		_, detached, err := b.terminalWindowID(id)
		return desktopOK(map[string]any{"session": session, "detached": detached, "peers": b.currentTerminalPeers(id)}), err
	}
	if !exists {
		return nil, errors.New("发布终端会话不存在")
	}
	switch channel {
	case "publish:terminal:open":
		windowID, _, err := b.terminalWindowID(id)
		if err != nil {
			return nil, err
		}
		_, err = desktopNative(b, "terminal.open", windowID, session.Project)
		return desktopOK(nil), err
	case "publish:terminal:close":
		windowID, _, err := b.terminalWindowID(id)
		if err != nil {
			return nil, err
		}
		_, err = desktopNative(b, "terminal.close", windowID)
		return desktopOK(nil), err
	}
	return nil, errors.New("未知发布终端操作")
}
