package backendgo

import (
	"errors"
	"os"
	"strings"
	"time"
)

type requirementContext struct {
	fields     map[string]any
	counts     map[string]int
	files      []string
	omitImages bool
}

type preparedRequirementContext struct {
	project string
	expires time.Time
	context requirementContext
}

func collectRequirementContext(project map[string]any, sources map[string]any, chat bool) requirementContext {
	result := requirementContext{fields: map[string]any{}, counts: map[string]int{}, files: []string{}}
	enabled := func(key string) bool { return sources[key] != false }
	metadata := map[string]any{}
	if enabled("overview") {
		for _, key := range []string{"name", "description"} {
			if value := aiString(project[key]); strings.TrimSpace(value) != "" {
				metadata[key] = value
				result.counts["overview"]++
			}
		}
	}
	if enabled("guidance") {
		keys := []string{"guidance"}
		if chat && project["contextRulesDisabled"] != true {
			keys = append(keys, "contextRules")
		}
		for _, key := range keys {
			if value := aiString(project[key]); strings.TrimSpace(value) != "" {
				metadata[key] = value
				result.counts["guidance"]++
			}
		}
	}
	if len(metadata) > 0 {
		result.fields["project"] = metadata
	}
	if enabled("requirements") {
		recent := []any{}
		all := aiArray(project["items"])
		for i := len(all) - 1; i >= 0 && len(recent) < 40; i-- {
			item := aiSubset(aiMap(all[i]), "number", "title", "body", "type", "priority", "status", "criteria")
			item["body"] = aiLimit(aiString(item["body"]), 3000)
			recent = append(recent, item)
		}
		result.fields["recentRequirements"] = recent
		result.counts["requirements"] = len(recent)
	}
	root := aiString(project["dir"])
	if root == "" {
		return result
	}
	if enabled("git") {
		if log, err := RunRemoteGit([]string{"log", "--since=7.days", "-30", "--format=%h %ad %s", "--date=short"}, root, aiMap(project["remote"])); err == nil {
			if log = strings.TrimSpace(aiLimit(log, 16000)); log != "" {
				result.fields["gitLog"] = log
				result.counts["git"] = strings.Count(log, "\n") + 1
			}
		}
	}
	if enabled("files") {
		files := []any{}
		for _, name := range []string{"README.md", "package.json", "AGENTS.md", "docs/architecture.md"} {
			path, err := DesktopSafePath(root, name)
			if err != nil {
				continue
			}
			info, err := os.Stat(path)
			if err != nil || !info.Mode().IsRegular() || info.Size() > 2*1024*1024 {
				continue
			}
			if raw, err := os.ReadFile(path); err == nil {
				files = append(files, map[string]any{"name": name, "content": aiLimit(string(raw), 12000)})
				result.files = append(result.files, name)
			}
		}
		result.fields["files"] = files
		result.counts["files"] = len(files)
	}
	return result
}

func (b *Backend) prepareRequirementContext(args []any) (any, error) {
	id := aiString(aiArg(args, 0))
	project, err := b.aiProject(id)
	if err != nil {
		return nil, err
	}
	sources := aiMap(aiArg(args, 1))
	context := collectRequirementContext(project, sources, true)
	context.omitImages = sources["images"] == false
	token := coreUUID()
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.aiRequirementContexts == nil {
		b.aiRequirementContexts = make(map[string]preparedRequirementContext)
	}
	var oldest string
	for key, entry := range b.aiRequirementContexts {
		if now.After(entry.expires) {
			delete(b.aiRequirementContexts, key)
			continue
		}
		if oldest == "" || entry.expires.Before(b.aiRequirementContexts[oldest].expires) {
			oldest = key
		}
	}
	if len(b.aiRequirementContexts) >= 32 {
		delete(b.aiRequirementContexts, oldest)
	}
	b.aiRequirementContexts[token] = preparedRequirementContext{id, now.Add(30 * time.Minute), context}
	return desktopOK(map[string]any{"token": token, "counts": context.counts}), nil
}

func (b *Backend) requirementContextFor(id, token string, project map[string]any, chat bool) (requirementContext, error) {
	if token == "" {
		return collectRequirementContext(project, nil, chat), nil
	}
	b.mu.Lock()
	entry, ok := b.aiRequirementContexts[token]
	b.mu.Unlock()
	if !ok || entry.project != id || time.Now().After(entry.expires) {
		return requirementContext{}, errors.New("上下文预览已失效，请刷新来源后重试")
	}
	return entry.context, nil
}
