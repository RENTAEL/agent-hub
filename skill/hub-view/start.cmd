@echo off
rem Starts the Agent Hub live view (if it is not running yet) and opens it in the browser.
start "Agent Hub View" /min node "%~dp0server.mjs"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:4317
