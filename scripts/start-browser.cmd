@echo off
rem DSH Browser Control —— 双击启动专属浏览器环境
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-browser.ps1" %*
if errorlevel 1 pause
