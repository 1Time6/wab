# 注册 Windows 计划任务：用户登录时后台启动 WAB 服务，崩溃后 1 分钟内自动重启
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$server = Join-Path $root 'server'
$taskName = 'WAB Server'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host '找不到 node.exe，请先安装 Node.js 20+'; exit 1 }

Write-Host '编译服务端...'
Push-Location $server
& npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host '编译失败'; exit 1 }
Pop-Location
New-Item -ItemType Directory -Force -Path (Join-Path $server 'data') | Out-Null

# 用 VBS 隐藏窗口启动（计划任务直接跑 node 会弹黑窗口）
$log = Join-Path $server 'data\server.log'
$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$cmdLine = "cmd.exe /c """"$node"" ""$server\dist\index.js"" >> ""$log"" 2>&1"""
@"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$server"
sh.Environment("Process")("WAB_PORT") = "3900"
sh.Run "$($cmdLine.Replace('"','""'))", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $server
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:3900/api/health' -TimeoutSec 5
  Write-Host "✅ WAB 服务已启动：http://127.0.0.1:3900  （数据库 $($r.db)）"
  Write-Host "   登录时会自动启动；日志在 $log"
} catch {
  Write-Host "⚠ 任务已注册但服务没响应，请查看日志：$log"
}
