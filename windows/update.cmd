@echo off
REM Update WAB: git pull, rebuild server + extension, restart the background service.
REM Pass -Force to rebuild and restart even when already up to date.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
pause
