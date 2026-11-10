package backendgo

import (
	"strings"
	"sync"
	"time"
)

// REQ-318：Push 过程输出按项目目录记录，浏览项目底部信息栏轮询显示。
const gitProgressLineLimit = 200

type gitProgress struct {
	mu      sync.Mutex
	lines   []string
	partial string
	running bool
	failed  bool
	started time.Time
	ended   time.Time
}

func (p *gitProgress) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	text := p.partial + strings.ReplaceAll(string(data), "\r\n", "\n")
	for {
		index := strings.IndexAny(text, "\r\n")
		if index < 0 {
			break
		}
		line, separator := strings.TrimSpace(text[:index]), text[index]
		text = text[index+1:]
		if line == "" {
			continue
		}
		// git 以 \r 刷新同一行进度（如 Writing objects: 45%），只保留最新一次。
		if separator == '\r' || p.progressLine(line) {
			if n := len(p.lines); n > 0 && sameProgress(p.lines[n-1], line) {
				p.lines[n-1] = line
				continue
			}
		}
		p.lines = append(p.lines, line)
		if len(p.lines) > gitProgressLineLimit {
			p.lines = p.lines[len(p.lines)-gitProgressLineLimit:]
		}
	}
	p.partial = text
	return len(data), nil
}

func (p *gitProgress) progressLine(line string) bool { return strings.Contains(line, "%") }

func sameProgress(previous, line string) bool {
	prefix := func(s string) string {
		if index := strings.Index(s, ":"); index > 0 {
			return s[:index]
		}
		return s
	}
	return strings.Contains(previous, "%") && prefix(previous) == prefix(line)
}

func (p *gitProgress) add(line string) { _, _ = p.Write([]byte(line + "\n")) }

func (b *Backend) beginGitProgress(root string) *gitProgress {
	p := &gitProgress{running: true, started: time.Now()}
	b.mu.Lock()
	if b.gitProgress == nil {
		b.gitProgress = make(map[string]*gitProgress)
	}
	b.gitProgress[root] = p
	b.mu.Unlock()
	return p
}

func (p *gitProgress) finish(err error, summary string) {
	if err != nil {
		p.add("失败：" + err.Error())
	} else if summary = strings.TrimSpace(summary); summary != "" {
		for _, line := range strings.Split(summary, "\n") {
			p.add(line)
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.partial = strings.TrimSpace(p.partial); p.partial != "" {
		p.lines = append(p.lines, p.partial)
		p.partial = ""
	}
	p.running, p.failed, p.ended = false, err != nil, time.Now()
}

func (b *Backend) gitProgressOutput(root string) map[string]any {
	b.mu.Lock()
	p := b.gitProgress[root]
	b.mu.Unlock()
	if p == nil {
		return desktopOK(map[string]any{"lines": []string{}, "running": false, "started": false})
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	lines := append([]string{}, p.lines...)
	if partial := strings.TrimSpace(p.partial); partial != "" {
		lines = append(lines, partial)
	}
	result := map[string]any{"lines": lines, "running": p.running, "failed": p.failed, "started": true, "startedAt": p.started.Format(time.RFC3339)}
	if !p.ended.IsZero() {
		result["endedAt"] = p.ended.Format(time.RFC3339)
	}
	return desktopOK(result)
}
