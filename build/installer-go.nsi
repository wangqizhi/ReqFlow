Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "nsDialogs.nsh"
!include "${LEGACY_CLEANUP_INCLUDE}"
!include "close-app.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\173d13da-33b6-52f0-a048-23db6656a56c"
Name "ReqFlow ${APP_VERSION}"
OutFile "${APP_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\ReqFlow"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"
VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "ReqFlow"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "ReqFlow Go Installer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "ReqFlow Local"
Var DataDir
Var DataEdit
Var DataChanged
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_GUIINIT CenterOnCursorMonitor
; REQ-130：安装完成后默认勾选「运行 ReqFlow」
!define MUI_FINISHPAGE_RUN "$INSTDIR\ReqFlow.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom DataPage DataLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; Place the wizard once, on the monitor under the pointer, inside its work area.
Function CenterOnCursorMonitor
  System::Call '*(i 0, i 0) p .r0'
  System::Call 'user32::GetCursorPos(p r0) i .r1'
  ${If} $1 != 0
    System::Call '*$0(i .r1, i .r2)'
    ; MonitorFromRect avoids passing a POINT by value on different architectures.
    IntOp $3 $1 + 1
    IntOp $4 $2 + 1
    System::Call '*(i r1, i r2, i r3, i r4) p .r5'
    System::Call 'user32::MonitorFromRect(p r5, i 2) p .r6'
    System::Free $5
    System::Call '*(i 40, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0) p .r5'
    System::Call 'user32::GetMonitorInfoW(p r6, p r5) i .r6'
    ${If} $6 != 0
      System::Call '*$5(i, i, i, i, i, i .r1, i .r2, i .r3, i .r4)'
      System::Call '*(i 0, i 0, i 0, i 0) p .r6'
      System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r6)'
      System::Call '*$6(i .r7, i .r8, i .r9, i .R0)'
      System::Free $6
      IntOp $9 $9 - $7
      IntOp $R0 $R0 - $8
      IntOp $3 $3 - $1
      IntOp $3 $3 - $9
      IntOp $3 $3 / 2
      ${If} $3 < 0
        StrCpy $3 0
      ${EndIf}
      IntOp $3 $3 + $1
      IntOp $4 $4 - $2
      IntOp $4 $4 - $R0
      IntOp $4 $4 / 2
      ${If} $4 < 0
        StrCpy $4 0
      ${EndIf}
      IntOp $4 $4 + $2
      System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r3, i r4, i 0, i 0, i 0x15)'
    ${EndIf}
    System::Free $5
  ${EndIf}
  System::Free $0
FunctionEnd

Function .onInit
  SetShellVarContext current
  SetRegView 64
!ifdef SANDBOX_DIR
  ; Test installers never touch the real registry, shortcuts or installation.
  StrCpy $INSTDIR "${SANDBOX_DIR}"
!else
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "UninstallString"
    ; Legacy electron-builder wrote only a quoted uninstaller path.
    StrCpy $1 $0 1
    ${If} $1 == '$\"'
      StrCpy $0 $0 "" 1
      StrCpy $2 0
      legacy_path_loop:
        StrCpy $1 $0 1 $2
        StrCmp $1 '$\"' legacy_path_end
        StrCmp $1 "" legacy_path_end
        IntOp $2 $2 + 1
        Goto legacy_path_loop
      legacy_path_end:
      StrCpy $0 $0 $2
      ${GetParent} "$0" $0
    ${Else}
      StrCpy $0 ""
    ${EndIf}
  ${EndIf}
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
!endif
  StrCpy $DataChanged "0"
FunctionEnd

Function ReadDataDirectory
  StrCpy $DataDir ""
  ; The existing marker is authoritative and is kept on a silent upgrade.
  IfFileExists "$INSTDIR\data-dir.cfg" 0 no_marker
  FileOpen $0 "$INSTDIR\data-dir.cfg" r
  FileReadByte $0 $1
  FileReadByte $0 $2
  ${If} $1 == 255
  ${AndIf} $2 == 254
    FileReadUTF16LE $0 $DataDir
  ${Else}
    FileSeek $0 0 SET
    FileRead $0 $DataDir
  ${EndIf}
  FileClose $0
  ${TrimNewLines} $DataDir $DataDir
  no_marker:
