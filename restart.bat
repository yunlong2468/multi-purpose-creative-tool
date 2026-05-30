@echo off
chcp 65001 >nul
taskkill /F /IM node.exe /T 2>nul
timeout /t 3 /nobreak >nul
cd /d "%~dp0"
start "Canvas" node server.js
echo Done
pause
