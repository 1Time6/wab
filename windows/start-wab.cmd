@echo off
REM 手动前台启动 WAB 服务（调试 / 第一次跑用）。关掉窗口服务就停。
cd /d "%~dp0..\server"
if not exist dist\index.js (
  echo [WAB] 还没编译，先执行 npm run build ...
  call npm run build
)
set WAB_PORT=3900
echo [WAB] 服务地址 http://127.0.0.1:3900  （按 Ctrl+C 停止）
node dist\index.js
