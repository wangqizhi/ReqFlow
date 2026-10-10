; ReqFlow 安装向导自定义页 —— 选择数据存放目录。
; 本文件必须保存为 UTF-8 with BOM（NSIS 3 按此识别中文，否则乱码）。
; 通过 electron-builder 钩子接入：
;   customPageAfterChangeDir：在「选择安装目录」之后、「开始安装」之前插入页面
;   customInstall：            安装完成后把所选目录写入标记文件与注册表
;
; 应用端（src/main/data-dir.ts）按优先级读取：
;   REQFLOW_DATA_DIR 环境变量 > 便携版 exe 同级 data\ > 本页写入的 data-dir.cfg > %APPDATA%\ReqFlow

!include "nsDialogs.nsh"

LangString ReqFlowDataTitle    0x0409 "Data storage folder"
LangString ReqFlowDataTitle    0x0804 "数据存放目录"
LangString ReqFlowDataSub      0x0409 "Choose where your requirement data will be stored"
LangString ReqFlowDataSub      0x0804 "选择需求与批次数据（workspace.json）的保存位置"
LangString ReqFlowDataLabel    0x0409 "ReqFlow stores all data in a single workspace.json inside this folder.$\r$\nLeave the default to keep it in %APPDATA%\ReqFlow."
LangString ReqFlowDataLabel    0x0804 "ReqFlow 的全部数据（workspace.json）都保存在该目录下。$\r$\n保持默认则存放在 %APPDATA%\ReqFlow。"
LangString ReqFlowDataBrowse   0x0409 "Browse..."
LangString ReqFlowDataBrowse   0x0804 "浏览(&B)..."
LangString ReqFlowDataEmptyMsg 0x0409 "Please specify a data storage folder."
LangString ReqFlowDataEmptyMsg 0x0804 "请填写数据存放目录。"
LangString ReqFlowDataInsideMsg 0x0409 "The data folder cannot be inside the installation folder$\r$\n(everything there is deleted on uninstall). Please choose another location."
LangString ReqFlowDataInsideMsg 0x0804 "数据目录不能位于安装目录内（卸载时会连同数据一起删除），$\r$\n请换一个位置。"
LangString ReqFlowDataDirFail  0x0409 "Warning: could not create the data folder. The app will retry on first run."
LangString ReqFlowDataDirFail  0x0804 "警告：数据目录创建失败，应用首次写入数据时会再次尝试创建。"

; ---- 自定义页面：跟随在「选择安装位置」之后（卸载器子编译不参与） ----
!ifndef BUILD_UNINSTALLER

Var ReqFlowDataDir
Var ReqFlowDataDirEdit

!macro customPageAfterChangeDir
  Page custom ReqFlowDataDirPageCreate ReqFlowDataDirPageLeave
!macroend

Function ReqFlowDataDirPageCreate
  ; 预填：上次安装选择（升级场景）> 默认 %APPDATA%\ReqFlow（与旧版/应用默认一致）
  ReadRegStr $ReqFlowDataDir SHCTX "Software\ReqFlow" "DataDir"
  ${If} $ReqFlowDataDir == ""
    StrCpy $ReqFlowDataDir "$APPDATA\${APP_FILENAME}"
  ${EndIf}

  ; BUILD_UNINSTALLER 子编译不加载 MUI2，此时跳过（该编译不显示页面）
  !ifmacrodef MUI_HEADER_TEXT
    !insertmacro MUI_HEADER_TEXT "$(ReqFlowDataTitle)" "$(ReqFlowDataSub)"
  !endif

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "$(ReqFlowDataLabel)"
  Pop $0

  ${NSD_CreateText} 0 34u 84% 13u $ReqFlowDataDir
  Pop $ReqFlowDataDirEdit

  ${NSD_CreateButton} 86% 32u 14% 15u "$(ReqFlowDataBrowse)"
  Pop $0
  ${NSD_OnClick} $0 ReqFlowDataDirBrowse

  nsDialogs::Show
FunctionEnd

Function ReqFlowDataDirBrowse
  Pop $1
  ${NSD_GetText} $ReqFlowDataDirEdit $0
  nsDialogs::SelectFolderDialog "$(ReqFlowDataTitle)" $0
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $ReqFlowDataDirEdit $0
  ${EndIf}
FunctionEnd

