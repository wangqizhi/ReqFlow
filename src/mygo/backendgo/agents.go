package backendgo

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var aiAgentDefinitions = []map[string]any{{"id": "opencode", "name": "OpenCode", "command": "opencode", "package": "opencode-ai"}, {"id": "pi", "name": "pi", "command": "pi", "package": "@earendil-works/pi-coding-agent"}}
var aiAgentVersion = regexp.MustCompile(`\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b`)
var aiSimpleVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func aiValidAgent(id string) bool {
	return id == "codex" || id == "zcode" || id == "opencode" || id == "pi"
}

func ProbeAgent(command string) map[string]any {
	if !aiValidAgent(command) {
		return map[string]any{"installed": false, "error": "Agent 命令无效"}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	// The entire command is chosen from the fixed allowlist; user input is never shell text.
	cmd := exec.CommandContext(ctx, command, "--version")
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", command+" --version")
	}
	aiHideCommand(cmd)
	stdout := &aiLimitedOutput{limit: 16384}
	cmd.Stdout = stdout
	cmd.Stderr = io.Discard
	if cmd.Run() != nil || stdout.tooLarge {
		return map[string]any{"installed": false, "error": "未找到可用命令，或版本检测失败/超时"}
	}
	version := aiAgentVersion.FindString(stdout.String())
	result := map[string]any{"installed": true}
	if version != "" {
		result["version"] = version
	} else {
		result["error"] = "命令可用，但无法识别版本"
	}
	return result
}

func aiLatestNewer(local, latest string) (bool, bool) {
	if !aiSimpleVersion.MatchString(local) || !aiSimpleVersion.MatchString(latest) {
		return false, false
	}
	a, b := strings.Split(local, "."), strings.Split(latest, ".")
	for i := 0; i < 3; i++ {
		x, _ := strconv.Atoi(a[i])
		y, _ := strconv.Atoi(b[i])
		if x != y {
			return y > x, true
		}
	}
	return false, true
}

func aiLatestAgentVersion(packageName string) (string, error) {
	registry := os.Getenv("REQFLOW_NPM_REGISTRY")
	if registry == "" {
		registry = "https://registry.npmjs.org"
	}
	endpoint := strings.TrimRight(registry, "/") + "/" + url.PathEscape(packageName) + "/latest"
	client := DesktopHTTPClient(8 * time.Second)
	response, err := client.Get(endpoint)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", errors.New("registry request failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return "", err
	}
	var value map[string]any
	if err = json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	version, ok := value["version"].(string)
	if !ok || version == "" {
		return "", errors.New("registry version missing")
	}
	return version, nil
}

func (b *Backend) invokeAgents(channel string, args []any) (any, error) {
	path := filepath.Join(b.DataDir, "local-agents.json")
	switch channel {
	case "agents:get":
		var stored any
		err := aiReadJSON(path, &stored)
		if err != nil && !os.IsNotExist(err) {
			return nil, errors.New("读取 Agent 配置失败")
		}
		enabled := []any{}
		for _, value := range aiArray(stored) {
			if id, ok := value.(string); ok && aiValidAgent(id) {
				enabled = append(enabled, id)
			}
		}
		return map[string]any{"ok": true, "enabled": enabled}, nil
	case "agents:save":
		values, ok := aiArg(args, 0).([]any)
		if !ok {
			return nil, errors.New("Agent 配置无效")
		}
		enabled := []any{}
		seen := map[string]bool{}
		for _, value := range values {
			id, ok := value.(string)
			if !ok || !aiValidAgent(id) {
				return nil, errors.New("Agent 配置无效")
			}
			if !seen[id] {
				enabled = append(enabled, id)
				seen[id] = true
			}
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if err := aiWriteJSON(path, enabled); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	case "agents:detect":
		results := make([]any, len(aiAgentDefinitions))
		var wait sync.WaitGroup
		for i, definition := range aiAgentDefinitions {
			wait.Add(1)
			go func(index int, d map[string]any) {
				defer wait.Done()
				result := aiCloneMap(d)
				for k, v := range ProbeAgent(aiString(d["command"])) {
					result[k] = v
				}
				latest, err := aiLatestAgentVersion(aiString(d["package"]))
				if err != nil {
					result["registryError"] = "无法获取最新版本，请稍后重试"
				} else {
					result["latest"] = latest
					if update, valid := aiLatestNewer(aiString(result["version"]), latest); valid {
						result["update"] = update
					}
				}
				results[index] = result
			}(i, definition)
		}
		wait.Wait()
		return map[string]any{"ok": true, "agents": results}, nil
	}
	return nil, errors.New("未知 Agent 通道")
}
