package backendgo

// 客户端 Server Agent 引擎（REQ-238/REQ-239/REQ-240）：
// - 服务端配置保存在数据目录 server-agents.json；访问令牌与证书指纹经 DPAPI 加密后
//   单独存放，不进入工作区导出与 Git 备份。
// - 信任模式：pin（自签证书 + 首次指纹确认，指纹变化阻断）/ ca（系统受信任 CA 证书）。
// - 连接测试按「网络不可达 / 证书不匹配 / 令牌无效」分类返回。
// - 项目关联 server agent 后，flow 每次变更自动推送服务端（本地保留一份）。

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
)

type syncServerAgentConfig struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	TLSMode     string `json:"tlsMode"`
	AutoConnect bool   `json:"autoConnect"`
}

type syncServerSecret struct {
	Token       string `json:"token,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

type syncAgentRuntime struct {
	mu      sync.Mutex
	clients map[string]*http.Client
}

var syncAgentRuntimes sync.Map

func (b *Backend) syncAgentRuntime() *syncAgentRuntime {
	if value, ok := syncAgentRuntimes.Load(b); ok {
		return value.(*syncAgentRuntime)
	}
	r := &syncAgentRuntime{clients: map[string]*http.Client{}}
	value, _ := syncAgentRuntimes.LoadOrStore(b, r)
	return value.(*syncAgentRuntime)
}

func (b *Backend) syncAgentsPath() string { return filepath.Join(b.DataDir, "server-agents.json") }
func (b *Backend) syncSecretsPath() string {
	return filepath.Join(b.DataDir, "server-agent-secrets.json")
}
func (b *Backend) syncStatusPath() string {
	return filepath.Join(b.DataDir, "server-agent-status.json")
}

var syncAgentHostPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:-]*$`)
var syncAgentIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)

func (b *Backend) syncReadAgents() ([]map[string]any, error) {
	var stored map[string]any
	if err := aiReadJSON(b.syncAgentsPath(), &stored); err != nil {
		if os.IsNotExist(err) {
			return []map[string]any{}, nil
		}
		return nil, errors.New("服务端配置读取失败：" + err.Error())
	}
	servers := []map[string]any{}
	for _, value := range aiArray(stored["servers"]) {
		if entry := aiMap(value); entry != nil {
			servers = append(servers, entry)
		}
	}
	return servers, nil
}

func (b *Backend) syncWriteAgents(servers []map[string]any) error {
	return aiWriteJSON(b.syncAgentsPath(), map[string]any{"v": 1, "servers": servers})
}

// syncReadSecrets / syncWriteSecrets：令牌与指纹整体 DPAPI 加密（REQ-238）。
func (b *Backend) syncReadSecrets() (map[string]syncServerSecret, error) {
	var stored map[string]any
	if err := aiReadJSON(b.syncSecretsPath(), &stored); err != nil {
		if os.IsNotExist(err) {
			return map[string]syncServerSecret{}, nil
		}
		return nil, errors.New("服务端凭据读取失败：" + err.Error())
	}
	raw, err := base64.StdEncoding.DecodeString(aiString(stored["blob"]))
	if err != nil || len(raw) == 0 {
		return map[string]syncServerSecret{}, nil
	}
	plain, err := aiDPAPI(raw, false)
	if err != nil {
		return nil, errors.New("服务端凭据解密失败：请在原 Windows 用户下打开 ReqFlow")
	}
	var parsed map[string]syncServerSecret
	if err = json.Unmarshal(plain, &parsed); err != nil {
		return nil, errors.New("服务端凭据数据无效")
	}
	if parsed == nil {
		parsed = map[string]syncServerSecret{}
	}
	return parsed, nil
}

func (b *Backend) syncWriteSecrets(secrets map[string]syncServerSecret) error {
	if secrets == nil {
		secrets = map[string]syncServerSecret{}
	}
	raw, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	encrypted, err := aiDPAPI(raw, true)
	if err != nil {
		return err
	}
	return aiWriteJSON(b.syncSecretsPath(), map[string]any{"v": 1, "blob": base64.StdEncoding.EncodeToString(encrypted)})
}

func (b *Backend) syncReadStatus() map[string]map[string]any {
	var stored map[string]map[string]any
	if err := aiReadJSON(b.syncStatusPath(), &stored); err != nil || stored == nil {
		return map[string]map[string]any{}
	}
	return stored
}

func (b *Backend) syncWriteStatus(status map[string]map[string]any) {
	if status == nil {
		status = map[string]map[string]any{}
	}
	_ = aiWriteJSON(b.syncStatusPath(), status)
}

func (b *Backend) syncUpdateStatus(id string, patch map[string]any) {
	b.mu.Lock()
	defer b.mu.Unlock()
	status := b.syncReadStatus()
	current := status[id]
	if current == nil {
		current = map[string]any{}
	}
	for key, value := range patch {
		if value == nil {
			delete(current, key)
		} else {
			current[key] = value
		}
	}
	status[id] = current
	b.syncWriteStatus(status)
}

func syncValidateAgent(value any) (map[string]any, error) {
	v := aiMap(value)
	id := strings.TrimSpace(aiString(v["id"]))
	name := strings.TrimSpace(aiString(v["name"]))
	host := strings.TrimSpace(aiString(v["host"]))
	port := int(aiNumber(v["port"]))
	tlsMode := aiString(v["tlsMode"])
	if id == "" {
		id = coreUUID()
	}
	if !syncAgentIDPattern.MatchString(id) {
		return nil, errors.New("服务端配置 ID 无效")
	}
	if name == "" {
		return nil, errors.New("请填写服务端名称")
	}
	if host == "" || (!syncAgentHostPattern.MatchString(host) && net.ParseIP(host) == nil) {
		return nil, errors.New("服务端地址须为主机名或 IP")
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("端口须为 1-65535")
	}
	if tlsMode == "" {
		tlsMode = "pin"
	}
	if tlsMode != "pin" && tlsMode != "ca" {
		return nil, errors.New("证书模式须为「自签 + 指纹确认」或「受信任 CA」")
	}
	return map[string]any{"id": id, "name": name, "host": host, "port": int64(port), "tlsMode": tlsMode, "autoConnect": v["autoConnect"] == true}, nil
}

// ---- 连接与信任（REQ-238） ----

type syncCategorizedError struct {
	Kind        string `json:"kind"`
	Code        string `json:"code"`
	Message     string `json:"message"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

func (e *syncCategorizedError) Error() string { return e.Message }

func syncNetworkError(err error) *syncCategorizedError {
	return &syncCategorizedError{Kind: "network", Code: "NETWORK", Message: err.Error()}
}

type syncPinDialer struct {
	expected string
	actual   string
}

func (d *syncPinDialer) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	raw, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, syncNetworkError(fmt.Errorf("无法连接 %s：DNS 解析失败或端口不可达", addr))
	}
	host, _, _ := net.SplitHostPort(addr)
	conn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: host, MinVersion: tls.VersionTLS12})
	if err = conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, syncNetworkError(fmt.Errorf("TLS 握手失败：%v", err))
	}
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		_ = conn.Close()
		return nil, &syncCategorizedError{Kind: "cert", Code: "CERT_MISSING", Message: "服务端未提供证书"}
	}
	digest := sha256.Sum256(certs[0].Raw)
	d.actual = hex.EncodeToString(digest[:])
	// 已信任的服务端指纹变化时阻断连接，要求人工确认（防中间人）。
	if d.expected != "" && d.actual != d.expected {
		_ = conn.Close()
		return nil, &syncCategorizedError{Kind: "cert", Code: "CERT_CHANGED", Message: "服务端证书已变更，为防中间人攻击已阻断连接；请确认是否信任新证书", Fingerprint: d.actual}
	}
	return conn, nil
}

// syncBuildClient 组装带信任校验的 HTTP 客户端；pin 模式返回指纹探测器。
func syncBuildClient(agent map[string]any, secret syncServerSecret) (*http.Client, *syncPinDialer, error) {
	tlsMode := aiString(agent["tlsMode"])
	// Server Agents use an explicit endpoint and certificate pinning. Connect
	// directly so an inherited desktop proxy cannot intercept the TLS handshake.
	transport := &http.Transport{}
	var pin *syncPinDialer
	if tlsMode == "ca" {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		pin = &syncPinDialer{expected: secret.Fingerprint}
		transport.DialTLSContext = pin.dial
	}
	return &http.Client{Transport: transport, Timeout: 30 * time.Second}, pin, nil
}

func syncAgentBaseURL(agent map[string]any) string {
	return "https://" + net.JoinHostPort(aiString(agent["host"]), fmt.Sprint(int(aiNumber(agent["port"]))))
}

// syncClassifyRequest 把请求错误映射为三类失败原因（REQ-238 验收）。
func syncClassifyRequest(err error) *syncCategorizedError {
	var categorized *syncCategorizedError
	if errors.As(err, &categorized) {
		return categorized
	}
	message := err.Error()
	if strings.Contains(message, "x509:") || strings.Contains(strings.ToLower(message), "certificate") || strings.Contains(strings.ToLower(message), "tls") {
		return &syncCategorizedError{Kind: "cert", Code: "CERT_INVALID", Message: "证书校验失败：" + message}
	}
	return syncNetworkError(errors.New(message))
}

// syncAgentProbe 完整走一遍连接检查：网络可达 → 证书信任 → 令牌有效。
// onlyNetwork 为 true 时只做 ping（不携带令牌），用于纯网络诊断。
func syncAgentProbe(ctx context.Context, client *http.Client, pin *syncPinDialer, baseURL, token string, onlyNetwork bool) (fingerprint string, err error) {
	request, e := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/ping", nil)
	if e != nil {
		return "", syncNetworkError(e)
	}
	response, e := client.Do(request)
	if e != nil {
		return "", syncClassifyRequest(e)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", &syncCategorizedError{Kind: "network", Code: "NOT_REQFLOW", Message: fmt.Sprintf("端口可达但不是 ReqFlow 同步服务端（HTTP %d）", response.StatusCode)}
	}
	if pin != nil {
		if pin.expected == "" {
			return pin.actual, &syncCategorizedError{Kind: "cert", Code: "NEED_TRUST", Message: "首次连接需确认服务端证书指纹后建立信任", Fingerprint: pin.actual}
		}
		fingerprint = pin.actual
	}
	if onlyNetwork {
		return fingerprint, nil
	}
	request, e = http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/info", nil)
	if e != nil {
		return "", syncNetworkError(e)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, e = client.Do(request)
	if e != nil {
		return "", syncClassifyRequest(e)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return "", &syncCategorizedError{Kind: "auth", Code: "UNAUTHORIZED", Message: "访问令牌无效或已轮换，请更新令牌"}
	}
	if response.StatusCode != http.StatusOK {
		return "", &syncCategorizedError{Kind: "network", Code: "BAD_RESPONSE", Message: fmt.Sprintf("服务端响应异常（HTTP %d）", response.StatusCode)}
	}
	return fingerprint, nil
}

func (b *Backend) syncAgentConfig(id string) (map[string]any, syncServerSecret, error) {
	servers, err := b.syncReadAgents()
	if err != nil {
		return nil, syncServerSecret{}, err
	}
	for _, server := range servers {
		if aiString(server["id"]) == id {
			secrets, err := b.syncReadSecrets()
			if err != nil {
				return nil, syncServerSecret{}, err
			}
			return server, secrets[id], nil
		}
	}
	return nil, syncServerSecret{}, errors.New("服务端配置不存在")
}

// syncConnect 建立连接：网络 → 证书 → 令牌逐级校验，成功后推送关联项目。
func (b *Backend) syncConnect(id string, quiet bool) (map[string]any, error) {
	agent, secret, err := b.syncAgentConfig(id)
	if err != nil {
		return nil, err
	}
	client, pin, err := syncBuildClient(agent, secret)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	fingerprint, err := syncAgentProbe(ctx, client, pin, syncAgentBaseURL(agent), secret.Token, false)
	if err != nil {
		var categorized *syncCategorizedError
		if errors.As(err, &categorized) {
			state := "disconnected"
			if categorized.Code == "NEED_TRUST" {
				state = "need_trust"
			} else if categorized.Kind == "cert" {
				state = "cert_error"
			}
			b.syncUpdateStatus(id, map[string]any{"state": state, "error": categorized.Message, "kind": categorized.Kind, "code": categorized.Code})
			if !quiet {
				return map[string]any{"ok": false, "code": categorized.Code, "kind": categorized.Kind, "error": categorized.Message, "fingerprint": categorized.Fingerprint}, nil
			}
			return nil, err
		}
		b.syncUpdateStatus(id, map[string]any{"state": "disconnected", "error": err.Error(), "kind": "network"})
		if !quiet {
			return map[string]any{"ok": false, "code": "NETWORK", "kind": "network", "error": err.Error()}, nil
		}
		return nil, err
	}
	runtime := b.syncAgentRuntime()
	runtime.mu.Lock()
	runtime.clients[id] = client
	runtime.mu.Unlock()
	b.syncUpdateStatus(id, map[string]any{"state": "connected", "error": nil, "kind": nil, "code": nil, "lastConnectedAt": time.Now().UTC().Format(time.RFC3339Nano), "fingerprint": fingerprint, "errorAt": nil})
	if !quiet {
		b.syncPushAssociated(id)
	}
	return map[string]any{"ok": true, "fingerprint": fingerprint}, nil
}

func (b *Backend) syncClient(id string) *http.Client {
	runtime := b.syncAgentRuntime()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.clients[id]
}

func (b *Backend) syncDisconnect(id string) {
	runtime := b.syncAgentRuntime()
	runtime.mu.Lock()
	delete(runtime.clients, id)
	runtime.mu.Unlock()
	b.syncUpdateStatus(id, map[string]any{"state": "disconnected", "error": nil, "kind": nil, "code": nil})
}

// syncTrust 确认当前证书指纹（首次信任或证书变更后重新确认）。
func (b *Backend) syncTrust(id string) (map[string]any, error) {
	agent, secret, err := b.syncAgentConfig(id)
	if err != nil {
		return nil, err
	}
	client, pin, err := syncBuildClient(agent, syncServerSecret{Token: secret.Token})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err = syncAgentProbe(ctx, client, pin, syncAgentBaseURL(agent), secret.Token, true); err != nil {
		var categorized *syncCategorizedError
		if !errors.As(err, &categorized) || pin.actual == "" {
			return nil, err
		}
	}
	if pin.actual == "" {
		return nil, errors.New("未能获取服务端证书指纹")
	}
	secrets, err := b.syncReadSecrets()
	if err != nil {
		return nil, err
	}
	entry := secrets[id]
	entry.Fingerprint = pin.actual
	secrets[id] = entry
	if err = b.syncWriteSecrets(secrets); err != nil {
		return nil, err
	}
	b.syncUpdateStatus(id, map[string]any{"state": "disconnected", "error": nil, "kind": nil, "code": nil, "fingerprint": pin.actual})
	return map[string]any{"ok": true, "fingerprint": pin.actual}, nil
}

func (b *Backend) syncResetTrust(id string) (map[string]any, error) {
	if _, _, err := b.syncAgentConfig(id); err != nil {
		return nil, err
	}
	secrets, err := b.syncReadSecrets()
	if err != nil {
		return nil, err
	}
	entry := secrets[id]
	entry.Fingerprint = ""
	secrets[id] = entry
	if err = b.syncWriteSecrets(secrets); err != nil {
		return nil, err
	}
	b.syncDisconnect(id)
	b.syncUpdateStatus(id, map[string]any{"state": "need_trust", "fingerprint": ""})
	return map[string]any{"ok": true}, nil
}

// ---- 项目 flow 同步（REQ-240） ----

// syncFlowPayload 仅提取 flow 相关数据；本地路径、发布、草稿与验证源不上传。
func syncFlowPayload(project map[string]any) map[string]any {
	payload := map[string]any{}
	for _, key := range []string{"id", "name", "description", "guidance", "guideVersion", "guideHistory", "deliveryGuidance", "aiValidation", "items", "batches", "nextNumber"} {
		if value, ok := project[key]; ok {
			payload[key] = value
		}
	}
	items := []any{}
	for _, value := range coreList(payload["items"]) {
		item := coreMap(coreCloneAny(value))
		if attachments := coreList(item["attachments"]); len(attachments) > 0 {
			light := []any{}
			for _, attachment := range attachments {
				a := coreMap(attachment)
				light = append(light, map[string]any{"id": a["id"], "label": a["label"], "name": a["name"]})
			}
			item["attachments"] = light
		}
		delete(item, "requirementDraft")
		items = append(items, item)
	}
	payload["items"] = items
	return payload
}

func coreCloneAny(value any) any {
	raw, _ := json.Marshal(value)
	var next any
	_ = json.Unmarshal(raw, &next)
	return next
}

func (b *Backend) syncServerClientForProject(projectID string) (string, *http.Client, error) {
	project, err := b.desktopProject(projectID)
	if err != nil {
		return "", nil, err
	}
	agent := coreMap(project["serverAgent"])
	serverID := aiString(agent["id"])
	if serverID == "" {
		return "", nil, errors.New("项目未关联 Server Agent")
	}
	client := b.syncClient(serverID)
	if client == nil {
		return "", nil, errors.New("服务端未连接，请先在设置 → Server Agent 中连接")
	}
	return serverID, client, nil
}

// syncPushProject 把项目 flow 快照与本次步骤推送至服务端；本地数据保持不变。
func (b *Backend) syncPushProject(projectID, reason string) (map[string]any, error) {
	project, err := b.desktopProject(projectID)
	if err != nil {
		return nil, err
	}
	agent := coreMap(project["serverAgent"])
	serverID := aiString(agent["id"])
	if serverID == "" {
		return nil, errors.New("项目未关联 Server Agent")
	}
	client := b.syncClient(serverID)
	if client == nil {
		// 自动同步路径：autoConnect 的服务端尝试静默重连一次。
		config, _, cerr := b.syncAgentConfig(serverID)
		if cerr != nil || config["autoConnect"] != true {
			return nil, errors.New("服务端未连接，请先在设置 → Server Agent 中连接")
		}
		if _, cerr = b.syncConnect(serverID, true); cerr != nil {
			b.syncUpdateStatus(serverID, map[string]any{"state": "disconnected", "error": cerr.Error(), "kind": "network"})
			return nil, errors.New("服务端连接失败：" + cerr.Error())
		}
		client = b.syncClient(serverID)
		if client == nil {
			return nil, errors.New("服务端未连接")
		}
	}
	agentConfig, secret, err := b.syncAgentConfig(serverID)
	if err != nil {
		return nil, err
	}
	baseURL := syncAgentBaseURL(agentConfig)
	body, _ := json.Marshal(map[string]any{"projectId": projectID, "project": syncFlowPayload(project)})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/sync/project", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+secret.Token)
	response, err := client.Do(request)
	if err != nil {
		b.syncDisconnect(serverID)
		return nil, syncClassifyRequest(err)
	}
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, &syncCategorizedError{Kind: map[int]string{http.StatusUnauthorized: "auth"}[response.StatusCode], Code: fmt.Sprintf("HTTP_%d", response.StatusCode), Message: fmt.Sprintf("推送失败（HTTP %d）：%s", response.StatusCode, syncResponseError(raw))}
	}
	var pushed struct {
		Revision  int64  `json:"revision"`
		UpdatedAt string `json:"updatedAt"`
	}
	_ = json.Unmarshal(raw, &pushed)
	event := strings.TrimSpace(reason)
	if event == "" {
		event = "推送 flow 快照"
	}
	events, _ := json.Marshal(map[string]any{"projectId": projectID, "events": []string{event + " · rev " + fmt.Sprint(pushed.Revision)}})
	request, err = http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/api/sync/events", bytes.NewReader(events))
	if err == nil {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+secret.Token)
		if response, err = client.Do(request); err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	b.mu.Lock()
	status := b.syncReadStatus()
	entry := status[serverID]
	if entry == nil {
		entry = map[string]any{}
	}
	syncs := aiMap(entry["lastSync"])
	if syncs == nil {
		syncs = map[string]any{}
	}
	syncs[projectID] = now
	entry["lastSync"] = syncs
	entry["lastSyncError"] = nil
	status[serverID] = entry
	b.syncWriteStatus(status)
	b.mu.Unlock()
	return map[string]any{"ok": true, "revision": pushed.Revision, "updatedAt": pushed.UpdatedAt, "syncedAt": now}, nil
}

func syncResponseError(raw []byte) string {
	var parsed map[string]any
	if json.Unmarshal(raw, &parsed) == nil {
		if message := aiString(parsed["error"]); message != "" {
			return message
		}
	}
	return strings.TrimSpace(string(raw))
}

// syncPullProject 用服务端数据覆盖本地 flow 字段；本地目录、发布与草稿设置保留。
func (b *Backend) syncPullProject(projectID string) (map[string]any, error) {
	serverID, client, err := b.syncServerClientForProject(projectID)
	if err != nil {
		return nil, err
	}
	agentConfig, secret, err := b.syncAgentConfig(serverID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, syncAgentBaseURL(agentConfig)+"/api/sync/project?id="+url.QueryEscape(projectID), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+secret.Token)
	response, err := client.Do(request)
	if err != nil {
		return nil, syncClassifyRequest(err)
	}
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	_ = response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, errors.New("服务端还没有该项目数据，请先推送一次")
	}
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("拉取失败（HTTP " + fmt.Sprint(response.StatusCode) + "）：" + syncResponseError(raw))
	}
	var fetched struct {
		Project  map[string]any `json:"project"`
		Revision int64          `json:"revision"`
	}
	if err = json.Unmarshal(raw, &fetched); err != nil || fetched.Project == nil {
		return nil, errors.New("服务端项目数据无效")
	}
	record, err := b.Workspace.Get()
	if err != nil {
		return nil, err
	}
	state := coreMap(coreCloneAny(record["state"]))
	found := false
	for _, value := range coreList(state["projects"]) {
		project := coreMap(value)
		if aiString(project["id"]) != projectID {
			continue
		}
		found = true
		for _, key := range []string{"name", "description", "guidance", "guideVersion", "guideHistory", "deliveryGuidance", "aiValidation", "items", "batches", "nextNumber"} {
			if serverValue, ok := fetched.Project[key]; ok {
				project[key] = serverValue
			} else {
				delete(project, key)
			}
		}
	}
	if !found {
		return nil, errors.New("本地项目不存在")
	}
	if _, err = b.Workspace.WriteState(state, int64(aiNumber(record["version"]))); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "revision": fetched.Revision, "items": len(coreList(fetched.Project["items"]))}, nil
}

// syncAssociatedProjects 返回关联到指定服务端的全部项目 ID。
func (b *Backend) syncAssociatedProjects(serverID string) []string {
	record, err := b.Workspace.Get()
	if err != nil {
		return nil
	}
	ids := []string{}
	for _, value := range coreList(coreMap(record["state"])["projects"]) {
		project := coreMap(value)
		if aiString(coreMap(project["serverAgent"])["id"]) == serverID {
			ids = append(ids, aiString(project["id"]))
		}
	}
	return ids
}

func (b *Backend) syncPushAssociated(serverID string) {
	for _, projectID := range b.syncAssociatedProjects(serverID) {
		if _, err := b.syncPushProject(projectID, "连接后自动同步"); err != nil {
			b.mu.Lock()
			status := b.syncReadStatus()
			if entry := status[serverID]; entry != nil {
				entry["lastSyncError"] = err.Error()
				status[serverID] = entry
				b.syncWriteStatus(status)
			}
			b.mu.Unlock()
		}
	}
}

// syncAfterMutate：工作区每次成功变更后，自动推送受影响且已关联的项目（REQ-240）。
func (b *Backend) syncAfterMutate(projectIDs []string, op string) {
	for _, projectID := range projectIDs {
		project, err := b.desktopProject(projectID)
		if err != nil || aiString(coreMap(project["serverAgent"])["id"]) == "" {
			continue
		}
		go func(id string) {
			if _, err := b.syncPushProject(id, "本地变更自动推送："+op); err != nil {
				agent, _, cerr := b.syncAgentConfig(id)
				if cerr != nil {
					return
				}
				serverID := aiString(coreMap(agent["serverAgent"])["id"])
				b.mu.Lock()
				status := b.syncReadStatus()
				if entry := status[serverID]; entry != nil {
					entry["lastSyncError"] = err.Error()
					status[serverID] = entry
					b.syncWriteStatus(status)
				}
				b.mu.Unlock()
			}
		}(projectID)
	}
}

// StartServerAgents 开机自动连接（REQ-239）并定期同步；StopServerAgents 停止。
func (b *Backend) StartServerAgents() {
	servers, err := b.syncReadAgents()
	if err != nil {
		return
	}
	auto := []string{}
	for _, server := range servers {
		if server["autoConnect"] == true {
			auto = append(auto, aiString(server["id"]))
		}
	}
	if len(auto) == 0 {
		return
	}
	go func() {
		for _, id := range auto {
			_, _ = b.syncConnect(id, true)
		}
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			servers, err := b.syncReadAgents()
			if err != nil {
				continue
			}
			for _, server := range servers {
				if server["autoConnect"] != true {
					continue
				}
				id := aiString(server["id"])
				if b.syncClient(id) != nil {
					b.syncPushAssociated(id)
					continue
				}
				_, _ = b.syncConnect(id, true)
			}
		}
	}()
}

func (b *Backend) StopServerAgents() {}

// ---- SSH 自动安装（REQ-239：免密登录的服务器） ----

func (b *Backend) syncAgentInstall(args []any) (map[string]any, error) {
	input := aiMap(aiArg(args, 0))
	target := strings.TrimSpace(aiString(input["ssh"]))
	port := int(aiNumber(input["port"]))
	dataDir := strings.TrimSpace(aiString(input["dataDir"]))
	if dataDir == "" {
		dataDir = "~/reqflow-server/data"
	}
	name := strings.TrimSpace(aiString(input["name"]))
	if name == "" {
		name = "ReqFlow Server"
	}
	if target == "" {
		return nil, errors.New("请填写免密 SSH 目标，如 user@nas.lan 或 user@nas.lan:22")
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("服务端监听端口须为 1-65535")
	}
	if !syncCommandExists("ssh") {
		return nil, errors.New("未找到本机 ssh 命令，无法自动安装")
	}
	remote, err := parseSSHRoot("ssh://" + strings.ReplaceAll(target, "#", "%23") + "/./")
	if err != nil {
		return nil, errors.New("SSH 目标无效：" + err.Error())
	}
	sshTarget := remote.Hostname()
	sshArgs := []string{"-oBatchMode=yes", "-oPreferredAuthentications=publickey", "-oPasswordAuthentication=no", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10"}
	if remote.Port() != "" {
		sshArgs = append(sshArgs, "-p", remote.Port())
	}
	if remote.User != nil {
		sshArgs = append(sshArgs, "-l", remote.User.Username())
	}
	run := func(script string, timeout time.Duration) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		args := append(append([]string{}, sshArgs...), "--", sshTarget, script)
		output, _, err := desktopRun(ctx, "ssh", args, "", timeout)
		return strings.TrimSpace(output), err
	}
	info, err := run("uname -s && uname -m", 20*time.Second)
	if err != nil {
		return nil, errors.New("SSH 连接或命令执行失败（请确认已配置免密登录与 known_hosts）：" + err.Error())
	}
	parts := strings.Fields(info)
	if len(parts) < 2 {
		return nil, errors.New("无法识别远程系统：" + info)
	}
	system, machine := parts[0], parts[1]
	if system != "Linux" {
		return nil, errors.New("自动安装目前支持 Linux 服务器（检测到 " + system + "）；其他系统请手动部署 reqflow-server")
	}
	arch := ""
	switch machine {
	case "x86_64", "amd64":
		arch = "amd64"
	case "aarch64", "arm64":
		arch = "arm64"
	}
	if arch == "" {
		return nil, errors.New("暂不支持的服务器架构：" + machine)
	}
	localBinary := filepath.Join(b.AppDir, "reqflow-server-linux-"+arch)
	if !coreExists(localBinary) {
		return nil, errors.New("安装包内缺少 reqflow-server-linux-" + arch + "，请重新安装 ReqFlow 或从发布目录获取该文件")
	}
	home, err := run("echo $HOME", 15*time.Second)
	if err != nil || home == "" {
		return nil, errors.New("无法确定远程主目录")
	}
	remoteDir := path.Join(home, "reqflow-server")
	token, err := syncGenerateToken()
	if err != nil {
		return nil, err
	}
	config := map[string]any{"host": "0.0.0.0", "port": port, "dataDir": path.Join(remoteDir, "data"), "token": token}
	configRaw, _ := json.Marshal(config)
	if _, err = run("mkdir -p "+syncShellQuote(remoteDir+"/data"), 15*time.Second); err != nil {
		return nil, errors.New("创建远程目录失败：" + err.Error())
	}
	if err = b.syncUploadOverSSH(remote.String(), configRaw, localBinary); err != nil {
		return nil, err
	}
	if _, err = run("chmod +x "+syncShellQuote(remoteDir+"/reqflow-server"), 15*time.Second); err != nil {
		return nil, errors.New("设置执行权限失败：" + err.Error())
	}
	startCommand := syncShellQuote(remoteDir+"/reqflow-server") + " server run --config " + syncShellQuote(remoteDir+"/server-config.json")
	summary := []string{}
	unit := syncAgentSystemdUnit(remoteDir)
	unitPath := path.Join(home, ".config/systemd/user/reqflow-server.service")
	installService := "mkdir -p " + syncShellQuote(path.Dir(unitPath)) + " && printf '%s' " + syncShellQuote(unit) + " > " + syncShellQuote(unitPath) + " && systemctl --user daemon-reload && systemctl --user enable reqflow-server && systemctl --user restart reqflow-server"
	if _, err = run(installService, 20*time.Second); err == nil {
		summary = append(summary, "已启用并启动 systemd 用户服务")
	} else {
		background := startCommand + " >> " + syncShellQuote(remoteDir+"/server.log") + " 2>&1"
		cronLine := "@reboot " + background
		if _, cronErr := run("(crontab -l 2>/dev/null | grep -v 'reqflow-server.*run --config'; printf '%s\\n' "+syncShellQuote(cronLine)+") | crontab -", 15*time.Second); cronErr == nil {
			summary = append(summary, "已添加 crontab @reboot 开机自启")
		} else {
			summary = append(summary, "无法配置开机自启，请手动配置："+startCommand)
		}
		if _, err = run("nohup "+background+" < /dev/null &", 15*time.Second); err != nil {
			return nil, errors.New("服务端启动命令失败：" + err.Error())
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err = syncWaitForAgent(ctx, map[string]any{"host": sshTarget, "port": int64(port), "tlsMode": "pin"}); err != nil {
		return nil, fmt.Errorf("服务端文件已上传，但 HTTPS 健康检查失败，请检查服务状态、%d 端口放行及 systemd 日志或 %s/server.log：%w", port, remoteDir, err)
	}
	summary = append(summary, "HTTPS 健康检查通过")
	return map[string]any{
		"ok": true, "name": name, "host": sshTarget, "port": int64(port), "token": token,
		"dataDir": path.Join(remoteDir, "data"), "summary": strings.Join(summary, "；"),
	}, nil
}

func syncShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func syncAgentSystemdUnit(remoteDir string) string {
	// systemd parses ExecStart itself; shell redirection is not supported here.
	quote := func(value string) string {
		return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`).Replace(value) + `"`
	}
	return "[Unit]\nDescription=ReqFlow Server Agent\nAfter=network-online.target\n\n[Service]\nExecStart=" + quote(remoteDir+"/reqflow-server") + " server run --config " + quote(remoteDir+"/server-config.json") + "\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
}

func syncWaitForAgent(ctx context.Context, agent map[string]any) error {
	client, pin, err := syncBuildClient(agent, syncServerSecret{})
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	for {
		_, err = syncAgentProbe(ctx, client, pin, syncAgentBaseURL(agent), "", true)
		var categorized *syncCategorizedError
		if err == nil || (errors.As(err, &categorized) && categorized.Code == "NEED_TRUST") {
			return nil
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// syncUploadOverSSH 通过现有 SFTP 通道上传二进制与配置文件。
func (b *Backend) syncUploadOverSSH(root string, configRaw []byte, localBinary string) error {
	raw, err := os.ReadFile(localBinary)
	if err != nil {
		return errors.New("读取本地 reqflow-server 失败：" + err.Error())
	}
	_, err = withSFTP(context.Background(), root, func(c *sftp.Client, u *url.URL) (any, error) {
		base := strings.TrimSuffix(u.Path, "/./")
		if base == "" {
			base = "."
		}
		real, err := c.RealPath(base)
		if err != nil {
			return nil, err
		}
		remoteDir := path.Join(real, "reqflow-server")
		if err = c.MkdirAll(remoteDir); err != nil {
			return nil, err
		}
		if err = c.MkdirAll(path.Join(remoteDir, "data")); err != nil {
			return nil, err
		}
		upload := func(name string, data []byte, mode os.FileMode) error {
			return syncUploadAgentFile(c, path.Join(remoteDir, name), data, mode)
		}
		if err = upload("reqflow-server", raw, 0o755); err != nil {
			return nil, errors.New("上传 reqflow-server 失败：" + err.Error())
		}
		if err = upload("server-config.json", configRaw, 0o600); err != nil {
			return nil, errors.New("上传配置失败：" + err.Error())
		}
		return nil, nil
	})
	return err
}

func syncUploadAgentFile(c *sftp.Client, target string, data []byte, mode os.FileMode) error {
	// Linux refuses to truncate a running executable. Upload beside it and
	// replace the directory entry only after all bytes and permissions are ready.
	temporary := target + "." + coreUUID() + ".tmp"
	defer c.Remove(temporary)
	file, err := c.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err = c.Chmod(temporary, mode); err != nil {
		return err
	}
	if _, supported := c.HasExtension("posix-rename@openssh.com"); supported {
		return c.PosixRename(temporary, target)
	}
	return c.Rename(temporary, target)
}

// ---- 通道分发 ----

func (b *Backend) invokeServerAgents(channel string, args []any) (any, error) {
	switch channel {
	case "server:agents:get":
		servers, err := b.syncReadAgents()
		if err != nil {
			return nil, err
		}
		secrets, err := b.syncReadSecrets()
		if err != nil {
			return nil, err
		}
		status := b.syncReadStatus()
		list := []map[string]any{}
		for _, server := range servers {
			id := aiString(server["id"])
			entry := map[string]any{"id": id, "name": server["name"], "host": server["host"], "port": server["port"], "tlsMode": aiString(server["tlsMode"]), "autoConnect": server["autoConnect"] == true}
			secret := secrets[id]
			entry["hasToken"] = secret.Token != ""
			entry["trusted"] = secret.Fingerprint != ""
			entry["fingerprint"] = secret.Fingerprint
			entry["status"] = status[id]
			list = append(list, entry)
		}
		return desktopOK(map[string]any{"servers": list}), nil
	case "server:agents:save":
		config, err := syncValidateAgent(aiArg(args, 0))
		if err != nil {
			return nil, err
		}
		input := aiMap(aiArg(args, 0))
		id := aiString(config["id"])
		servers, err := b.syncReadAgents()
		if err != nil {
			return nil, err
		}
		previous := map[string]any{}
		next := []map[string]any{}
		for _, server := range servers {
			if aiString(server["id"]) == id {
				previous = server
				continue
			}
			next = append(next, server)
		}
		identityChanged := previous != nil && (aiString(previous["host"]) != aiString(config["host"]) || int(aiNumber(previous["port"])) != int(aiNumber(config["port"])) || aiString(previous["tlsMode"]) != aiString(config["tlsMode"]))
		next = append(next, config)
		if err = b.syncWriteAgents(next); err != nil {
			return nil, err
		}
		secrets, err := b.syncReadSecrets()
		if err != nil {
			return nil, err
		}
		entry := secrets[id]
		if token := strings.TrimSpace(aiString(input["token"])); token != "" {
			if !syncValidToken(token) {
				return nil, errors.New("访问令牌须为 16-128 位字母、数字、- 或 _")
			}
			entry.Token = token
		}
		if identityChanged {
			// 地址或证书模式变化后指纹需要重新确认。
			entry.Fingerprint = ""
			b.syncDisconnect(id)
			b.syncUpdateStatus(id, map[string]any{"state": "need_trust", "error": nil, "kind": nil, "code": nil})
		}
		secrets[id] = entry
		if err = b.syncWriteSecrets(secrets); err != nil {
			return nil, err
		}
		return desktopOK(map[string]any{"id": id, "trusted": entry.Fingerprint != "", "hasToken": entry.Token != ""}), nil
	case "server:agents:delete":
		id := aiString(aiArg(args, 0))
		servers, err := b.syncReadAgents()
		if err != nil {
			return nil, err
		}
		next := []map[string]any{}
		for _, server := range servers {
			if aiString(server["id"]) != id {
				next = append(next, server)
			}
		}
		if len(next) == len(servers) {
			return nil, errors.New("服务端配置不存在")
		}
		if err = b.syncWriteAgents(next); err != nil {
			return nil, err
		}
		secrets, _ := b.syncReadSecrets()
		delete(secrets, id)
		if err = b.syncWriteSecrets(secrets); err != nil {
			return nil, err
		}
		b.syncDisconnect(id)
		b.mu.Lock()
		status := b.syncReadStatus()
		delete(status, id)
		b.syncWriteStatus(status)
		b.mu.Unlock()
		return desktopOK(nil), nil
	case "server:agents:test":
		// 支持已保存配置（传 ID）或未保存草稿（传完整配置 + 令牌）。
		input := aiMap(aiArg(args, 0))
		agent := input
		secret := syncServerSecret{Token: strings.TrimSpace(aiString(input["token"]))}
		if id := strings.TrimSpace(aiString(input["id"])); id != "" && secret.Token == "" {
			if saved, savedSecret, err := b.syncAgentConfig(id); err == nil {
				if _, isDraft := input["host"]; !isDraft {
					agent = saved
					secret = savedSecret
				} else {
					secret.Token = savedSecret.Token
				}
			}
		}
		client, pin, err := syncBuildClient(agent, secret)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		fingerprint, err := syncAgentProbe(ctx, client, pin, syncAgentBaseURL(agent), secret.Token, false)
		if err != nil {
			var categorized *syncCategorizedError
			if errors.As(err, &categorized) {
				return map[string]any{"ok": false, "kind": categorized.Kind, "code": categorized.Code, "error": categorized.Message, "fingerprint": categorized.Fingerprint}, nil
			}
			return map[string]any{"ok": false, "kind": "network", "code": "NETWORK", "error": err.Error()}, nil
		}
		return map[string]any{"ok": true, "fingerprint": fingerprint}, nil
	case "server:agents:trust":
		result, err := b.syncTrust(strings.TrimSpace(aiString(aiArg(args, 0))))
		if err != nil {
			return nil, err
		}
		return result, nil
	case "server:agents:trustReset":
		result, err := b.syncResetTrust(strings.TrimSpace(aiString(aiArg(args, 0))))
		if err != nil {
			return nil, err
		}
		return result, nil
	case "server:connect":
		id := strings.TrimSpace(aiString(aiArg(args, 0)))
		result, err := b.syncConnect(id, false)
		if err != nil {
			var categorized *syncCategorizedError
			if errors.As(err, &categorized) {
				return map[string]any{"ok": false, "kind": categorized.Kind, "code": categorized.Code, "error": categorized.Message, "fingerprint": categorized.Fingerprint}, nil
			}
			return map[string]any{"ok": false, "kind": "network", "code": "NETWORK", "error": err.Error()}, nil
		}
		return result, nil
	case "server:disconnect":
		b.syncDisconnect(strings.TrimSpace(aiString(aiArg(args, 0))))
		return desktopOK(nil), nil
	case "server:status":
		return desktopOK(map[string]any{"statuses": b.syncReadStatus()}), nil
	case "server:install":
		return b.syncAgentInstall(args)
	case "server:projectSync":
		projectID := strings.TrimSpace(aiString(aiArg(args, 0)))
		mode := aiString(aiArg(args, 1))
		if mode == "pull" {
			return b.syncPullProject(projectID)
		}
		return b.syncPushProject(projectID, "手动推送 flow 快照")
	}
	return nil, errors.New("未知 Server Agent 通道")
}
