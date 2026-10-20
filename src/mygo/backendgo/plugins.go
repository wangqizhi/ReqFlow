package backendgo

import (
	"encoding/json"
	"errors"
)

// Populated at build time from the shipped plugin sources. No network or
// developer checkout is needed by the installed executable.
var pluginBundlesJSON = `{}`

func pluginRelease(command string, args map[string]any) (map[string]any, error) {
	var bundles map[string]map[string]any
	if err := json.Unmarshal([]byte(pluginBundlesJSON), &bundles); err != nil {
		return nil, err
	}
	host := coreString(args["host"])
	if host != "codex" && host != "zcode" && host != "pi" && host != "claude-code" && host != "opencode" {
		return nil, errors.New("--host 必须为 codex / zcode / pi / claude-code / opencode")
	}
	bundle, ok := bundles[host]
	if !ok {
		return nil, errors.New("此构建未包含插件，请使用正式安装包")
	}
	result := map[string]any{"host": host, "name": bundle["name"], "version": bundle["version"], "sha256": bundle["sha256"]}
	if local := coreString(args["plugin-version"]); local != "" {
		update, valid := aiLatestNewer(local, coreString(bundle["version"]))
		if !valid {
			return nil, errors.New("插件版本必须为 x.y.z")
		}
		result["updateAvailable"] = update
		result["installedVersion"] = local
	}
	if command == "plugin bundle" {
		result["files"] = bundle["files"]
	}
	return result, nil
}
