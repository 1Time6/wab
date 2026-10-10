@echo off
REM WAB one-click setup: installs Node.js/Git if missing, builds everything,
REM registers auto-start and creates desktop shortcuts. Safe to run again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\setup.ps1"
echo.
pause
