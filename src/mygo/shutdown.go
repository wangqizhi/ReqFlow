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
	if !confirmForceShutdown(fmt.Sprintf("有 %d 条 Agent CLI 任务正在执行。\n强制关闭会释放这些任务，使其从执行中返回排期表；Agent 后续回写将失效。\n是否强制关闭？选择“否”继续运行。", len(actions))) {
		return false
	}
	if err := workspace.ReleaseForShutdown(actions); err != nil {
		showStartupError("释放任务失败，已取消关闭：" + err.Error())
		return false
	}
	return true
}
