package backendgo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func cleanVersion(value any) string {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	if !ok || text == "" || len([]rune(text)) > 100 || strings.ContainsAny(text, "\r\n") {
		return ""
	}
	return text
}

func versionComponents(value any) map[string]any {
	components := map[string]any{}
	for name, raw := range coreMap(value) {
		if cleanVersion(name) == "" {
			continue
		}
		if component, ok := raw.(map[string]any); ok {
			raw = component["version"]
		}
		if version := cleanVersion(raw); version != "" {
			components[name] = version
		}
	}
	return components
}

// A configured source may select a JSON field, e.g. release-versions.json#components.frontend.
// Components are captured at completion so later releases cannot change verification requirements.
func readProjectVersions(root, source string) (string, map[string]any) {
	empty := map[string]any{}
	if source == "" {
		source = "package.json"
	}
	file, selector, selected := strings.Cut(source, "#")
	if !filepath.IsAbs(root) || file == "" || filepath.IsAbs(file) || strings.Contains(strings.ReplaceAll(file, "\\", "/"), "..") {
		return "", empty
	}
	raw, err := os.ReadFile(filepath.Join(root, file))
	if err != nil {
		return "", empty
	}
	text := strings.TrimSpace(strings.TrimPrefix(string(raw), "\ufeff"))
	var value any
	if json.Unmarshal([]byte(text), &value) != nil {
		if selected || strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
			return "", empty
		}
		return cleanVersion(text), empty
	}
	if selected {
		if selector == "" {
			return "", empty
		}
		for _, key := range strings.Split(selector, ".") {
			value = coreMap(value)[key]
		}
	}
	if manifest, ok := value.(map[string]any); ok {
		return cleanVersion(manifest["version"]), versionComponents(manifest["components"])
	}
	return cleanVersion(value), empty
}

func (s *WorkspaceService) projectVersions(project string) (string, map[string]any) {
	r, err := s.localService().Get()
	if err != nil {
		return "", map[string]any{}
	}
	p := coreFind(coreList(coreMap(r["state"])["projects"]), project)
	return readProjectVersions(coreString(p["dir"]), coreString(p["versionFile"]))
}
