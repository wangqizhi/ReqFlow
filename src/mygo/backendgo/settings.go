package backendgo

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type AISettings struct {
	Provider       string `json:"provider"`
	URL            string `json:"url"`
	APIKey         string `json:"apiKey"`
	Format         string `json:"format"`
	Model          string `json:"model"`
	RequestLogging bool   `json:"requestLogging"`
}

func aiMap(value any) map[string]any { v, _ := value.(map[string]any); return v }
func aiString(value any) string      { s, _ := value.(string); return s }
func aiArray(value any) []any        { a, _ := value.([]any); return a }
func aiArg(args []any, index int) any {
	if index >= 0 && index < len(args) {
		return args[index]
	}
	return nil
}
func aiFailure(err error) map[string]any { return map[string]any{"ok": false, "error": err.Error()} }
func aiNumber(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		n, _ := v.Float64()
		return n
	}
	return 0
}

func ValidateAISettings(value any) (AISettings, error) {
	v := aiMap(value)
	s := AISettings{Format: "openai", RequestLogging: true}
	if v == nil {
		return s, errors.New("AI 设置无效")
	}
	for _, key := range []string{"provider", "url", "apiKey"} {
		if _, ok := v[key].(string); !ok {
			return s, errors.New("AI 设置无效")
		}
	}
	s.Provider, s.URL, s.APIKey = strings.TrimSpace(aiString(v["provider"])), strings.TrimSpace(aiString(v["url"])), strings.TrimSpace(aiString(v["apiKey"]))
	if value, ok := v["format"]; ok {
		if value != "openai" && value != "anthropic" {
			return s, errors.New("API 格式无效")
		}
		s.Format = aiString(value)
	}
	if value, ok := v["model"]; ok {
		if _, ok := value.(string); !ok {
			return s, errors.New("模型名称无效")
		}
		s.Model = strings.TrimSpace(aiString(value))
	}
	if value, ok := v["requestLogging"]; ok {
		enabled, ok := value.(bool)
		if !ok {
			return s, errors.New("请求日志设置无效")
		}
		s.RequestLogging = enabled
	}
	if s.URL != "" {
		u, err := url.Parse(s.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return s, errors.New("调用 URL 必须使用 HTTP 或 HTTPS")
		}
	}
	return s, nil
}

func aiReadJSON(path string, target any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal([]byte(strings.TrimPrefix(string(raw), "\ufeff")), target)
}

func aiWriteJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".reqflow-config-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func (b *Backend) electronKey() ([]byte, error) {
	paths := []string{os.Getenv("REQFLOW_ELECTRON_LOCAL_STATE"), filepath.Join(os.Getenv("APPDATA"), "ReqFlow", "Local State"), filepath.Join(os.Getenv("APPDATA"), "reqflow-desktop", "Local State"), filepath.Join(b.DataDir, "Local State"), filepath.Join(b.DataDir, "AppData", "Roaming", "ReqFlow", "Local State")}
	for _, path := range paths {
		if path == "" {
			continue
		}
		var state map[string]any
		if aiReadJSON(path, &state) != nil {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(aiString(aiMap(state["os_crypt"])["encrypted_key"]))
		if err != nil || len(raw) <= 5 || string(raw[:5]) != "DPAPI" {
			continue
		}
		key, err := aiDPAPI(raw[5:], false)
		if err == nil && len(key) == 32 {
			return key, nil
		}
	}
	return nil, errors.New("无法读取原版 ReqFlow 系统加密密钥，请使用同一 Windows 用户，或设置 REQFLOW_ELECTRON_LOCAL_STATE 指向原版 Local State；已有配置未修改")
}

func aiEncryptEnvelope(key []byte, value string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return append(append([]byte("v10"), nonce...), gcm.Seal(nil, nonce, []byte(value), nil)...), nil
}

func (b *Backend) decryptAIKey(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("AI 密钥密文无效")
	}
	const dpapiPrefix = "reqflow-dpapi-v1:"
	if strings.HasPrefix(string(raw), dpapiPrefix) {
		plain, err := aiDPAPI(raw[len(dpapiPrefix):], false)
		return string(plain), err
	}
	if len(raw) >= 3 && (string(raw[:3]) == "v10" || string(raw[:3]) == "v11") {
		if len(raw) < 31 {
			return "", errors.New("原版 ReqFlow AI 密钥密文无效")
		}
		key, err := b.electronKey()
		if err != nil {
			return "", err
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return "", err
		}
		gcm, err := cipher.NewGCM(block)
		if err != nil {
			return "", err
		}
		plain, err := gcm.Open(nil, raw[3:15], raw[15:], nil)
		if err != nil {
			return "", errors.New("原版 ReqFlow AI 密钥解密失败，请确认 Local State 属于该安装版本；已有配置未修改")
		}
		return string(plain), nil
	}
	if strings.HasPrefix(string(raw), "v20") {
		return "", errors.New("该 AI 密钥采用 Windows 应用绑定加密（v20），请在 MyGO 中重新输入 API Key")
	}
	plain, err := aiDPAPI(raw, false)
	return string(plain), err
}

func (b *Backend) readAISettings() (AISettings, error) {
	var stored map[string]any
	if err := aiReadJSON(filepath.Join(b.DataDir, "ai-settings.json"), &stored); err != nil {
		if os.IsNotExist(err) {
			return AISettings{Format: "openai", Model: "deepseek-flash", RequestLogging: true}, nil
		}
		return AISettings{}, errors.New("读取 AI 设置失败")
	}
	key, err := b.decryptAIKey(aiString(stored["encryptedKey"]))
	if err != nil {
		return AISettings{}, err
	}
	stored["apiKey"] = key
	for _, name := range []string{"provider", "url"} {
		if _, ok := stored[name]; !ok {
			stored[name] = ""
		}
	}
	return ValidateAISettings(stored)
}

func (b *Backend) saveAISettings(value any) (map[string]any, error) {
	s, err := ValidateAISettings(value)
	if err != nil {
		return nil, err
	}
	encoded := ""
	storage := "electron-v10"
	if s.APIKey != "" {
		var encrypted []byte
		if key, keyErr := b.electronKey(); keyErr == nil {
			encrypted, err = aiEncryptEnvelope(key, s.APIKey)
		} else {
			// Explicit save can create a new MyGO configuration without an Electron profile.
			// Existing v10/v11 keys are preserved in their format whenever that profile is available.
			storage = "dpapi-v1"
			encrypted, err = aiDPAPI([]byte(s.APIKey), true)
			encrypted = append([]byte("reqflow-dpapi-v1:"), encrypted...)
		}
		if err != nil {
			return nil, err
		}
		encoded = base64.StdEncoding.EncodeToString(encrypted)
	}
	stored := map[string]any{"provider": s.Provider, "url": s.URL, "format": s.Format, "model": s.Model, "requestLogging": s.RequestLogging, "encryptedKey": encoded}
	b.mu.Lock()
	defer b.mu.Unlock()
	if err = aiWriteJSON(filepath.Join(b.DataDir, "ai-settings.json"), stored); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "keyStorage": storage}, nil
}
