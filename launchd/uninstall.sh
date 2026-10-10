#!/bin/zsh
launchctl unload ~/Library/LaunchAgents/com.wab.server.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.wab.server.plist
echo "已停止并移除 WAB 开机自启"
