package backendgo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Go requests respect environment proxies and the Windows user's configured
// manual proxy. Local endpoints bypass the system proxy.
func DesktopHTTPClient(timeout time.Duration) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = func(r *http.Request) (*url.URL, error) {
		if p, e := http.ProxyFromEnvironment(r); p != nil || e != nil {
			return p, e
		}
		host := r.URL.Hostname()
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return nil, nil
		}
		return desktopSystemProxy(r.URL.Scheme)
	}
	return &http.Client{Timeout: timeout, Transport: transport}
}
func desktopCloneMap(m map[string]any) map[string]any {
	r := map[string]any{}
	for k, v := range m {
		r[k] = v
	}
	return r
}
func (b *Backend) desktopUpdateState() map[string]any {
	b.desktopUpdateMu.Lock()
	defer b.desktopUpdateMu.Unlock()
	return desktopCloneMap(b.desktopUpdate)
}
func (b *Backend) desktopUpdateSet(value map[string]any) {
	b.desktopUpdateMu.Lock()
	b.desktopUpdate = value
	b.desktopUpdateMu.Unlock()
}

var desktopVersion = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)$`)

func desktopNewer(candidate, current string) bool {
	a, z := desktopVersion.FindStringSubmatch(candidate), desktopVersion.FindStringSubmatch(current)
	if len(a) != 4 || len(z) != 4 {
		return false
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(a[i])
		y, _ := strconv.Atoi(z[i])
		if x != y {
			return x > y
		}
	}
	return false
}

const desktopUpdateRepository = "wangqizhi/ReqFlow"

func desktopTrustedDownload(raw string) bool {
	u, e := url.Parse(raw)
	return e == nil && u.Scheme == "https" && strings.EqualFold(u.Host, "github.com") && strings.HasPrefix(u.Path, "/"+desktopUpdateRepository+"/releases/download/") && u.User == nil
}
func desktopUpdateRequest(ctx context.Context, raw string, timeout time.Duration) (*http.Response, error) {
	req, e := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("User-Agent", "ReqFlow/2.0 Go")
	req.Header.Set("Accept", "application/vnd.github+json")
	response, e := DesktopHTTPClient(timeout).Do(req)
	if e != nil {
		return nil, e
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return nil, fmt.Errorf("GitHub 请求失败（HTTP %d）", response.StatusCode)
	}
	return response, nil
}
func desktopValidAsset(asset map[string]any, version string) bool {
	return desktopString(asset["name"]) == "ReqFlow-Setup-"+version+".exe" && desktopTrustedDownload(desktopString(asset["browser_download_url"])) && desktopInt(asset["size"]) > 0 && desktopInt(asset["size"]) <= 512*1024*1024
}

var desktopHashPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func desktopVerifyInstaller(file string, asset map[string]any, expected string) bool {
	if !desktopHashPattern.MatchString(expected) {
		return false
	}
	f, e := os.Open(file)
	if e != nil {
		return false
	}
	defer f.Close()
	stat, e := f.Stat()
	if e != nil || !stat.Mode().IsRegular() || stat.Size() != desktopInt(asset["size"]) {
		return false
	}
	var magic [2]byte
	if _, e := io.ReadFull(f, magic[:]); e != nil || string(magic[:]) != "MZ" {
		return false
	}
	_, _ = f.Seek(0, io.SeekStart)
	hash := sha256.New()
	if _, e := io.Copy(hash, f); e != nil {
		return false
	}
	return strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expected)
}

func (b *Backend) desktopUpdater(ctx context.Context, channel string) (any, error) {
	if channel == "update:state" {
		return b.desktopUpdateState(), nil
	}
	b.desktopUpdateMu.Lock()
	if b.desktopUpdateBusy {
		state := desktopCloneMap(b.desktopUpdate)
		b.desktopUpdateMu.Unlock()
		return state, nil
	}
	b.desktopUpdateBusy = true
	b.desktopUpdateMu.Unlock()
	defer func() { b.desktopUpdateMu.Lock(); b.desktopUpdateBusy = false; b.desktopUpdateMu.Unlock() }()
	directory := filepath.Join(b.DataDir, "updates")
	metadata := filepath.Join(directory, "downloaded.json")
	fail := func(e error, retry string) map[string]any {
		state := b.desktopUpdateState()
		state["phase"], state["error"], state["retry"] = "error", e.Error(), retry
		b.desktopUpdateSet(state)
		return state
	}
	state := b.desktopUpdateState()
	switch channel {
	case "update:check":
		if phase := desktopString(state["phase"]); phase == "ready" || phase == "installing" {
			return state, nil
		}
		b.desktopUpdateSet(map[string]any{"phase": "checking"})
		if saved, e := desktopReadJSON(metadata, nil); e == nil && saved != nil {
			m := desktopMap(saved)
			version := desktopString(m["version"])
			asset := desktopMap(m["asset"])
			hash := desktopString(m["hash"])
			target := filepath.Join(directory, desktopString(asset["name"]))
			if desktopNewer(version, b.Version) && desktopValidAsset(asset, version) && desktopVerifyInstaller(target, asset, hash) {
				b.desktopAsset, b.desktopInstaller, b.desktopExpectedHash = asset, target, hash
				b.desktopUpdateSet(map[string]any{"phase": "ready", "version": version, "progress": 100})
				return b.desktopUpdateState(), nil
			}
		}
		response, e := desktopUpdateRequest(ctx, "https://api.github.com/repos/"+desktopUpdateRepository+"/releases/latest", 30*time.Second)
		if e != nil {
			return fail(e, "check"), nil
		}
		defer response.Body.Close()
		var release map[string]any
		if e = json.NewDecoder(io.LimitReader(response.Body, 4*1024*1024)).Decode(&release); e != nil {
			return fail(e, "check"), nil
		}
		version := strings.TrimPrefix(desktopString(release["tag_name"]), "v")
		if !desktopVersion.MatchString(version) || desktopBool(release["draft"]) || desktopBool(release["prerelease"]) {
			return fail(errors.New("发布版本信息无效"), "check"), nil
		}
		if !desktopNewer(version, b.Version) {
			b.desktopUpdateSet(map[string]any{"phase": "latest", "version": b.Version})
			return b.desktopUpdateState(), nil
		}
		var asset, checksum map[string]any
		for _, v := range desktopList(release["assets"]) {
			m := desktopMap(v)
			if desktopString(m["name"]) == "ReqFlow-Setup-"+version+".exe" {
				asset = m
			}
			if desktopString(m["name"]) == "SHA256SUMS-"+version+".txt" {
				checksum = m
			}
		}
		if !desktopValidAsset(asset, version) {
			return fail(errors.New("新版本缺少有效的 Windows Go 安装包"), "check"), nil
		}
		expected := strings.TrimPrefix(desktopString(asset["digest"]), "sha256:")
		checksumURL := desktopString(checksum["browser_download_url"])
		if !desktopTrustedDownload(checksumURL) {
			checksumURL = ""
		}
		if !desktopHashPattern.MatchString(expected) && checksumURL == "" {
			return fail(errors.New("新版本缺少 SHA256 校验信息"), "check"), nil
		}
		b.desktopAsset, b.desktopExpectedHash, b.desktopChecksum = asset, expected, checksumURL
		b.desktopUpdateSet(map[string]any{"phase": "available", "version": version})
		return b.desktopUpdateState(), nil
	case "update:download":
		asset := b.desktopAsset
		if asset == nil || (desktopString(state["phase"]) != "available" && desktopString(state["phase"]) != "error") {
			return state, nil
		}
		version := desktopString(state["version"])
		if !desktopValidAsset(asset, version) {
			return fail(errors.New("安装包元数据无效"), "check"), nil
		}
		expected := b.desktopExpectedHash
		if !desktopHashPattern.MatchString(expected) {
			response, e := desktopUpdateRequest(ctx, b.desktopChecksum, 30*time.Second)
			if e != nil {
				return fail(e, "download"), nil
			}
			raw, e := io.ReadAll(io.LimitReader(response.Body, 256*1024))
			response.Body.Close()
			if e != nil {
				return fail(e, "download"), nil
			}
			for _, line := range strings.Split(string(raw), "\n") {
				parts := strings.Fields(line)
				if len(parts) == 2 && strings.TrimPrefix(parts[1], "*") == desktopString(asset["name"]) && desktopHashPattern.MatchString(parts[0]) {
					expected = parts[0]
					break
				}
			}
		}
		if !desktopHashPattern.MatchString(expected) {
			return fail(errors.New("无法获取安装包校验值"), "download"), nil
		}
		target := filepath.Join(directory, desktopString(asset["name"]))
		partial := target + ".part"
		if e := os.MkdirAll(directory, 0700); e != nil {
			return fail(e, "download"), nil
		}
		b.desktopUpdateSet(map[string]any{"phase": "downloading", "version": version, "progress": 0, "downloaded": 0, "total": asset["size"]})
		if !desktopVerifyInstaller(target, asset, expected) {
			response, e := desktopUpdateRequest(ctx, desktopString(asset["browser_download_url"]), 10*time.Minute)
			if e != nil {
				return fail(e, "download"), nil
			}
			f, e := os.OpenFile(partial, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
			if e != nil {
				response.Body.Close()
				return fail(e, "download"), nil
			}
			received := int64(0)
			buffer := make([]byte, 64*1024)
			for {
				n, readErr := response.Body.Read(buffer)
				if n > 0 {
					received += int64(n)
					if received > desktopInt(asset["size"]) {
						e = errors.New("安装包大小与发布信息不一致")
						break
					}
					if _, e = f.Write(buffer[:n]); e != nil {
						break
					}
					b.desktopUpdateSet(map[string]any{"phase": "downloading", "version": version, "downloaded": received, "total": asset["size"], "progress": min(int64(99), received*100/desktopInt(asset["size"]))})
				}
				if readErr == io.EOF {
					break
				}
				if readErr != nil {
					e = readErr
					break
				}
			}
			f.Close()
			response.Body.Close()
			if e == nil && !desktopVerifyInstaller(partial, asset, expected) {
				e = errors.New("安装包校验失败，请重新下载")
			}
			if e == nil {
				e = os.Rename(partial, target)
			}
			if e != nil {
				os.Remove(partial)
				return fail(e, "download"), nil
			}
		}
		if e := desktopAtomicJSON(metadata, map[string]any{"version": version, "asset": asset, "hash": expected}); e != nil {
			return fail(e, "download"), nil
		}
		b.desktopInstaller, b.desktopExpectedHash = target, expected
		b.desktopUpdateSet(map[string]any{"phase": "ready", "version": version, "progress": 100})
		return b.desktopUpdateState(), nil
	case "update:install":
		if desktopString(state["phase"]) != "ready" || b.desktopInstaller == "" {
			return state, nil
		}
		if !desktopVerifyInstaller(b.desktopInstaller, b.desktopAsset, b.desktopExpectedHash) {
			os.Remove(metadata)
			b.desktopInstaller = ""
			return fail(errors.New("本地安装包已丢失或校验失败，请重新下载"), "download"), nil
		}
		value, e := desktopNative(b, "shell.openPath", b.desktopInstaller)
		if e == nil && desktopString(value) != "" {
			e = errors.New(desktopString(value))
		}
		if e != nil {
			state["error"] = e.Error()
			b.desktopUpdateSet(state)
			return state, nil
		}
		state["phase"] = "installing"
		delete(state, "error")
		b.desktopUpdateSet(state)
		go func() { time.Sleep(300 * time.Millisecond); _, _ = desktopNative(b, "window.close") }()
		return state, nil
	}
	return state, nil
}
