!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GhStats" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --start-minimised'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "GhStats"
!macroend
