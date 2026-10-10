@echo off
REM 把 WAB 服务注册为"登录时自动启动"的计划任务（后台隐藏窗口，崩溃自动重启）
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause
