package backendgo

// ReqFlow 同步服务端（REQ-237/REQ-238）：与桌面端同一 Go 代码库的独立入口命令。
// 桌面端通过 `ReqFlow.exe server ...` 调用；服务器上用独立构建的 reqflow-server 运行。
// 单用户模型：一个访问令牌保护全部同步接口；数据目录与客户端工作区完全隔离。

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const syncServiceName = "ReqFlowServerAgent"
const syncServerRealm = "reqflow-server-v1"

type syncServerConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	DataDir  string `json:"dataDir"`
	Token    string `json:"token"`
	CertPath string `json:"certPath,omitempty"`
	KeyPath  string `json:"keyPath,omitempty"`
}

// syncDefaultDataDir 与桌面端数据目录（%APPDATA%/ReqFlow 等）分开，避免混用。
func syncDefaultDataDir() string {
	if value := os.Getenv("REQFLOW_SERVER_DATA_DIR"); value != "" {
		return value
	}
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "reqflow-server")
	}
	return filepath.Join(os.Getenv("HOME"), ".reqflow-server")
}

func syncDefaultConfigPath() string { return filepath.Join(syncDefaultDataDir(), "server-config.json") }

func syncTokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func syncGenerateToken() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

func syncValidToken(token string) bool {
	return regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`).MatchString(token)
}

func syncLoadConfig(path string) (*syncServerConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg syncServerConfig
	if err = json.Unmarshal(raw, &cfg); err != nil {
		return nil, errors.New("服务端配置文件不是有效 JSON：" + path)
	}
	return &cfg, nil
}

func syncSaveConfig(path string, cfg *syncServerConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return aiWriteJSON(path, cfg)
}

// syncPrepareConfig 解析 flags+配置文件并校验；首次启动时生成令牌。
func syncPrepareConfig(flags map[string]string, configPath string, generateToken bool) (*syncServerConfig, error) {
	cfg := &syncServerConfig{Host: "0.0.0.0", Port: 8787, DataDir: syncDefaultDataDir()}
	if configPath == "" {
		configPath = syncDefaultConfigPath()
	}
	if loaded, err := syncLoadConfig(configPath); err == nil {
		cfg = loaded
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	override := func(key string, field *string) {
		if value := strings.TrimSpace(flags[key]); value != "" {
			*field = value
		}
	}
	override("host", &cfg.Host)
	override("data-dir", &cfg.DataDir)
	override("cert", &cfg.CertPath)
	override("key", &cfg.KeyPath)
	override("token", &cfg.Token)
	if value := strings.TrimSpace(flags["port"]); value != "" {
		port, err := strconv.Atoi(value)
		if err != nil || port < 1 || port > 65535 {
			return nil, errors.New("--port 须为 1-65535 之间的端口号")
		}
		cfg.Port = port
	}
	if strings.TrimSpace(cfg.DataDir) == "" {
		return nil, errors.New("--data-dir 不能为空")
	}
	if !filepath.IsAbs(cfg.DataDir) {
		absolute, err := filepath.Abs(cfg.DataDir)
		if err != nil {
			return nil, err
		}
		cfg.DataDir = absolute
	}
	// REQ-237：服务端数据目录结构与本地工作区隔离，不与客户端 data/ 混用。
	for _, clash := range []string{"workspace.json", "requirements.sqlite", "ai-settings.json", "server-agents.json"} {
		if coreExists(filepath.Join(cfg.DataDir, clash)) {
			return nil, errors.New("数据目录包含桌面客户端文件（" + clash + "），请为服务端指定独立的 --data-dir")
		}
	}
	if cfg.Token == "" {
		if !generateToken {
			return nil, errors.New("服务端尚未配置访问令牌；请运行 server run --token <令牌> 或让服务端自动生成")
		}
		token, err := syncGenerateToken()
		if err != nil {
			return nil, err
		}
		cfg.Token = token
	}
	if !syncValidToken(cfg.Token) {
		return nil, errors.New("访问令牌须为 16-128 位字母、数字、- 或 _")
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, err
	}
	if err := aiWriteJSON(filepath.Join(cfg.DataDir, "reqflow-server.json"), map[string]any{"service": syncServerRealm, "createdAt": time.Now().UTC().Format(time.RFC3339)}); err != nil {
		return nil, err
	}
	if configPath != "" && !coreExists(configPath) {
		if err := syncSaveConfig(configPath, cfg); err != nil {
			return nil, err
		}
	}
	return cfg, nil
}

// syncEnsureCertificate 自签证书（REQ-238）：默认在数据目录生成并长期复用，指纹保持稳定。
func syncEnsureCertificate(cfg *syncServerConfig) (tls.Certificate, error) {
	if cfg.CertPath != "" || cfg.KeyPath != "" {
		if cfg.CertPath == "" || cfg.KeyPath == "" {
			return tls.Certificate{}, errors.New("--cert 与 --key 必须同时提供")
		}
		cert, err := tls.LoadX509KeyPair(cfg.CertPath, cfg.KeyPath)
		if err != nil {
			return tls.Certificate{}, fmt.Errorf("证书文件读取失败：%w", err)
		}
		return cert, nil
	}
	certFile := filepath.Join(cfg.DataDir, "certs", "server-cert.pem")
	keyFile := filepath.Join(cfg.DataDir, "certs", "server-key.pem")
	if coreExists(certFile) && coreExists(keyFile) {
		cert, err := tls.LoadX509KeyPair(certFile, keyFile)
		if err == nil {
			return cert, nil
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	hostnames := []string{"localhost"}
	if host, err := os.Hostname(); err == nil && host != "" {
		hostnames = append(hostnames, host)
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "ReqFlow Server Agent", Organization: []string{"ReqFlow Local"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              hostnames,
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	if ip := net.ParseIP(cfg.Host); ip != nil {
		template.IPAddresses = append(template.IPAddresses, ip)
	} else if cfg.Host != "" && cfg.Host != "0.0.0.0" && cfg.Host != "::" {
		template.DNSNames = append(template.DNSNames, cfg.Host)
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err = os.MkdirAll(filepath.Dir(certFile), 0700); err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err = coreAtomicWrite(certFile, certPEM); err != nil {
		return tls.Certificate{}, err
	}
	if err = coreAtomicWrite(keyFile, keyPEM); err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// syncCertificateFingerprint 证书指纹 = SHA-256(证书 DER)，客户端以此建立信任（REQ-238）。
func syncCertificateFingerprint(der []byte) string {
	digest := sha256.Sum256(der)
	return hex.EncodeToString(digest[:])
}

type syncProjectRecord struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Project   map[string]any `json:"project"`
	Revision  int64          `json:"revision"`
	UpdatedAt string         `json:"updatedAt"`
}

type syncServer struct {
	cfg     *syncServerConfig
	version string
	mu      sync.Mutex
}

var syncProjectIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)

func (s *syncServer) projectPath(id string) string {
	return filepath.Join(s.cfg.DataDir, "projects", id+".json")
}
func (s *syncServer) eventsPath(id string) string {
	return filepath.Join(s.cfg.DataDir, "projects", id+".events.json")
}

func (s *syncServer) writeJSON(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func (s *syncServer) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer"))
		if token == "" {
			token = strings.TrimSpace(r.URL.Query().Get("token"))
		}
		if token == "" || syncTokenHash(token) != syncTokenHash(s.cfg.Token) {
			// REQ-237：未配置有效凭据时拒绝所有同步接口请求，返回明确错误码与提示。
			s.writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "code": "UNAUTHORIZED", "error": "缺少或无效的访问令牌，请在请求头携带 Authorization: Bearer <令牌>"})
			return
		}
		next(w, r)
	}
}

func (s *syncServer) readProject(id string) (*syncProjectRecord, error) {
	raw, err := os.ReadFile(s.projectPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var record syncProjectRecord
	if err = json.Unmarshal(raw, &record); err != nil {
		return nil, errors.New("服务端项目数据损坏：" + id)
	}
	return &record, nil
}

func (s *syncServer) handlePing(w http.ResponseWriter, r *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": syncServerRealm, "version": s.version, "protocol": "sync-v1"})
}

func (s *syncServer) handleInfo(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	projects, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "projects", "*.json"))
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": syncServerRealm, "version": s.version, "dataDir": s.cfg.DataDir, "projects": len(projects)})
}

func (s *syncServer) handleProjects(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, _ := filepath.Glob(filepath.Join(s.cfg.DataDir, "projects", "*.json"))
	list := []map[string]any{}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		var record syncProjectRecord
		if json.Unmarshal(raw, &record) == nil {
			list = append(list, map[string]any{"id": record.ID, "name": record.Name, "revision": record.Revision, "updatedAt": record.UpdatedAt})
		}
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "projects": list})
}

func (s *syncServer) handleProjectGet(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if !syncProjectIDPattern.MatchString(id) {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "BAD_REQUEST", "error": "项目 ID 无效"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record, err := s.readProject(id)
	if err != nil {
		s.writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "code": "ERROR", "error": err.Error()})
		return
	}
	if record == nil {
		s.writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "code": "NOT_FOUND", "error": "服务端还没有该项目数据"})
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "project": record.Project, "revision": record.Revision, "updatedAt": record.UpdatedAt})
}

func (s *syncServer) handleProjectPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "code": "METHOD_NOT_ALLOWED", "error": "请使用 POST 推送项目"})
		return
	}
	var body struct {
		ProjectID string         `json:"projectId"`
		Project   map[string]any `json:"project"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024*1024)).Decode(&body); err != nil {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "BAD_REQUEST", "error": "推送数据无效：" + err.Error()})
		return
	}
	if !syncProjectIDPattern.MatchString(body.ProjectID) || body.Project == nil {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "BAD_REQUEST", "error": "projectId 或 project 无效"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Join(s.cfg.DataDir, "projects"), 0700); err != nil {
		s.writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "code": "ERROR", "error": err.Error()})
		return
	}
	previous, err := s.readProject(body.ProjectID)
	if err != nil {
		s.writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "code": "ERROR", "error": err.Error()})
		return
	}
	revision := int64(1)
	if previous != nil {
		revision = previous.Revision + 1
	}
	record := syncProjectRecord{ID: body.ProjectID, Name: desktopString(body.Project["name"]), Project: body.Project, Revision: revision, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err = aiWriteJSON(s.projectPath(body.ProjectID), record); err != nil {
		s.writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "code": "ERROR", "error": err.Error()})
		return
	}
	log.Printf("已接收项目推送 %s（rev %d，来自 %s）", body.ProjectID, revision, r.RemoteAddr)
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": revision, "updatedAt": record.UpdatedAt})
}

func (s *syncServer) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "code": "METHOD_NOT_ALLOWED", "error": "请使用 POST 上报步骤"})
		return
	}
	var body struct {
		ProjectID string   `json:"projectId"`
		Events    []string `json:"events"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024)).Decode(&body); err != nil {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "BAD_REQUEST", "error": "步骤数据无效"})
		return
	}
	if !syncProjectIDPattern.MatchString(body.ProjectID) {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "code": "BAD_REQUEST", "error": "projectId 无效"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := []map[string]any{}
	_ = aiReadJSON(s.eventsPath(body.ProjectID), &entries)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for count, event := range body.Events {
		if strings.TrimSpace(event) == "" {
			continue
		}
		entries = append(entries, map[string]any{"time": now, "event": aiLimit(event, 500), "index": len(entries) + count + 1})
	}
	if len(entries) > 500 {
		entries = entries[len(entries)-500:]
	}
	if err := aiWriteJSON(s.eventsPath(body.ProjectID), entries); err != nil {
		s.writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "code": "ERROR", "error": err.Error()})
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(entries)})
}

func (s *syncServer) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ping", s.handlePing)
	mux.HandleFunc("/api/info", s.requireAuth(s.handleInfo))
	mux.HandleFunc("/api/sync/projects", s.requireAuth(s.handleProjects))
	mux.HandleFunc("/api/sync/project", s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			s.handleProjectGet(w, r)
			return
		}
		s.handleProjectPush(w, r)
	}))
	mux.HandleFunc("/api/sync/events", s.requireAuth(s.handleEvents))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		s.writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "code": "NOT_FOUND", "error": "未知接口：" + r.URL.Path})
	})
	return mux
}

// startSyncServer 启动监听并返回停止函数；前台运行与系统服务共用。
func startSyncServer(cfg *syncServerConfig, version string, quiet bool) (stop func() error, addr string, fingerprint string, err error) {
	certificate, err := syncEnsureCertificate(cfg)
	if err != nil {
		return nil, "", "", err
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return nil, "", "", err
	}
	fingerprint = syncCertificateFingerprint(leaf.Raw)
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		return nil, "", "", fmt.Errorf("无法监听 %s：%w", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)), err)
	}
	server := &syncServer{cfg: cfg, version: version}
	httpServer := &http.Server{Handler: server.handler(), TLSConfig: &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}, ReadHeaderTimeout: 15 * time.Second}
	go func() {
		if err := httpServer.ServeTLS(listener, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("同步服务端异常退出：%v", err)
		}
	}()
	if !quiet {
		log.Printf("ReqFlow 同步服务端已启动，实际监听地址：https://%s", listener.Addr().String())
		log.Printf("数据目录：%s", cfg.DataDir)
		log.Printf("证书指纹（SHA-256）：%s", fingerprint)
	}
	stop = func() error {
		_ = httpServer.Close()
		return nil
	}
	return stop, listener.Addr().String(), fingerprint, nil
}

func syncRunForeground(argv []string, version string, stdout io.Writer) int {
	flags, positional := syncParseFlags(argv)
	_ = positional
	cfgPath := strings.TrimSpace(flags["config"])
	cfg, err := syncPrepareConfig(flags, cfgPath, true)
	if err != nil {
		fmt.Fprintln(stdout, "启动失败："+err.Error())
		return 1
	}
	if cfgPath == "" {
		cfgPath = syncDefaultConfigPath()
	}
	stop, addr, fingerprint, err := startSyncServer(cfg, version, false)
	if err != nil {
		fmt.Fprintln(stdout, "启动失败："+err.Error())
		return 1
	}
	defer stop()
	fmt.Fprintln(stdout, "ReqFlow 同步服务端运行中：https://"+addr)
	fmt.Fprintln(stdout, "配置文件："+cfgPath)
	fmt.Fprintln(stdout, "访问令牌："+cfg.Token+"（客户端配置时使用；也可随时运行 server token 查看）")
	fmt.Fprintln(stdout, "证书指纹（SHA-256）："+fingerprint)
	fmt.Fprintln(stdout, "按 Ctrl+C 停止")
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	<-signals
	fmt.Fprintln(stdout, "正在停止…")
	return 0
}

func syncParseFlags(argv []string) (map[string]string, []string) {
	flags := map[string]string{}
	positional := []string{}
	for n := 0; n < len(argv); n++ {
		value := argv[n]
		if !strings.HasPrefix(value, "--") {
			positional = append(positional, value)
			continue
		}
		parts := strings.SplitN(strings.TrimPrefix(value, "--"), "=", 2)
		token := "true"
		if len(parts) == 2 {
			token = parts[1]
		} else if n+1 < len(argv) && !strings.HasPrefix(argv[n+1], "--") {
			n++
			token = argv[n]
		}
		flags[parts[0]] = token
	}
	return flags, positional
}

func syncRunControlCommand(command string, argv []string, version string, stdout io.Writer) int {
	flags, _ := syncParseFlags(argv)
	cfgPath := strings.TrimSpace(flags["config"])
	switch command {
	case "token":
		rotate := coreTruthy(flags["rotate"])
		if rotate {
			if cfgPath == "" {
				cfgPath = syncDefaultConfigPath()
			}
			cfg, err := syncPrepareConfig(flags, cfgPath, false)
			if err != nil {
				fmt.Fprintln(stdout, "读取配置失败："+err.Error())
				return 1
			}
			token, err := syncGenerateToken()
			if err != nil {
				fmt.Fprintln(stdout, "生成令牌失败："+err.Error())
				return 1
			}
			cfg.Token = token
			if err = syncSaveConfig(cfgPath, cfg); err != nil {
				fmt.Fprintln(stdout, "保存配置失败："+err.Error())
				return 1
			}
			fmt.Fprintln(stdout, "已重新生成访问令牌："+token)
			fmt.Fprintln(stdout, "已连接的客户端需要更新为新令牌后才能继续同步。")
			return 0
		}
		if cfgPath == "" {
			cfgPath = syncDefaultConfigPath()
		}
		cfg, err := syncLoadConfig(cfgPath)
		if err != nil {
			fmt.Fprintln(stdout, "读取配置失败："+err.Error()+"；尚未初始化的服务端请先运行 server run 一次")
			return 1
		}
		fmt.Fprintln(stdout, "访问令牌："+cfg.Token)
		return 0
	case "install", "uninstall", "start", "stop", "status":
		return syncManageService(command, flags, cfgPath, version, stdout)
	}
	return -1
}

// RunServerCLI 是同步服务端的命令入口；桌面端 `ReqFlow.exe server ...` 与独立
// reqflow-server 二进制共用。返回进程退出码。
func RunServerCLI(argv []string, version string, stdout io.Writer) int {
	// Both the desktop and standalone binary accept the documented `server` prefix.
	if len(argv) > 0 && argv[0] == "server" {
		argv = argv[1:]
	}
	command := "run"
	rest := argv
	if len(argv) > 0 && !strings.HasPrefix(argv[0], "--") {
		command = argv[0]
		rest = argv[1:]
	}
	if command == "help" || command == "--help" || command == "-h" {
		fmt.Fprintln(stdout, "ReqFlow 同步服务端 v"+version)
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "用法：")
		fmt.Fprintln(stdout, "  reqflow-server server run     前台运行（--port / --data-dir / --config / --host / --token / --cert / --key）")
		fmt.Fprintln(stdout, "  reqflow-server server install 注册为系统服务并启动（重启机器后自动拉起）")
		fmt.Fprintln(stdout, "  reqflow-server server uninstall 注销系统服务")
		fmt.Fprintln(stdout, "  reqflow-server server start|stop|status  启动 / 停止 / 查看服务状态")
		fmt.Fprintln(stdout, "  reqflow-server server token [--rotate]  查看访问令牌 / 重新生成")
		fmt.Fprintln(stdout, "")
		fmt.Fprintln(stdout, "数据目录与桌面客户端隔离，保存 projects/ 与 certs/；默认监听 0.0.0.0:8787（HTTPS）。")
		fmt.Fprintln(stdout, "首次启动自动生成自签证书与访问令牌，并在日志中打印实际监听地址与证书指纹。")
		return 0
	}
	if command == "run" {
		return syncRunForeground(rest, version, stdout)
	}
	if command == "service" {
		// Windows SCM 入口；非 Windows 平台不会到达这里（见 syncserver_other.go）。
		return syncRunServiceHost(rest, version, stdout)
	}
	if code := syncRunControlCommand(command, rest, version, stdout); code >= 0 {
		return code
	}
	fmt.Fprintln(stdout, "未知子命令："+command+"（可用：run / install / uninstall / start / stop / status / token / help）")
	return 1
}

// syncManageService 的平台相关实现分布在 syncserver_windows.go / syncserver_other.go。
func syncExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Abs(exe)
}

func syncCommandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
