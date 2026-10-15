package backendgo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type cliModel struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	ReasoningEfforts []string `json:"reasoningEfforts,omitempty"`
}

func validReasoningEffort(value string) bool {
	for _, level := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"} {
		if value == level {
			return true
		}
	}
	return false
}

func codexHome() string {
	if dir := os.Getenv("CODEX_HOME"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex")
}

// Read CLI-owned model metadata only; never scan auth or session contents.
func cachedCodexModels() []cliModel {
	f, err := os.Open(filepath.Join(codexHome(), "models_cache.json"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var cache struct {
		Models []struct {
			Slug       string `json:"slug"`
			Name       string `json:"display_name"`
			Visibility string `json:"visibility"`
			Levels     []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
		} `json:"models"`
	}
	if json.NewDecoder(io.LimitReader(f, 4*1024*1024)).Decode(&cache) != nil {
		return nil
	}
	models := []cliModel{}
	seen := map[string]bool{}
	for _, row := range cache.Models {
		if !cliModelPattern.MatchString(row.Slug) || seen[row.Slug] || (row.Visibility != "" && row.Visibility != "list") {
			continue
		}
		seen[row.Slug] = true
		model := cliModel{ID: row.Slug, Name: row.Name}
		if model.Name == "" {
			model.Name = model.ID
		}
		for _, level := range row.Levels {
			if validReasoningEffort(level.Effort) {
				model.ReasoningEfforts = append(model.ReasoningEfforts, level.Effort)
			}
		}
		models = append(models, model)
		if len(models) >= 500 {
			break
		}
	}
	return models
}

func parsePiModels(text string) []cliModel {
	models := []cliModel{}
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 6 || (fields[4] != "yes" && fields[4] != "no") {
			continue
		}
		id := fields[0] + "/" + fields[1]
		if !cliModelPattern.MatchString(id) || seen[id] {
			continue
		}
		seen[id] = true
		model := cliModel{ID: id, Name: id}
		if fields[4] == "yes" {
			model.ReasoningEfforts = []string{"none", "minimal", "low", "medium", "high"}
		}
		models = append(models, model)
		if len(models) >= 500 {
			break
		}
	}
	return models
}

func discoverProviderModels(id, path string) ([]cliModel, string) {
	if id == "codex" {
		models := cachedCodexModels()
		if len(models) > 0 {
			return models, "来自 Codex 本地模型缓存；可重新检测或手工填写。"
		}
	}
	if id == "pi" {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		cmd := providerCommand(ctx, path, []string{"--list-models", "--offline", "--no-extensions", "--no-skills", "--no-mcp"})
		// Run outside the project so detection cannot load project configuration.
		cmd.Dir = os.TempDir()
		output := &aiLimitedOutput{limit: 1024 * 1024}
		cmd.Stdout = output
		cmd.Stderr = io.Discard
		if runProviderCommand(cmd) == nil && !output.tooLarge {
			models := parsePiModels(output.String())
			if len(models) > 0 {
				return models, "来自 Pi 本机可用模型列表；可重新检测或手工填写。"
			}
		}
	}
	return nil, "无法读取此 CLI 的模型列表，留空使用默认模型，也可手工填写。"
}

var codexConfiguredModel = regexp.MustCompile(`(?m)^model\s*=\s*"([a-zA-Z0-9._:/@+\-]+)"\s*$`)

// Resolve only locally advertised capabilities. Unknown models keep CLI defaults.
func codexReasoning(s AISettings) (string, error) {
	modelID := s.Model
	if modelID == "" {
		raw, _ := os.ReadFile(filepath.Join(codexHome(), "config.toml"))
		// Top-level values end at the first table; do not pick a profile's model.
		text := strings.SplitN(string(raw), "\n[", 2)[0]
		if match := codexConfiguredModel.FindStringSubmatch(text); len(match) == 2 {
			modelID = match[1]
		}
	}
	for _, model := range cachedCodexModels() {
		if model.ID != modelID || len(model.ReasoningEfforts) == 0 {
			continue
		}
		effort := s.ReasoningEffort
		if effort == "" {
			effort = "none"
		}
		for _, supported := range model.ReasoningEfforts {
			if effort == supported {
				return effort, nil
			}
		}
		// Some reasoning models cannot turn thinking off. Use their lowest level.
		if effort == "none" {
			return model.ReasoningEfforts[0], nil
		}
		return "", fmt.Errorf("模型 %s 不支持思考等级 %s，请重新选择", modelID, effort)
	}
	if s.ReasoningEffort != "" && s.ReasoningEffort != "none" {
		return "", fmt.Errorf("无法确认该 Codex 模型的思考等级，请重新检测或关闭思考设置")
	}
	return "", nil
}
