' Starts the Obsidian agent hub bridge hidden at login: it answers task notes in the vault's agents/tasks folder.
' Waits a minute so Ollama and OmniRoute are up first. Log: %LOCALAPPDATA%\agent-hub\bridge.log
Set sh = CreateObject("WScript.Shell")
WScript.Sleep 60000
sh.Run "cmd /c if not exist ""%LOCALAPPDATA%\agent-hub"" mkdir ""%LOCALAPPDATA%\agent-hub"" & node ""%USERPROFILE%\.claude\skills\agent-hub\scripts\agent-bridge.mjs"" --watch >> ""%LOCALAPPDATA%\agent-hub\bridge.log"" 2>&1", 0, False
