// reqflow-server 是 ReqFlow 同步服务端的独立入口（REQ-237），与桌面端共用
// backendgo 中的服务端实现；构建产物用于部署到 NAS / 云主机 / 常开设备。
package main

import (
	"os"

	"reqflow/mygo/backendgo"
)

var appVersion = "2.12.3"

func main() {
	os.Exit(backendgo.RunServerCLI(os.Args[1:], appVersion, os.Stdout))
}
