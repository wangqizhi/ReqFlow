package backendgo

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func desktopClosedProxy(t *testing.T) *url.URL {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := &url.URL{Scheme: "http", Host: listener.Addr().String()}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return proxy
}

func TestDesktopHTTPUnavailableProxyFallsBack(t *testing.T) {
	for _, scheme := range []string{"http", "https"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			t.Run(scheme+"/"+method, func(t *testing.T) {
				var requests atomic.Int32
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					body, _ := io.ReadAll(r.Body)
					if r.Method != method || string(body) != "request payload" {
						t.Errorf("unexpected direct request: %s %q", r.Method, body)
					}
					w.Write([]byte("direct response"))
				})
				var target *httptest.Server
				if scheme == "https" {
					target = httptest.NewTLSServer(handler)
				} else {
					target = httptest.NewServer(handler)
				}
				defer target.Close()
				client := DesktopHTTPClient(3 * time.Second)
				defer client.CloseIdleConnections()
				transport := client.Transport.(*desktopProxyFallbackTransport)
				transport.proxy.Proxy = http.ProxyURL(desktopClosedProxy(t))
				if scheme == "https" {
					tlsConfig := target.Client().Transport.(*http.Transport).TLSClientConfig
					transport.proxy.TLSClientConfig = tlsConfig.Clone()
					transport.direct.TLSClientConfig = tlsConfig.Clone()
				}
				req, err := http.NewRequest(method, target.URL, strings.NewReader("request payload"))
				if err != nil {
					t.Fatal(err)
				}
				response, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				body, err := io.ReadAll(response.Body)
				if err != nil || string(body) != "direct response" || requests.Load() != 1 {
					t.Fatalf("direct fallback: body=%q requests=%d err=%v", body, requests.Load(), err)
				}
			})
		}
	}
}

func TestDesktopHTTPProxyRouting(t *testing.T) {
	for _, mode := range []string{"none", "healthy", "authentication", "destination error"} {
		t.Run(mode, func(t *testing.T) {
			var directRequests, proxyRequests atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				directRequests.Add(1)
				w.WriteHeader(http.StatusOK)
			}))
			defer target.Close()
			wantStatus := http.StatusOK
			switch mode {
			case "authentication":
				wantStatus = http.StatusProxyAuthRequired
			case "destination error":
				wantStatus = http.StatusBadGateway
			}
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				proxyRequests.Add(1)
				w.WriteHeader(wantStatus)
			}))
			defer proxy.Close()
			client := DesktopHTTPClient(3 * time.Second)
			defer client.CloseIdleConnections()
			transport := client.Transport.(*desktopProxyFallbackTransport)
			transport.proxy.Proxy = nil
			if mode != "none" {
				proxyURL, _ := url.Parse(proxy.URL)
				transport.proxy.Proxy = http.ProxyURL(proxyURL)
			}
			response, err := client.Get(target.URL)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			wantDirect, wantProxy := int32(0), int32(1)
			if mode == "none" {
				wantDirect, wantProxy = 1, 0
			}
			if response.StatusCode != wantStatus || directRequests.Load() != wantDirect || proxyRequests.Load() != wantProxy {
				t.Fatalf("status=%d direct=%d proxy=%d", response.StatusCode, directRequests.Load(), proxyRequests.Load())
			}
		})
	}
}

func TestDesktopHTTPProxyFallbackHonorsCancellation(t *testing.T) {
	client := DesktopHTTPClient(3 * time.Second)
	defer client.CloseIdleConnections()
	transport := client.Transport.(*desktopProxyFallbackTransport)
	transport.proxy.Proxy = http.ProxyURL(desktopClosedProxy(t))
	var directAttempts atomic.Int32
	transport.direct.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		directAttempts.Add(1)
		return nil, context.Canceled
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://example.invalid/", nil)
	response, err := client.Do(req)
	if response != nil || err == nil || directAttempts.Load() != 0 {
		t.Fatalf("canceled request retried: response=%v err=%v attempts=%d", response, err, directAttempts.Load())
	}
}
