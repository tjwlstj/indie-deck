; Assisted-installer behaviour beyond electron-builder's defaults.
;
; IndieDeck is per-user (perMachine: false), so every registry write lives in
; HKCU. When a previous installation exists - whether in the default
; %LOCALAPPDATA%\Programs folder or somewhere the user once picked - upgrade
; that copy in place instead of suggesting the default directory again. The
; uninstaller for the old build runs first as usual, so no orphaned files are
; left behind.
;
; Render the wizard at the display's system DPI instead of letting Windows
; bitmap-scale an unaware dialog. Malgun Gothic ships with Windows 10/11 and
; supports both Korean and Latin text; 10 pt also gives labels more room than
; the small legacy installer defaults. The header is used for install/uninstall.
!macro customHeader
  ManifestDPIAware true
  SetFont "Malgun Gothic" 10
!macroend

!macro customInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $R0 != ""
    ${AndIf} ${FileExists} "$R0\IndieDeck.exe"
      StrCpy $INSTDIR "$R0"
  ${EndIf}
!macroend
