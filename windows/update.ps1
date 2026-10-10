# 从 GitHub 拉最新代码 → 装依赖 → 编译服务端和扩展 → 重启后台服务
# 编译失败时不会停掉正在运行的旧服务
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$server = Join-Path $root 'server'
$taskName = 'WAB Server'

function Fail($msg) { Write-Host "❌ $msg" -ForegroundColor Red; exit 1 }
function Run($what, [scriptblock]$cmd) {
  Write-Host "`n== $what" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { Fail "$what 失败（旧服务未受影响）" }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail '找不到 git，请先安装 Git for Windows：https://git-scm.com/download/win' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '找不到 node，请先安装 Node.js 20+' }
Set-Location $root
if (-not (Test-Path (Join-Path $root '.git'))) { Fail "$root 不是 git 仓库，请按 README「更新」一节用 git clone 重新安装" }

# ---------- 1. 拉代码 ----------
$old = (git rev-parse HEAD).Trim()
$dirty = git status --porcelain --untracked-files=no
if ($dirty) {
  Write-Host '本地有改动过的文件，更新会和它们冲突：' -ForegroundColor Yellow
  Write-Host $dirty
  Fail '请先撤销这些改动（或执行 git stash）再更新'
}
Run '拉取最新代码' { git pull --ff-only }
$new = (git rev-parse HEAD).Trim()
if ($old -eq $new) {
  Write-Host "`n已经是最新版本（$($new.Substring(0,7))），无需更新。" -ForegroundColor Green
  if ($args -notcontains '-Force') { exit 0 }
  Write-Host '-Force：仍然重新编译并重启' -ForegroundColor Yellow
} else {
  Write-Host "`n本次更新内容：" -ForegroundColor Cyan
  git --no-pager log --oneline "$old..$new"
}

# ---------- 2. 依赖 + 编译 ----------
Run '安装依赖' { npm install --no-audit --no-fund }
Run '编译服务端' { npm run build -w server }
Run '打包扩展' { npm run zip -w extension }

# ---------- 3. 重启服务 ----------
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "`n⚠ 没有找到计划任务「$taskName」（没装开机自启）。" -ForegroundColor Yellow
  Write-Host '  如果服务正开着（start-wab.cmd 的黑窗口），关掉后重新双击 start-wab.cmd 即可。'
} else {
  Write-Host "`n== 重启服务" -ForegroundColor Cyan
  # 计划任务只负责用 VBS 拉起 node，node 是独立进程，要按命令行找到它再停
  $entry = Join-Path $server 'dist\index.js'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName $taskName
  $ok = $false
  for ($i = 0; $i -lt 10 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try { Invoke-RestMethod -Uri 'http://127.0.0.1:3900/api/health' -TimeoutSec 2 | Out-Null; $ok = $true } catch {}
  }
  if ($ok) { Write-Host '✅ 服务已重启：http://127.0.0.1:3900' -ForegroundColor Green }
  else { Write-Host "⚠ 服务没响应，请查看日志：$(Join-Path $server 'data\server.log')" -ForegroundColor Yellow }
}

# ---------- 4. 扩展提醒 ----------
if ($old -ne $new -and (git diff --name-only $old $new -- extension)) {
  Write-Host "`n📦 这次更新包含扩展改动，需要在 AdsPower 里重新上传：" -ForegroundColor Yellow
  Write-Host "   $(Join-Path $root 'extension\wab-extension.zip')"
  Write-Host '   上传后已打开的环境要刷新 WhatsApp Web 页面才会生效。'
}
Write-Host "`n更新完成，当前版本 $($new.Substring(0,7))" -ForegroundColor Green
