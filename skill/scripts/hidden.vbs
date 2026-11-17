' Runs a program in a hidden console window. Programs it starts share that hidden console, so no window pops up.
' (Node's detached spawn gives a console program no console at all, and then everything it starts opens a new visible one.)
' Usage: wscript hidden.vbs "<log file or NUL>" "<program>" [args...]   Output is appended to the log.
Set a = WScript.Arguments
line = ""
For i = 1 To a.Count - 1
  line = line & " """ & a(i) & """"
Next
CreateObject("WScript.Shell").Run "cmd /c """ & Trim(line) & " >> """ & a(0) & """ 2>&1""", 0, False