!ifndef SANDBOX_DIR
  ${If} $DataDir == ""
    ReadRegStr $DataDir HKCU "Software\ReqFlow" "DataDir"
  ${EndIf}
!endif
  ${If} $DataDir == ""
    StrCpy $DataDir "$APPDATA\ReqFlow"
  ${EndIf}
  GetFullPathName $DataDir "$DataDir"
  Call NormalizeDataDirectory
FunctionEnd

Function NormalizeDataDirectory
  ; Normalize a trailing separator so cleanup's boundary comparison is reliable.
  StrLen $0 $DataDir
  ${If} $0 > 3
    IntOp $0 $0 - 1
    StrCpy $1 $DataDir 1 $0
    ${If} $1 == "\"
      StrCpy $DataDir $DataDir $0
    ${EndIf}
  ${EndIf}
FunctionEnd

Function DataPage
  Call ReadDataDirectory
  !insertmacro MUI_HEADER_TEXT "数据存放目录" "升级将保留现有数据和用户配置"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 35u "保留当前目录可继续使用原版数据。安装只清理旧运行库，数据目录、AI 设置和用户文件都会保留。"
  Pop $0
  ${NSD_CreateText} 0 42u 100% 13u "$DataDir"
  Pop $DataEdit
  nsDialogs::Show
FunctionEnd

Function DataLeave
  ${NSD_GetText} $DataEdit $0
  ${If} $0 == ""
    MessageBox MB_ICONSTOP "请填写数据目录。"
    Abort
  ${EndIf}
  GetFullPathName $0 "$0"
  ${If} $0 != $DataDir
    StrCpy $DataChanged "1"
    StrCpy $DataDir $0
    Call NormalizeDataDirectory
  ${EndIf}
FunctionEnd

; REQ-129：向导模式下请求确认后关闭运行中的程序再继续安装（close-app.nsh）；
; 静默安装（/S）保持拒绝并返回退出码 2，不终止任何进程。
; Never follow junctions/symlinks or remove a file inside the selected data dir.
Function DeleteLegacyRuntime
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrLen $1 $DataDir
  StrCpy $2 $0 $1
  StrCmp $2 $DataDir 0 cleanup_parent
  StrCpy $2 $DataDir 1 -1
  StrCmp $2 "\" cleanup_done
  StrCpy $2 $0 1 $1
  StrCmp $2 "\" cleanup_done
  StrCmp $2 "" cleanup_done
  cleanup_parent:
  ${GetParent} "$0" $3
  cleanup_walk:
  System::Call 'kernel32::GetFileAttributesW(w r3)i .r4'
  IntOp $4 $4 & 0x400
  IntCmp $4 0 0 cleanup_done cleanup_done
  StrCmp $3 $INSTDIR cleanup_delete
  ${GetParent} "$3" $4
  StrCmp $4 $3 cleanup_done
  StrCpy $3 $4
  Goto cleanup_walk
  cleanup_delete:
  Delete "$0"
  cleanup_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function RemoveEmptyLegacyDirectory
  Exch $0
  Push $1
  StrCmp $0 $DataDir empty_directory_done
  System::Call 'kernel32::GetFileAttributesW(w r0)i .r1'
  IntOp $1 $1 & 0x400
  IntCmp $1 0 0 empty_directory_done empty_directory_done
  RMDir "$0"
  empty_directory_done:
  Pop $1
  Pop $0
FunctionEnd

