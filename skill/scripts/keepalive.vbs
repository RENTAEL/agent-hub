' Runs keepalive.mjs with no window. Task Scheduler ("Agent Hub keep-alive") calls this every 5 minutes.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "node """ & dir & "\keepalive.mjs""", 0, False
