; REQ-129：安装向导遇到正在运行的 ReqFlow 时，先请求用户确认再关闭程序并继续安装。
; 本文件由 build/installer-go.nsi 引入（makensis 以 /INPUTCHARSET UTF8 编译，UTF-8 无 BOM）。
; 关闭方式为按完整路径匹配后 TerminateProcess：应用所有数据写入均为临时文件 + 原子重命名，
; 强制退出不会损坏 workspace.json；按路径匹配也不会误伤用户自己的 node.exe 等无关进程。
; 静默安装（/S）保持既有行为：拒绝安装并返回退出码 2，不终止任何进程。

Var AppKillCount
Var AppWritable

; 终止所有可执行文件完整路径等于 $0 的进程，命中数写入 $AppKillCount。
; 安装器为 32 位进程：PROCESSENTRY32W 按本机布局使用（dwSize=556，PID 位于偏移 8）。
Function KillAppProcesses
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  StrCpy $8 0
  System::Alloc 556
  Pop $1
  StrCmp $1 0 0 kill_snapshot
  Goto kill_done
kill_snapshot:
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r2'
  StrCmp $2 0 kill_free
  StrCmp $2 -1 kill_free
  System::Call '*$1(i 556)'
  System::Call 'kernel32::Process32FirstW(p r2, p r1) i .r3'
  StrCmp $3 0 kill_close
kill_loop:
  System::Call '*$1(i, i, i .r4)'
  StrCmp $4 0 kill_next
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r4) p .r5'
  StrCmp $5 0 kill_next
  System::Call 'kernel32::QueryFullProcessImageNameW(p r5, i 0, w .r6, *i 1024) i .r7'
  System::Call 'kernel32::CloseHandle(p r5)'
  StrCmp $7 0 kill_next
  StrCmp $6 $0 0 kill_next
  System::Call 'kernel32::OpenProcess(i 1, i 0, i r4) p .r5'
  StrCmp $5 0 kill_next
  System::Call 'kernel32::TerminateProcess(p r5, i 0) i .r7'
  System::Call 'kernel32::CloseHandle(p r5)'
  StrCmp $7 0 kill_next
  IntOp $8 $8 + 1
kill_next:
  System::Call 'kernel32::Process32NextW(p r2, p r1) i .r3'
  StrCmp $3 0 kill_close kill_loop
kill_close:
  System::Call 'kernel32::CloseHandle(p r2)'
kill_free:
  System::Free $1
kill_done:
  StrCpy $AppKillCount $8
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 轮询等待 $0 可被独占写打开（运行中的程序已完全退出），结果 1/0 写入 $AppWritable。
; TerminateProcess 返回后句柄释放有短暂延迟，最多等待约 8 秒。
Function WaitAppWritable
  Exch $0
  Push $1
  Push $2
  StrCpy $2 0
wait_loop:
  System::Call 'kernel32::CreateFileW(w r0, i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r1'
  StrCmp $1 -1 wait_retry
  StrCmp $1 0 wait_retry
  System::Call 'kernel32::CloseHandle(p r1)'
  StrCpy $AppWritable 1
  Goto wait_done
wait_retry:
  IntOp $2 $2 + 1
  IntCmp $2 32 wait_fail 0 wait_continue
wait_fail:
  StrCpy $AppWritable 0
  Goto wait_done
wait_continue:
  Sleep 250
  Goto wait_loop
wait_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 确认 $0 指向的运行库文件未被占用；向导模式下被占用时弹确认框，
; 用户点击“确定”即关闭对应进程并继续安装，点击“取消”退出安装。
Function EnsureRuntimeClosed
  Exch $0
  Push $1
  System::Call 'kernel32::CreateFileW(w r0, i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r1'
  StrCmp $1 -1 0 ensure_open_ok
  StrCmp $1 0 0 ensure_open_ok
  Goto ensure_locked
ensure_open_ok:
  System::Call 'kernel32::CloseHandle(p r1)'
  Goto ensure_done
ensure_locked:
  IfSilent ensure_silent ensure_ask
ensure_silent:
  MessageBox MB_ICONSTOP "请先关闭 ReqFlow（包括旧 MyGO 测试版）再安装；程序正在运行或目录不可写。" /SD IDOK
  SetErrorLevel 2
  Abort
ensure_ask:
  MessageBox MB_ICONQUESTION|MB_OKCANCEL "检测到 ReqFlow 正在运行。$\r$\n点击“确定”关闭程序并继续安装，点击“取消”退出安装。" /SD IDOK IDOK ensure_kill IDCANCEL ensure_cancel
ensure_cancel:
  SetErrorLevel 2
  Abort
ensure_kill:
  Push $0
  Call KillAppProcesses
  Push $0
  Call WaitAppWritable
  StrCmp $AppWritable 1 ensure_done 0
  MessageBox MB_ICONSTOP "无法自动关闭 ReqFlow；请手动结束进程后重新运行安装程序。" /SD IDOK
  SetErrorLevel 2
  Abort
ensure_done:
  Pop $1
  Pop $0
FunctionEnd
