package backendgo

import (
	"encoding/json"
	"errors"
	"strings"
)

const aiRequirementToolName = "edit_requirement_drafts"
const aiRequirementDraftLimit = 20

func aiRequirementToolDefinition(anthropic bool) map[string]any {
	schema := json.RawMessage(`{
	  "type":"object",
	  "required":["reply","changes"],
	  "additionalProperties":false,
	  "properties":{
	    "reply":{"type":"string","description":"给用户的 Markdown 说明"},
	    "changes":{"type":"array","minItems":1,"maxItems":20,"items":{
	      "type":"object","required":["action"],"additionalProperties":false,
	      "properties":{
	        "action":{"type":"string","enum":["create","update","list"]},
	        "id":{"type":"string","description":"update 使用 currentDrafts 中的 ID"},
	        "title":{"type":"string"},
	        "body":{"type":"string"},
	        "type":{"type":"string","enum":["feature","improvement","bug"]},
	        "priority":{"type":"string","enum":["P0","P1","P2"]},
	        "criteria":{"type":"array","items":{"type":"string"}}
	      }
	    }}
	  }
	}`)
	tool := map[string]any{
		"name":        aiRequirementToolName,
		"description": "查询、新增或修订当前对话中的候选需求。查询可直接读取 currentDrafts，用 list 记录查询；修改只填写目标字段，待用户提交后才进入需求池。",
	}
	if anthropic {
		tool["input_schema"] = schema
		return tool
	}
	tool["parameters"] = schema
	return map[string]any{"type": "function", "function": tool}
}

type aiRequirementToolResponse struct {
	calls     []map[string]any
	reasoning []string
	invalid   bool
	rejected  bool
}

func (r *aiRequirementToolResponse) addReasoning(text string) {
	if text = strings.TrimSpace(text); text != "" {
		r.reasoning = append(r.reasoning, text)
	}
}

func (r *aiRequirementToolResponse) add(name string, input any) {
	call, ok := input.(map[string]any)
	if name != aiRequirementToolName || !ok || len(r.calls) >= aiRequirementDraftLimit {
		r.invalid = true
		return
	}
	r.calls = append(r.calls, call)
}

func (r *aiRequirementToolResponse) called() bool {
	return r.invalid || len(r.calls) > 0
}

func normalizeAIRequirementDraft(item map[string]any) (map[string]any, error) {
	title, titleOK := item["title"].(string)
	body, bodyOK := item["body"].(string)
	kind, priority := aiString(item["type"]), aiString(item["priority"])
	criteria, criteriaOK := item["criteria"].([]any)
	invalid := errors.New("AI 返回的需求字段无效")
	if !titleOK || !bodyOK || strings.TrimSpace(body) == "" || !coreIn(kind, "feature", "improvement", "bug") ||
		!coreIn(priority, "P0", "P1", "P2") || !criteriaOK {
		return nil, invalid
	}
	for _, c := range criteria {
		if _, ok := c.(string); !ok {
			return nil, invalid
		}
	}
	return map[string]any{"title": title, "body": body, "type": kind, "priority": priority, "criteria": criteria}, nil
}

func (r *aiRequirementToolResponse) result(text string, drafts []any) (map[string]any, error) {
	if r.invalid {
		return nil, errors.New("AI 返回的候选需求工具调用无效，请重试")
	}
	replies := []string{}
	if text = strings.TrimSpace(text); text != "" {
		replies = append(replies, text)
	}
	var changes []any
	traces := make([]map[string]any, 0, len(r.calls))
	for _, call := range r.calls {
		reply := strings.TrimSpace(aiString(call["reply"]))
		batch := aiArray(call["changes"])
		if len(batch) == 0 || len(changes)+len(batch) > aiRequirementDraftLimit {
			return nil, errors.New("AI 返回的候选需求变更数量无效，请重试")
		}
		if reply != "" && reply != text {
			replies = append(replies, reply)
		}
		changes = append(changes, batch...)
		operations := make([]string, 0, len(batch))
		for _, operation := range batch {
			operations = append(operations, aiString(aiMap(operation)["action"]))
		}
		traces = append(traces, map[string]any{"name": aiRequirementToolName, "operations": operations})
	}
	items, err := applyAIRequirementChanges(drafts, changes)
	if err != nil {
		return nil, err
	}
	if len(replies) == 0 {
		replies = append(replies, "已更新本轮候选需求。")
	}
	return map[string]any{"reply": strings.Join(replies, "\n\n"), "items": items, "toolCalls": traces}, nil
}

func applyAIRequirementChanges(drafts, changes []any) ([]any, error) {
	items := make([]any, 0, len(drafts))
	items = append(items, drafts...)
	indexes := make(map[string]int, len(drafts))
	for i, draft := range drafts {
		if id := aiString(aiMap(draft)["id"]); id != "" {
			indexes[id] = i
		}
	}
	for _, value := range changes {
		change := aiMap(value)
		action, id := aiString(change["action"]), aiString(change["id"])
		index, exists := indexes[id]
		switch action {
		case "list":
			continue
		case "create", "update":
			fields := []string{"title", "body", "type", "priority", "criteria"}
			input := aiSubset(change, fields...)
			if action == "update" {
				if !exists {
					return nil, errors.New("AI 引用的候选需求不存在，请重试")
				}
				input = aiSubset(aiMap(items[index]), fields...)
				for _, field := range fields {
					if value, ok := change[field]; ok {
						input[field] = value
					}
				}
			}
			draft, err := normalizeAIRequirementDraft(input)
			if err != nil {
				return nil, err
			}
			if action == "create" {
				items = append(items, draft)
			} else {
				draft["id"] = id
				items[index] = draft
			}
		default:
			return nil, errors.New("AI 返回的候选需求操作无效，请重试")
		}
	}
	raw, err := json.Marshal(items)
	if err != nil || len(items) > aiRequirementDraftLimit || len(raw) > 200000 {
		return nil, errors.New("候选需求内容过多，请缩短说明后重试")
	}
	return items, nil
}
