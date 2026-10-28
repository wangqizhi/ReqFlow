package main

import (
	"fmt"
	"reqflow/mygo/backendgo"
)

func prepareShutdown(workspace *backendgo.WorkspaceService) bool {
	// A secondary desktop must never release another desktop's shared claims.
	if otherDesktopInstance(workspace.DataFile()) {
		return true
	}
	actions, err := workspace.ActiveExecutionActions()
	if err != nil {
		showStartupError("无法检查执行中任务，已取消关闭：" + err.Error())
		return false
	}
	if len(actions) == 0 {
		return true
	}
	// Closing the desktop must preserve external CLI run IDs for later completion.
	return confirmForceShutdown(fmt.Sprintf("有 %d 条 Agent CLI 任务正在执行。\n关闭后任务将保留在执行中，不会释放；重新打开 ReqFlow 后 CLI 仍可使用原运行记录继续操作。\n本窗口内的 Agent 终端会中断。是否关闭？选择“否”继续运行。", len(actions)))
}
