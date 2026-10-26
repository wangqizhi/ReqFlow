//go:build windows

package backendgo

// Windows 系统服务支持（REQ-237）：`server install` 通过 sc 注册真正的 Windows 服务
//（binPath 指向 `ReqFlow.exe server service`，由 SCM 拉起，重启机器后自动运行）；
// 无管理员权限时回退为计划任务（登录时自动启动）。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func syncRunServiceHost(argv []string, version string, stdout io.Writer) int {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		fmt.Fprintln(stdout, "请在终端使用 server run 前台运行；server service 由系统服务管理器调用。")
		return 1
	}
	flags, _ := syncParseFlags(argv)
	cfgPath := strings.TrimSpace(flags["config"])
	if cfgPath == "" {
		cfgPath = syncDefaultConfigPath()
	}
	cfg, err := syncPrepareConfig(flags, cfgPath, true)
	if err != nil {
		return 1
	}
	// 服务模式下没有控制台，日志同时写入数据目录，便于排查启动失败。
	if file, e := os.OpenFile(filepath.Join(cfg.DataDir, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); e == nil {
		defer file.Close()
	}
	if err := svc.Run(syncServiceName, &syncWindowsService{cfg: cfg, version: version}); err != nil {
		return 1
	}
	return 0
}

type syncWindowsService struct {
	cfg     *syncServerConfig
	version string
}

func (m *syncWindowsService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	stop, addr, _, err := startSyncServer(m.cfg, m.version, false)
	if err != nil {
		fmt.Fprintf(os.Stderr, "服务启动失败：%v\n", err)
		return true, 1
	}
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			changes <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			_ = stop()
			return false, 0
		default:
		}
	}
	_ = addr
	return false, 0
}

func syncServiceConfigPath(flags map[string]string, cfgPath string) (string, *syncServerConfig, error) {
	if cfgPath == "" {
		cfgPath = syncDefaultConfigPath()
	}
	cfg, err := syncPrepareConfig(flags, cfgPath, true)
	if err != nil {
		return "", nil, err
	}
	if err = syncSaveConfig(cfgPath, cfg); err != nil {
		return "", nil, err
	}
	return cfgPath, cfg, nil
}

