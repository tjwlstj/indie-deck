; Assisted-installer behaviour beyond electron-builder's defaults.
;
; IndieDeck is per-user (perMachine: false), so every registry write lives in
; HKCU. When a previous installation exists - whether in the default
; %LOCALAPPDATA%\Programs folder or somewhere the user once picked - upgrade
; that copy in place instead of suggesting the default directory again. The
; uninstaller for the old build runs first as usual, so no orphaned files are
; left behind.
!macro customInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R0 != ""
    ${AndIf} ${FileExists} "$R0\IndieDeck.exe"
      StrCpy $INSTDIR "$R0"
  ${EndIf}
!macroend
