package backendgo

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	defaultChatContextTokens = 256000
	minChatContextTokens     = 8192
	maxChatContextTokens     = 2000000
	chatReplyReserve         = 2048
)

func (s AISettings) chatContextCapacity() int {
	if s.ChatContextTokens == 0 {
		return defaultChatContextTokens
	}
	return s.ChatContextTokens
}

type aiChatUsage struct {
	input, output       int
	hasInput, hasOutput bool
}

func (u *aiChatUsage) read(data map[string]any, anthropic bool) {
	inputKey, outputKey := "prompt_tokens", "completion_tokens"
	if anthropic {
		inputKey, outputKey = "input_tokens", "output_tokens"
	}
	if input, ok := data[inputKey].(float64); ok && input >= 0 {
		u.input = int(input)
		if anthropic {
			u.input += int(aiNumber(data["cache_creation_input_tokens"]) + aiNumber(data["cache_read_input_tokens"]))
		}
		u.hasInput = u.input > 0
	}
	if output, ok := data[outputKey].(float64); ok && output >= 0 {
		u.output, u.hasOutput = int(output), true
	}
}

func estimateChatTokens(value string) int {
	var ascii, other int
	for _, character := range value {
		if character < 128 {
			ascii++
		} else {
			other++
		}
	}
	return (ascii+2)/3 + (other*3+1)/2
}

func chatInputEstimate(system string, payload []byte, images int) int {
	// Image tokenization depends on the model. Use a fixed allowance for the
	// budget check and prefer provider-reported counts for display.
	return estimateChatTokens(system) + estimateChatTokens(string(payload)) + 32 + 4096*images
}

func budgetChatHistory(context map[string]any, discussion []any, system string, images, capacity int) ([]byte, int, int, error) {
	limit := capacity - chatReplyReserve
	context["discussion"] = discussion
	payload, err := json.Marshal(context)
	if err != nil {
		return nil, 0, 0, err
	}
	tokens := chatInputEstimate(system, payload, images)
	if tokens <= limit {
		return payload, tokens, 0, nil
	}

	context["discussion"] = []any{}
	base, err := json.Marshal(context)
	if err != nil {
		return nil, 0, 0, err
	}
	remaining := limit - chatInputEstimate(system, base, images)
	if remaining < 0 {
		return nil, 0, 0, fmt.Errorf("上下文压缩后仍超出 %d Token。请缩短当前消息或候选说明，减少图片或项目来源，或调高设置中的容量", capacity)
	}
	// Retain the newest complete turns verbatim. Use a small share of the
	// remaining budget for excerpts from older messages.
	excerptBudget := min(remaining/8, 4096)
	first := len(discussion)
	for first > 0 {
		start := first - 1
		if start > 0 && aiMap(discussion[start])["role"] == "assistant" && aiMap(discussion[start-1])["role"] == "user" {
			start--
		}
		raw, _ := json.Marshal(discussion[start:first])
		cost := estimateChatTokens(string(raw)) + 1
		if remaining-cost < excerptBudget {
			break
		}
		first = start
		remaining -= cost
	}
	if first > 0 && remaining >= 96 {
		excerpts := []string{}
		available := min(remaining-64, 4096)
		for index := first - 1; index >= 0 && available >= 48; index-- {
			message := aiMap(discussion[index])
			content := strings.TrimSpace(aiString(message["content"]))
			if content == "" {
				continue
			}
			runes := []rune(content)
			length := min(len(runes), 240, (available-32)/3)
			excerpt := aiString(message["role"]) + "：" + string(runes[:length])
			if length < len(runes) {
				excerpt += "…"
			}
			raw, _ := json.Marshal(excerpt)
			available -= estimateChatTokens(string(raw)) + 1
			excerpts = append(excerpts, excerpt)
		}
		if len(excerpts) > 0 {
			for left, right := 0, len(excerpts)-1; left < right; left, right = left+1, right-1 {
				excerpts[left], excerpts[right] = excerpts[right], excerpts[left]
			}
			context["earlierDiscussionExcerpts"] = excerpts
		}
	}
	context["discussion"] = discussion[first:]
	payload, err = json.Marshal(context)
	if err != nil {
		return nil, 0, 0, err
	}
	tokens = chatInputEstimate(system, payload, images)
	if tokens > limit {
		delete(context, "earlierDiscussionExcerpts")
		payload, _ = json.Marshal(context)
		tokens = chatInputEstimate(system, payload, images)
	}
	return payload, tokens, first, nil
}

func (u aiChatUsage) result(estimatedInput int, output string, elapsed time.Duration, capacity, compressed int) map[string]any {
	if !u.hasInput {
		u.input = estimatedInput
	}
	if !u.hasOutput {
		u.output = estimateChatTokens(output)
	}
	return map[string]any{
		"inputTokens": u.input, "outputTokens": u.output, "contextTokens": u.input + u.output,
		"tps": float64(u.output) / max(elapsed.Seconds(), 0.001), "capacity": capacity,
		"estimated": !u.hasInput || !u.hasOutput, "compressedMessages": compressed,
	}
}
