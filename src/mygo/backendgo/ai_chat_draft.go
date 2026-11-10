package backendgo

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"
)

func aiHasQuestion(text string) bool { return strings.ContainsAny(text, "?？") }

// requirementClarificationAsked 判断最近一条助手回复是否在追问（REQ-320：同一需求只追问一轮）。
func requirementClarificationAsked(discussion []any) bool {
	for i := len(discussion) - 1; i >= 0; i-- {
		message := aiMap(discussion[i])
		if aiString(message["role"]) == "assistant" {
			return aiHasQuestion(aiString(message["content"]))
		}
	}
	return false
}

// needsRequirementDraftPass：助手只追问未建候选，或用户回答追问后候选未同步时，需要补一轮整理。
func needsRequirementDraftPass(reply string, discussion, drafts []any) bool {
	return aiHasQuestion(reply) || (len(drafts) > 0 && requirementClarificationAsked(discussion))
}

func aiRecentDiscussion(discussion []any, limit int) []any {
	if len(discussion) > limit {
		return discussion[len(discussion)-limit:]
	}
	return discussion
}

// parseRequirementDraftPass 解析整理轮的 {"changes":[...]}，返回合并后的候选与实际操作。
func parseRequirementDraftPass(text string, drafts []any) ([]any, []string, error) {
	payload := aiStripFence(strings.TrimPrefix(strings.TrimSpace(text), "\ufeff"))
	start := strings.Index(payload, "{")
	if start < 0 {
		return nil, nil, errors.New("整理结果不是 JSON")
	}
	var value map[string]any
	if err := json.NewDecoder(strings.NewReader(payload[start:])).Decode(&value); err != nil {
		return nil, nil, err
	}
	changes := aiArray(value["changes"])
	operations := []string{}
	for _, change := range changes {
		if action := aiString(aiMap(change)["action"]); action != "list" {
			operations = append(operations, action)
		}
	}
	if len(operations) == 0 {
		return nil, nil, nil
	}
	if len(changes) > aiRequirementDraftLimit {
		return nil, nil, errors.New("整理结果过多")
	}
	items, err := applyAIRequirementChanges(drafts, changes)
	if err != nil {
		return nil, nil, err
	}
	return items, operations, nil
}

var aiCLIDisplayNames = map[string]string{"codex": "Codex", "zcode": "ZCode", "pi": "Pi", "claude": "Claude Code"}

// aiChatModelInfo 记录本轮回复使用的供应商与模型（REQ-319）；actual 为供应商响应中返回的模型名。
func aiChatModelInfo(s AISettings, actual string) map[string]any {
	model := strings.TrimSpace(actual)
	if model == "" {
		model = strings.TrimSpace(s.Model)
	}
	info := map[string]any{}
	if s.Kind == "cli" {
		info["provider"] = aiCLIDisplayNames[s.CLI]
		if info["provider"] == "" {
			info["provider"] = s.CLI
		}
		if model == "" {
			model = "CLI 默认模型"
		}
		info["kind"] = "cli"
	} else {
		provider := strings.TrimSpace(s.Provider)
		if u, err := url.Parse(s.URL); err == nil && u.Host != "" {
			info["host"] = u.Host
			if provider == "" {
				provider = u.Host
			}
		}
		info["provider"] = provider
		info["kind"] = "api"
	}
	if s.ReasoningEffort != "" && s.ReasoningEffort != "none" {
		info["reasoningEffort"] = s.ReasoningEffort
	}
	info["model"] = model
	return info
}
