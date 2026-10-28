//go:build windows

package backendgo

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProjectConsoleSurvivesLauncherAndCommandExit(t *testing.T) {
	root := filepath.Join(t.TempDir(), "project 'quoted space")
	os.MkdirAll(root, 0700)
	marker := filepath.Join(root, "pid.txt")
	literal := "'" + strings.ReplaceAll(marker, "'", "''") + "'"
	// The script finishes immediately. -NoExit must keep the visible console
	// alive after both that command and the hidden launcher have returned.
	if err := launchProjectConsole(root, "$PID.ToString() + '|' + (Get-Location).Path | Set-Content -LiteralPath "+literal); err != nil {
		t.Fatal(err)
	}
	var content []byte
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		content, _ = os.ReadFile(marker)
		if len(content) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	parts := strings.SplitN(strings.TrimSpace(string(content)), "|", 2)
	if len(parts) != 2 {
		t.Fatalf("console failed to write marker: %s", content)
	}
	pid, err := strconv.Atoi(parts[0])
	if err != nil || pid <= 0 {
		t.Fatal(parts, err)
	}
	defer func() {
		if process, err := os.FindProcess(pid); err == nil {
			process.Kill()
		}
	}()
	if !strings.EqualFold(parts[1], root) {
		t.Fatalf("wrong working directory: %s", parts[1])
	}
	time.Sleep(1200 * time.Millisecond)
	check := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", fmt.Sprintf("$ErrorActionPreference='Stop'; Get-Process -Id %d | Out-Null", pid))
	desktopHideCommand(check)
	if output, err := check.CombinedOutput(); err != nil {
		t.Fatalf("console exited after command: %v %s", err, output)
	}
}
