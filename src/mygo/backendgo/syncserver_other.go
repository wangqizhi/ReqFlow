//go:build !windows

package backendgo

// 非 Windows 平台的常驻部署（REQ-237：提供等效的后台常驻启动方式）：
// 优先写入 systemd 用户服务并尝试启用；无 systemd 时生成 start.sh 启动脚本与说明。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func syncRunServiceHost(argv []string, version string, stdout io.Writer) int {
	fmt.Fprintln(stdout, "该平台没有服务宿主子命令；请使用 server install 生成 systemd 配置后运行。")
	return 1
}

func syncOutput(name string, args []string) (string, error) {
	command := desktopCommand(context.Background(), name, args, "")
	raw, err := command.CombinedOutput()
	return string(raw), err
}

func syncSystemdUserDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user"), nil
}

func syncSystemctl(args []string) (string, error) {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return "", errors.New("未安装 systemctl")
	}
	command := desktopCommand(context.Background(), "systemctl", args, "")
	if os.Getenv("XDG_RUNTIME_DIR") == "" {
		uid := "0"
		if output, err := syncOutput("id", []string{"-u"}); err == nil {
			uid = strings.TrimSpace(output)
		}
		command.Env = append(os.Environ(), "XDG_RUNTIME_DIR=/run/user/"+uid)
	}
	raw, err := command.CombinedOutput()
	return string(raw), err
}

func syncManageService(command string, flags map[string]string, cfgPath string, version string, stdout io.Writer) int {
	switch command {
	case "install":
		if cfgPath == "" {
			cfgPath = syncDefaultConfigPath()
		}
		cfg, err := syncPrepareConfig(flags, cfgPath, true)
		if err != nil {
			fmt.Fprintln(stdout, "安装失败："+err.Error())
			return 1
		}
		if err = syncSaveConfig(cfgPath, cfg); err != nil {
			fmt.Fprintln(stdout, "保存配置失败："+err.Error())
			return 1
		}
		if _, err = syncEnsureCertificate(cfg); err != nil {
			fmt.Fprintln(stdout, "生成证书失败："+err.Error())
			return 1
		}
		exe, err := syncExecutable()
		if err != nil {
			fmt.Fprintln(stdout, "安装失败："+err.Error())
			return 1
		}
		unit := "[Unit]\nDescription=ReqFlow Server Agent\nAfter=network-online.target\n\n[Service]\nExecStart=" + exe + " server run --config " + cfgPath + "\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n"
		unitDir, err := syncSystemdUserDir()
		if err == nil {
			if err = os.MkdirAll(unitDir, 0700); err == nil {
				err = os.WriteFile(filepath.Join(unitDir, "reqflow-server.service"), []byte(unit), 0600)
			}
		}
		if err != nil {
			fmt.Fprintln(stdout, "写入 systemd 配置失败："+err.Error())
			return 1
		}
		enabled := true
		if _, err = syncSystemctl([]string{"--user", "daemon-reload"}); err != nil {
			enabled = false
		} else if _, err = syncSystemctl([]string{"--user", "enable", "--now", "reqflow-server.service"}); err != nil {
			enabled = false
		}
		if enabled {
			fmt.Fprintln(stdout, "已安装 systemd 用户服务 reqflow-server 并启动（开机登录后自动拉起）。")
		} else {
			script := filepath.Join(cfg.DataDir, "start.sh")
			_ = os.WriteFile(script, []byte("#!/bin/sh\nexec \""+exe+"\" server run --config \""+cfgPath+"\"\n"), 0700)
			fmt.Fprintln(stdout, "已生成 systemd 单元与启动脚本 "+script+"；当前无法直接启用，请执行：")
			fmt.Fprintln(stdout, "  systemctl --user daemon-reload && systemctl --user enable --now reqflow-server")
			fmt.Fprintln(stdout, "或在 NAS 上把 " + script + " 配置为开机启动脚本。")
		}
		fmt.Fprintln(stdout, "配置文件："+cfgPath)
		fmt.Fprintln(stdout, "访问令牌："+cfg.Token)
		fmt.Fprintln(stdout, "监听地址：https://" + cfg.Host + ":" + fmt.Sprint(cfg.Port))
		fmt.Fprintln(stdout, "在客户端「设置 → Server Agent」中使用以上信息新增服务端。")
		return 0
	case "uninstall":
		_, _ = syncSystemctl([]string{"--user", "disable", "--now", "reqflow-server.service"})
		unitDir, err := syncSystemdUserDir()
		if err == nil {
			_ = os.Remove(filepath.Join(unitDir, "reqflow-server.service"))
		}
		_, _ = syncSystemctl([]string{"--user", "daemon-reload"})
		fmt.Fprintln(stdout, "已注销同步服务端。数据目录保留，可手动删除。")
		return 0
	case "start", "stop":
		verb := map[string]string{"start": "启动", "stop": "停止"}[command]
		if output, err := syncSystemctl([]string{"--user", command, "reqflow-server.service"}); err != nil {
			fmt.Fprintln(stdout, "systemctl "+command+" 失败："+strings.TrimSpace(output)+" "+err.Error())
			return 1
		}
		fmt.Fprintln(stdout, "已发送"+verb+"请求。")
		return 0
	case "status":
		if output, err := syncSystemctl([]string{"--user", "is-active", "reqflow-server.service"}); err == nil {
			fmt.Fprintln(stdout, "reqflow-server："+strings.TrimSpace(output))
		} else {
			fmt.Fprintln(stdout, "无法查询 systemd 状态：" + strings.TrimSpace(output))
		}
		return 0
	}
	return -1
}