Section "ReqFlow" SEC_APP
  ${If} $DataChanged != "1"
    Call ReadDataDirectory
  ${EndIf}
  ; The install root itself must not be a drive root or a reparse point.
  ${GetRoot} "$INSTDIR" $0
  StrCmp $INSTDIR $0 unsafe_directory
  StrCmp $INSTDIR "$0\" unsafe_directory
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR")i .r0'
  IntCmp $0 -1 root_ok
  IntOp $0 $0 & 0x400
  IntCmp $0 0 root_ok unsafe_directory unsafe_directory
  unsafe_directory:
    MessageBox MB_ICONSTOP "无法安装到磁盘根目录或链接目录。" /SD IDOK
    SetErrorLevel 2
    Abort
  root_ok:
  ; Use the bundled new binary so even upgrades from older apps release claims.
  ; Silent installs never terminate a running app or release its tasks.
  IfSilent shutdown_check_done
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=ReqFlow-shutdown.exe "${APP_SOURCE}"
  Push $DataDir
  Call ReadDataDirectory
  ExecWait '$\"$PLUGINSDIR\ReqFlow-shutdown.exe$\" --prepare-install $\"$DataDir$\"' $0
  Pop $DataDir
  ${If} $0 != 0
    ; Older launchers may have closed the app before this task check. Restore
    ; the installed app on cancellation; never launch the temporary helper UI.
    FindWindow $1 "" "ReqFlow · 需求流"
    ${If} $1 != 0
      System::Call 'user32::ShowWindow(p r1, i 9)'
      System::Call 'user32::SetForegroundWindow(p r1)'
      Goto restore_app_done
    ${EndIf}
    IfFileExists "$INSTDIR\ReqFlow.exe" 0 restore_legacy_app
    ExecShell "open" "$INSTDIR\ReqFlow.exe"
    Goto restore_app_done
    restore_legacy_app:
    IfFileExists "$INSTDIR\ReqFlow-MyGO.exe" 0 restore_app_done
    ExecShell "open" "$INSTDIR\ReqFlow-MyGO.exe"
    restore_app_done:
    SetErrorLevel 2
    Abort
  ${EndIf}
  shutdown_check_done:
  ; Request write access; the wizard asks to close a still-running app first (REQ-129).
  Push "$INSTDIR\ReqFlow.exe"
  Call EnsureRuntimeClosed
  Push "$INSTDIR\ReqFlow-MyGO.exe"
  Call EnsureRuntimeClosed
  Push "$INSTDIR\runtime\node.exe"
  Call EnsureRuntimeClosed
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ClearErrors
  File "${APP_SOURCE}"
  IfErrors write_failed
  File "${APP_BUILD_INFO}"
!ifdef APP_SERVER_LINUX_AMD64
  File "${APP_SERVER_LINUX_AMD64}"
!endif
!ifdef APP_SERVER_LINUX_ARM64
  File "${APP_SERVER_LINUX_ARM64}"
!endif
  WriteUninstaller "$INSTDIR\Uninstall ReqFlow.exe"
  IfErrors write_failed
  !insertmacro ReqFlowCleanupLegacy
  ${If} $DataChanged == "1"
    Goto write_marker
  ${EndIf}
  IfFileExists "$INSTDIR\data-dir.cfg" marker_done
  write_marker:
    FileOpen $0 "$INSTDIR\data-dir.cfg" w
    FileWriteByte $0 255
    FileWriteByte $0 254
    FileWriteUTF16LE $0 "$DataDir$\r$\n"
    FileClose $0
  marker_done:
!ifndef SANDBOX_DIR
  WriteRegStr HKCU "Software\ReqFlow" "DataDir" "$DataDir"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "ReqFlow ${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\ReqFlow.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall ReqFlow.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall ReqFlow.exe$\" /S'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "ReqFlow Local"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\ReqFlow"
  CreateShortcut "$SMPROGRAMS\ReqFlow\ReqFlow.lnk" "$INSTDIR\ReqFlow.exe"
  CreateShortcut "$DESKTOP\ReqFlow.lnk" "$INSTDIR\ReqFlow.exe"
!endif
  Goto install_done
  write_failed:
    MessageBox MB_ICONSTOP "程序文件写入失败；现有数据保留。请关闭程序并检查目录权限后重试。" /SD IDOK
    SetErrorLevel 2
    Abort
  install_done:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  ; Deliberately leave data-dir.cfg, AppData/profile, LocalState and all data.
  Delete "$INSTDIR\ReqFlow.exe"
  Delete "$INSTDIR\build-info.json"
  Delete "$INSTDIR\reqflow-server-linux-amd64"
  Delete "$INSTDIR\reqflow-server-linux-arm64"
  Delete "$INSTDIR\Uninstall ReqFlow.exe"
  RMDir "$INSTDIR"
!ifndef SANDBOX_DIR
  Delete "$DESKTOP\ReqFlow.lnk"
  Delete "$SMPROGRAMS\ReqFlow\ReqFlow.lnk"
  RMDir "$SMPROGRAMS\ReqFlow"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  ; Software\ReqFlow\DataDir is retained for later reinstall.
!endif
SectionEnd
