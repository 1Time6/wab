#!/bin/zsh
# 安装/更新 WAB 服务为 macOS 开机自启（launchd）
set -e
cd "$(dirname "$0")/.."
npm run build -w server
mkdir -p ~/Library/LaunchAgents
cp launchd/com.wab.server.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.wab.server.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.wab.server.plist
sleep 2
curl -s http://127.0.0.1:3900/api/health && echo "\n✅ WAB 服务已启动：http://127.0.0.1:3900"