; 判断 $R8（数据目录）是否在 $R9（基准目录）内部或与之相同；结果写入 $R7（"1"=是）。
; StrCmp 为大小写不敏感比较，符合 Windows 路径语义。
Function ReqFlowDataDirInsideInstall
  StrCpy $R7 "0"
  StrLen $0 $R9
  StrCpy $1 $R8 $0
  StrCmp $1 $R9 rq_done
  StrCpy $1 $R8 1 $0
  StrCmp $1 "" rq_inside
  StrCmp $1 "\" rq_inside 0
  Goto rq_done
rq_inside:
  StrCpy $R7 "1"
rq_done:
FunctionEnd

Function ReqFlowDataDirPageLeave
  ${NSD_GetText} $ReqFlowDataDirEdit $ReqFlowDataDir

  ; 容错：去掉用户粘贴路径时可能带的首尾引号
  StrCpy $1 $ReqFlowDataDir 1
  ${If} $1 == '"'
    StrCpy $ReqFlowDataDir $ReqFlowDataDir "" 1
    StrLen $2 $ReqFlowDataDir
    IntOp $2 $2 - 1
    StrCpy $1 $ReqFlowDataDir 1 $2
    ${If} $1 == '"'
      StrCpy $ReqFlowDataDir $ReqFlowDataDir $2
    ${EndIf}
  ${EndIf}

  ; 规范化：去掉多余的尾部反斜杠（保留 "C:\" 这类根目录）
  StrLen $2 $ReqFlowDataDir
  ${If} $2 > 3
    IntOp $2 $2 - 1
    StrCpy $1 $ReqFlowDataDir 1 $2
    ${If} $1 == "\"
      StrCpy $ReqFlowDataDir $ReqFlowDataDir $2
    ${EndIf}
  ${EndIf}

  ${If} $ReqFlowDataDir == ""
    MessageBox MB_ICONSTOP "$(ReqFlowDataEmptyMsg)"
    Abort
  ${EndIf}

  ; 禁止选在安装目录内：卸载时安装目录会被整目录删除，数据会一起丢失。
  ; electron-builder 在目录名不含应用名时会自动追加 \应用名 子目录，故对两个基准都检查
  ; （对"父目录下放数据"的极端选择会保守拦截，宁严勿松）。
  StrCpy $R8 $ReqFlowDataDir
  StrCpy $R9 $INSTDIR
  Call ReqFlowDataDirInsideInstall
  ${If} $R7 == "1"
    Goto rq_blocked
  ${EndIf}
  StrCpy $R9 "$INSTDIR\${APP_FILENAME}"
  Call ReqFlowDataDirInsideInstall
  ${If} $R7 == "1"
rq_blocked:
    MessageBox MB_ICONSTOP "$(ReqFlowDataInsideMsg)"
    Abort
  ${EndIf}
FunctionEnd

!endif ; !ifndef BUILD_UNINSTALLER

; ---- 安装完成后：创建数据目录，写入标记文件（应用读取）与注册表（下次升级预填） ----
!macro customInstall
  ; 静默安装（/S）不经过页面：沿用注册表中上次的选择（升级场景），否则回默认 %APPDATA%\ReqFlow
  ${If} $ReqFlowDataDir == ""
    ReadRegStr $ReqFlowDataDir SHCTX "Software\ReqFlow" "DataDir"
    ${If} $ReqFlowDataDir == ""
      StrCpy $ReqFlowDataDir "$APPDATA\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}

  ; 递归创建数据目录；已存在(183)视为成功
  System::Call 'shell32::SHCreateDirectoryEx(p 0, t "$ReqFlowDataDir", p 0)i .r0'
  ${If} $0 != 0
  ${AndIf} $0 != 183
    MessageBox MB_ICONEXCLAMATION "$(ReqFlowDataDirFail)"
  ${EndIf}

  ; data-dir.cfg：UTF-16LE 带 BOM（FF FE），应用端以 utf16le 解码读取
  FileOpen $0 "$INSTDIR\data-dir.cfg" w
  FileWriteByte $0 255
  FileWriteByte $0 254
  FileWriteUTF16LE $0 "$ReqFlowDataDir"
  FileWriteUTF16LE $0 "$\r$\n"
  FileClose $0

  WriteRegStr SHCTX "Software\ReqFlow" "DataDir" "$ReqFlowDataDir"
!macroend

; 卸载说明：数据目录与注册表 DataDir 均保留（不删用户数据）；
; data-dir.cfg 位于 $INSTDIR 内，随卸载自动清理。