func syncManageService(command string, flags map[string]string, cfgPath string, version string, stdout io.Writer) int {
	switch command {
	case "install":
		configPath, cfg, err := syncServiceConfigPath(flags, cfgPath)
		if err != nil {
			fmt.Fprintln(stdout, "安装失败："+err.Error())
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
		binPath := "\"" + exe + "\" server service --config \"" + configPath + "\""
		if err = syncInstallWindowsService(binPath); err == nil {
			fmt.Fprintln(stdout, "已注册 Windows 服务 "+syncServiceName+"（开机自动启动）并已启动。")
		} else {
			fmt.Fprintln(stdout, "注册系统服务未成功（"+err.Error()+"），改用计划任务（当前用户登录时自动启动）。")
			task := "\"\"" + exe + "\" server run --config \"" + configPath + "\"\""
			if err = syncRunControl("schtasks", []string{"/Create", "/F", "/TN", syncServiceName, "/TR", task, "/SC", "ONLOGON", "/RL", "HIGHEST"}); err != nil {
				fmt.Fprintln(stdout, "计划任务创建失败："+err.Error())
				return 1
			}
			_ = syncRunControl("schtasks", []string{"/Run", "/TN", syncServiceName})
			fmt.Fprintln(stdout, "已创建计划任务 "+syncServiceName+" 并启动。")
		}
		fmt.Fprintln(stdout, "配置文件："+configPath)
		fmt.Fprintln(stdout, "访问令牌："+cfg.Token)
		fmt.Fprintln(stdout, "监听地址：https://" + cfg.Host + ":" + fmt.Sprint(cfg.Port))
		fmt.Fprintln(stdout, "在客户端「设置 → Server Agent」中使用以上信息新增服务端。")
		return 0
	case "uninstall":
		serviceErr := syncUninstallWindowsService()
		taskErr := syncRunControl("schtasks", []string{"/Delete", "/F", "/TN", syncServiceName})
		if serviceErr != nil && taskErr != nil {
			fmt.Fprintln(stdout, "未发现可注销的服务或计划任务。")
			return 1
		}
		fmt.Fprintln(stdout, "已停止并注销同步服务端。数据目录保留，可手动删除。")
		return 0
	case "start", "stop":
		if err := syncServiceAction(command); err == nil {
			fmt.Fprintln(stdout, "已发送 " + map[string]string{"start": "启动", "stop": "停止"}[command] + "请求。")
			return 0
		}
		verb := "/Run"
		if command == "stop" {
			verb = "/End"
		}
		if err := syncRunControl("schtasks", []string{verb, "/TN", syncServiceName}); err != nil {
			fmt.Fprintln(stdout, "操作失败："+err.Error()+"；服务可能未安装。")
			return 1
		}
		fmt.Fprintln(stdout, "已通过计划任务发送" + map[string]string{"start": "启动", "stop": "停止"}[command] + "请求。")
		return 0
	case "status":
		state, err := syncServiceState()
		if err == nil {
			fmt.Fprintln(stdout, "Windows 服务 "+syncServiceName+"："+state)
		} else {
			fmt.Fprintln(stdout, "Windows 服务未安装或不可查询（"+err.Error()+"）")
		}
		if output, err := syncOutput("schtasks", []string{"/Query", "/TN", syncServiceName, "/FO", "LIST", "/NH"}); err == nil && strings.TrimSpace(output) != "" {
			fmt.Fprintln(stdout, "计划任务：")
			for _, line := range strings.Split(output, "\n") {
				if strings.TrimSpace(line) != "" {
					fmt.Fprintln(stdout, "  "+strings.TrimSpace(line))
				}
			}
		}
		return 0
	}
	return -1
}

func syncRunControl(name string, args []string) error {
	output, err := syncOutput(name, args)
	if err != nil {
		return errors.New(strings.TrimSpace(output + " " + err.Error()))
	}
	return nil
}

func syncOutput(name string, args []string) (string, error) {
	command := desktopCommand(context.Background(), name, args, "")
	raw, err := command.CombinedOutput()
	return string(raw), err
}

func syncInstallWindowsService(binPath string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return errors.New("需要管理员权限连接服务管理器：" + err.Error())
	}
	defer manager.Disconnect()
	if service, err := manager.OpenService(syncServiceName); err == nil {
		service.Close()
		_ = syncServiceAction("stop")
		_ = syncRunControl("sc", []string{"delete", syncServiceName})
	}
	service, err := manager.CreateService(syncServiceName, binPath, mgr.Config{StartType: mgr.StartAutomatic, DisplayName: "ReqFlow 同步服务端", Description: "ReqFlow Server Agent — 各设备需求流数据的远程同步服务端"})
	if err != nil {
		return err
	}
	defer service.Close()
	return service.Start()
}

func syncUninstallWindowsService() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(syncServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	status, err := service.Query()
	if err == nil && status.State != svc.Stopped {
		_, _ = service.Control(svc.Stop)
	}
	return service.Delete()
}

func syncServiceAction(action string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(syncServiceName)
	if err != nil {
		return err
	}
	defer service.Close()
	if action == "start" {
		return service.Start()
	}
	_, err = service.Control(svc.Stop)
	return err
}

func syncServiceState() (string, error) {
	manager, err := mgr.Connect()
	if err != nil {
		return "", err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(syncServiceName)
	if err != nil {
		return "", err
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil {
		return "", err
	}
	switch status.State {
	case svc.Running:
		return "运行中", nil
	case svc.Stopped:
		return "已停止", nil
	case svc.StartPending:
		return "正在启动", nil
	case svc.StopPending:
		return "正在停止", nil
	case svc.Paused:
		return "已暂停", nil
	}
	return "状态 " + fmt.Sprint(int(status.State)), nil
}
