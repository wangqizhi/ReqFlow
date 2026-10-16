package backendgo

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func publishBytes(t *testing.T, result map[string]any) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(desktopString(result["data"]))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestPublishTerminalStreamsBeforeExit(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.8.4")
	root := t.TempDir()
	script := `[Console]::Out.Write('first'); while (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'continue'))) { Start-Sleep -Milliseconds 20 }; [Console]::Error.Write('stderr'); [Console]::Out.Write('last'); exit 7`
	if err := os.WriteFile(filepath.Join(root, "publish.ps1"), []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	// The live terminal must remain available when persistent request logging is off.
	desktopTestCall(t, b, "publish:logs:settings:save", map[string]any{"enabled": false})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan any, 1)
	go func() {
		result, err := b.Invoke(ctx, "publish:run", []any{root, "publish.ps1", "terminal-live-test"})
		if err != nil {
			done <- err
		} else {
			done <- result
		}
	}()
	var first map[string]any
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		first = desktopTestCall(t, b, "publish:output", "terminal-live-test", 0)
		if string(publishBytes(t, first)) == "first" {
			break
		}
		select {
		case result := <-done:
			t.Fatalf("script exited before its gate: %v", result)
		default:
		}
		time.Sleep(20 * time.Millisecond)
	}
	if string(publishBytes(t, first)) != "first" || desktopBool(first["done"]) {
		t.Fatal("output was buffered until process exit")
	}
	if replay := desktopTestCall(t, b, "publish:output", "terminal-live-test", first["offset"]); len(publishBytes(t, replay)) != 0 {
		t.Fatal("incremental polling repeated output")
	}
	if other := desktopTestCall(t, b, "publish:output", "another-session", 0); len(publishBytes(t, other)) != 0 {
		t.Fatal("cross-session output leaked")
	}
	if err := os.WriteFile(filepath.Join(root, "continue"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if desktopMap(result)["ok"] != false {
			t.Fatalf("script failure lost: %v", result)
		}
	case <-ctx.Done():
		t.Fatal("script did not finish")
	}
	last := desktopTestCall(t, b, "publish:output", "terminal-live-test", first["offset"])
	tail := string(publishBytes(t, last))
	if !desktopBool(last["done"]) || !strings.Contains(tail, "stderr") || !strings.Contains(tail, "last") || strings.Contains(tail, "first") {
		t.Fatalf("final output lost: %v", last)
	}
	if result, _ := b.Invoke(ctx, "publish:run", []any{root, "publish.ps1", "terminal-live-test"}); desktopMap(result)["ok"] != false {
		t.Fatal("duplicate session accepted")
	}
}

func TestPublishTerminalBytesAndBoundedReplay(t *testing.T) {
	b := NewBackend(t.TempDir(), t.TempDir(), "2.8.4")
	r := &desktopPublishRun{b: b}
	b.desktopPublishRuns = map[string]*desktopPublishRun{"byte-test": r}
	w := &desktopPublishWriter{r: r}
	raw := []byte("中文\x1b[31m\rprogress")
	w.Write(raw[:1])
	first := desktopTestCall(t, b, "publish:output", "byte-test", 0)
	w.Write(raw[1:])
	second := desktopTestCall(t, b, "publish:output", "byte-test", first["offset"])
	if string(append(publishBytes(t, first), publishBytes(t, second)...)) != string(raw) {
		t.Fatal("UTF-8, ANSI or carriage return bytes were changed")
	}
	w.Write([]byte(strings.Repeat("x", 250*1024)))
	bounded := desktopTestCall(t, b, "publish:output", "byte-test", 0)
	if !desktopBool(bounded["truncated"]) || len(publishBytes(t, bounded)) != 200*1024 {
		t.Fatal("replay is unbounded or truncation unreported")
	}
}
