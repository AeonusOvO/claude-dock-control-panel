!include "LogicLib.nsh"
!include "MUI2.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutCheckbox
  Var DesktopShortcutSelection

  !macro customPageAfterChangeDir
    Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave

    Function DesktopShortcutPageCreate
      !insertmacro MUI_HEADER_TEXT "安装选项" "选择 ClaudeDock 的附加安装选项"

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 24u "请选择是否为当前安装创建桌面快捷方式。"
      Pop $0

      ${NSD_CreateCheckbox} 0 34u 100% 14u "在桌面创建快捷方式"
      Pop $DesktopShortcutCheckbox
      ${NSD_Check} $DesktopShortcutCheckbox

      nsDialogs::Show
    FunctionEnd

    Function DesktopShortcutPageLeave
      ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutSelection
    FunctionEnd
  !macroend

  !macro customInstall
    ${If} $DesktopShortcutSelection == ${BST_UNCHECKED}
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  !macroend
!endif
