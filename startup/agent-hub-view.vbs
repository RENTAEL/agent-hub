' Starts the Agent Hub live view hidden at sign-in: http://127.0.0.1:4317 (read-only, this PC only).
' Log: %LOCALAPPDATA%\agent-hub\view.log
Set sh = CreateObject("WScript.Shell")
WScript.Sleep 30000
sh.Run "cmd /c if not exist ""%LOCALAPPDATA%\agent-hub"" mkdir ""%LOCALAPPDATA%\agent-hub"" & node ""%USERPROFILE%\.claude\skills\agent-hub\hub-view\server.mjs"" >> ""%LOCALAPPDATA%\agent-hub\view.log"" 2>&1", 0, False
