package backendgo

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func insecureTLSForTest() *tls.Config { return &tls.Config{InsecureSkipVerify: true} }

func startTestSyncServer(t *testing.T) (baseURL string, token string, stop func()) {
	t.Helper()
	dir := t.TempDir()
	cfg := &syncServerConfig{Host: "127.0.0.1", Port: 0, DataDir: dir, Token: "test-token-0123456789abcdef0123456789"}
	stopFn, addr, _, err := startSyncServer(cfg, "test", true)
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	return "https://" + addr, cfg.Token, func() { _ = stopFn() }
}

func syncTestClient(t *testing.T) *http.Client {
	t.Helper()
	transport := &http.Transport{TLSClientConfig: insecureTLSForTest()}
	return &http.Client{Transport: transport, Timeout: 10 * time.Second}
}

func syncTestRequest(t *testing.T, method, url, token string, body any) (*http.Response, []byte) {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := syncTestClient(t).Do(request)
	if err != nil {
		t.Fatalf("request %s %s: %v", method, url, err)
	}
	raw, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	return response, raw
}

// REQ-237：启动、公开 ping、令牌认证与项目同步 round-trip。
func TestSyncServerAuthAndRoundTrip(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()

	response, body := syncTestRequest(t, http.MethodGet, baseURL+"/api/ping", "", nil)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"ok":true`) {
		t.Fatalf("ping = %d %s", response.StatusCode, body)
	}

	// 未携带令牌 → 401 + 明确错误码（验收条件 3）。
	response, body = syncTestRequest(t, http.MethodGet, baseURL+"/api/info", "", nil)
	if response.StatusCode != http.StatusUnauthorized || !strings.Contains(string(body), "UNAUTHORIZED") {
		t.Fatalf("no-token info = %d %s", response.StatusCode, body)
	}
	// 错误令牌同样拒绝。
	response, _ = syncTestRequest(t, http.MethodGet, baseURL+"/api/info", "wrong-token-0123456789abcdef012345", nil)
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d", response.StatusCode)
	}

	response, body = syncTestRequest(t, http.MethodGet, baseURL+"/api/info", token, nil)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("authed info = %d %s", response.StatusCode, body)
	}

	project := map[string]any{"id": "proj-1", "name": "同步项目", "items": []any{map[string]any{"id": "i1", "body": "hello"}}}
	response, body = syncTestRequest(t, http.MethodPost, baseURL+"/api/sync/project", token, map[string]any{"projectId": "proj-1", "project": project})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("push = %d %s", response.StatusCode, body)
	}

	response, body = syncTestRequest(t, http.MethodGet, baseURL+"/api/sync/project?id=proj-1", token, nil)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "同步项目") {
		t.Fatalf("fetch = %d %s", response.StatusCode, body)
	}

	response, body = syncTestRequest(t, http.MethodPost, baseURL+"/api/sync/events", token, map[string]any{"projectId": "proj-1", "events": []string{"排期 2 条需求"}})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("events = %d %s", response.StatusCode, body)
	}

	response, body = syncTestRequest(t, http.MethodGet, baseURL+"/api/sync/projects", token, nil)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "proj-1") {
		t.Fatalf("projects = %d %s", response.StatusCode, body)
	}
}

// REQ-237：数据目录与客户端工作区隔离。
func TestSyncServerRejectsClientDataDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "workspace.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := syncPrepareConfig(map[string]string{"data-dir": dir}, "", true); err == nil || !strings.Contains(err.Error(), "独立的 --data-dir") {
		t.Fatalf("expected isolation error, got %v", err)
	}
}

// REQ-237：令牌校验规则与自动生成。
func TestSyncServerTokenRules(t *testing.T) {
	if _, err := syncPrepareConfig(map[string]string{"data-dir": t.TempDir(), "token": "short"}, "", true); err == nil {
		t.Fatal("short token should fail")
	}
	cfg, err := syncPrepareConfig(map[string]string{"data-dir": t.TempDir()}, filepath.Join(t.TempDir(), "server-config.json"), true)
	if err != nil {
		t.Fatal(err)
	}
	if !syncValidToken(cfg.Token) {
		t.Fatalf("generated token invalid: %q", cfg.Token)
	}
}

// REQ-238：自签 pin 模式首次连接 NEED_TRUST、确认后通过、指纹变化 CERT_CHANGED。
func TestSyncAgentTrustFlow(t *testing.T) {
	baseURL, token, stop := startTestSyncServer(t)
	defer stop()

	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(baseURL, "https://"))
	agent := map[string]any{"host": host, "port": portStr, "tlsMode": "pin"}

	client, pin, err := syncBuildClient(agent, syncServerSecret{Token: token})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// 首次连接（无指纹）：网络与令牌都已验证，但需要确认指纹。
	if _, err = syncAgentProbe(ctx, client, pin, baseURL, token, false); err == nil {
		t.Fatal("expected NEED_TRUST")
	} else {
		categorized, ok := err.(*syncCategorizedError)
		if !ok || categorized.Code != "NEED_TRUST" || categorized.Fingerprint == "" || categorized.Kind != "cert" {
			t.Fatalf("unexpected error: %+v", categorized)
		}
	}
	if pin.actual == "" {
		t.Fatal("fingerprint not captured")
	}
	// 信任该指纹后完整连接成功。
	client2, pin2, _ := syncBuildClient(agent, syncServerSecret{Token: token, Fingerprint: pin.actual})
	if _, err = syncAgentProbe(ctx, client2, pin2, baseURL, token, false); err != nil {
		t.Fatalf("trusted connect: %v", err)
	}
	// 错误令牌 → auth 分类。
	client3, pin3, _ := syncBuildClient(agent, syncServerSecret{Token: "wrong-token-0123456789abcdef012345", Fingerprint: pin.actual})
	if _, err = syncAgentProbe(ctx, client3, pin3, baseURL, "wrong-token-0123456789abcdef012345", false); err == nil {
		t.Fatal("expected auth error")
	} else if categorized := err.(*syncCategorizedError); categorized.Kind != "auth" {
		t.Fatalf("expected auth kind, got %+v", categorized)
	}
	// 指纹不匹配 → CERT_CHANGED 阻断。
	client4, pin4, _ := syncBuildClient(agent, syncServerSecret{Token: token, Fingerprint: strings.Repeat("ab", 32)})
	if _, err = syncAgentProbe(ctx, client4, pin4, baseURL, token, false); err == nil {
		t.Fatal("expected CERT_CHANGED")
	} else if categorized := err.(*syncCategorizedError); categorized.Code != "CERT_CHANGED" {
		t.Fatalf("expected CERT_CHANGED, got %+v", categorized)
	}
	// 不可达地址 → network 分类。
	client5, pin5, _ := syncBuildClient(map[string]any{"host": "127.0.0.1", "port": "1", "tlsMode": "pin"}, syncServerSecret{Token: token})
	if _, err = syncAgentProbe(ctx, client5, pin5, "https://127.0.0.1:1", token, false); err == nil {
		t.Fatal("expected network error")
	} else if categorized := err.(*syncCategorizedError); categorized.Kind != "network" {
		t.Fatalf("expected network kind, got %+v", categorized)
	}
}

// REQ-240：projectSync op 保存 / 解除关联，附件 dataUrl 不上传。
func TestProjectSyncOpAndPayload(t *testing.T) {
	service := NewWorkspaceService(t.TempDir())
	if _, err := service.Mutate(map[string]any{"op": "project", "name": "同步项目"}, nil); err != nil {
		t.Fatal(err)
	}
	record, err := service.Get()
	if err != nil {
		t.Fatal(err)
	}
	projectID := coreMap(coreList(coreMap(record["state"])["projects"])[0])["id"]
	if _, err = service.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": map[string]any{"id": "agent-1"}}, nil); err != nil {
		t.Fatal(err)
	}
	record, _ = service.Get()
	project := coreMap(coreList(coreMap(record["state"])["projects"])[0])
	if coreMap(project["serverAgent"])["id"] != "agent-1" {
		t.Fatalf("serverAgent not saved: %v", project["serverAgent"])
	}
	// 解除关联。
	if _, err = service.Mutate(map[string]any{"op": "projectSync", "project": projectID, "server": nil}, nil); err != nil {
		t.Fatal(err)
	}
	record, _ = service.Get()
	project = coreMap(coreList(coreMap(record["state"])["projects"])[0])
	if project["serverAgent"] != nil {
		t.Fatalf("serverAgent not cleared: %v", project["serverAgent"])
	}
	// payload 只包含 flow 字段且不包含本地路径 / dataUrl。
	project["dir"] = `C:\secret\path`
	project["items"] = []any{map[string]any{"id": "i1", "body": "b", "attachments": []any{map[string]any{"id": "a1", "label": "图片1", "name": "x.png", "dataUrl": "data:image/png;base64,AAAA"}}}}
	payload := syncFlowPayload(project)
	if _, exists := payload["dir"]; exists {
		t.Fatal("dir should not be uploaded")
	}
	items := coreList(payload["items"])
	if len(items) != 1 || strings.Contains(fmt.Sprint(items[0]), "dataUrl") || strings.Contains(fmt.Sprint(items[0]), "base64") {
		t.Fatalf("attachment dataUrl leaked: %v", items)
	}
}
