Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "nsDialogs.nsh"
!include "${LEGACY_CLEANUP_INCLUDE}"

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
!define MUI_FINISHPAGE_RUN "$INSTDIR\ReqFlow.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom DataPage DataLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

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

Function CheckRuntimeNotRunning
  Exch $0
  Push $1
  IfFileExists "$0" 0 runtime_closed
  System::Call 'kernel32::CreateFileW(w r0, i 0x40000000, i 0, p 0, i 3, i 0, p 0)p .r1'
  ${If} $1 == -1
    MessageBox MB_ICONSTOP "请先关闭 ReqFlow（包括旧 MyGO 测试版）再安装；程序正在运行或目录不可写。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r1)'
  runtime_closed:
  Pop $1
  Pop $0
FunctionEnd

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
  ; Request write access without modifying or killing existing executables.
  Push "$INSTDIR\ReqFlow.exe"
  Call CheckRuntimeNotRunning
  Push "$INSTDIR\ReqFlow-MyGO.exe"
  Call CheckRuntimeNotRunning
  Push "$INSTDIR\runtime\node.exe"
  Call CheckRuntimeNotRunning
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ClearErrors
  File "${APP_SOURCE}"
  IfErrors write_failed
  File "${APP_BUILD_INFO}"
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
