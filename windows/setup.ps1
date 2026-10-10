# WAB 一键安装：检查/安装 Node.js 和 Git → 接上 GitHub（以后能一键更新）→ 装依赖、编译 → 开机自启 → 桌面快捷方式
# 可以重复运行（相当于修复安装）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # 项目根目录
$server = Join-Path $root 'server'
$repoUrl = 'https://github.com/1Time6/wab.git'
$panelUrl = 'http://127.0.0.1:3900'
$zip = Join-Path $root 'extension\wab-extension.zip'
$total = 7

function Step($n, $text) { Write-Host "`n[$n/$total] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  ⚠ $text" -ForegroundColor Yellow }
function Fail($text) {
  Write-Host "`n❌ $text" -ForegroundColor Red
  Write-Host '   如果搞不定，把这个窗口完整截图发给开发者。'
  exit 1
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function WingetInstall($id, $name) {
  if (-not (Has winget)) { return $false }
  Write-Host "  正在自动安装 $name，可能要几分钟。如果弹出「是否允许此应用更改设备」，请点「是」。"
  winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent | Out-Host
  RefreshPath
  return $true
}
# node:sqlite 需要 22.13+ / 23.4+ / 24+
function NodeOk {
  if (-not (Has node)) { return $false }
  $v = [version]((node -p 'process.versions.node').Trim())
  return ($v.Major -ge 24) -or ($v.Major -eq 23 -and $v.Minor -ge 4) -or ($v.Major -eq 22 -and $v.Minor -ge 13)
}

Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '   WAB 一键安装' -ForegroundColor Cyan
Write-Host "   安装位置：$root"
Write-Host '==============================================' -ForegroundColor Cyan
if ($root -match '\\(Downloads|下载)\\' -or $root -match '\\Temp\\') {
  Warn '当前在「下载」或临时文件夹里。建议先把整个文件夹移到 C:\WAB 再运行，否则以后清理下载文件夹会把它删掉。'
  $ans = Read-Host '  仍然在这里安装？输入 y 继续，直接回车退出'
  if ($ans -ne 'y') { exit 0 }
}

# 从 GitHub 下载的 ZIP 解压出来的文件带「来自网络」标记，去掉免得后面的脚本被拦
Get-ChildItem -Path $root -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' } | Unblock-File -ErrorAction SilentlyContinue

# ---------- 1. Node.js ----------
Step 1 '检查 Node.js'
if (-not (NodeOk)) {
  if (Has node) { Warn "现有 Node.js 版本太旧（$((node -v).Trim())），需要 22.13 以上" }
  [void](WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js')
}
if (-not (NodeOk)) {
  Start-Process 'https://nodejs.org/zh-cn/download'
  Fail '没能自动装好 Node.js。已经打开下载页：下载「LTS」版的 Windows 安装包（.msi），一路下一步装完，然后重新双击「一键安装.cmd」。'
}
Ok "Node.js $((node -v).Trim())"

# ---------- 2. Git ----------
Step 2 '检查 Git（以后一键更新要用）'
if (-not (Has git)) { [void](WingetInstall 'Git.Git' 'Git') }
$hasGit = Has git
if ($hasGit) { Ok ((git --version).Trim()) } else { Warn '没装上 Git，不影响使用，但以后没法一键更新。可以到 https://git-scm.com/download/win 手动安装后重新运行本脚本。' }

# ---------- 3. 接上 GitHub ----------
Step 3 '连接 GitHub 仓库'
Set-Location $root
if (Test-Path (Join-Path $root '.git')) {
  Ok '已经连接过了'
} elseif (-not $hasGit) {
  Warn '跳过（没有 Git）'
} else {
  git init -q
  git remote add origin $repoUrl
  git fetch origin main
  if ($LASTEXITCODE -eq 0) {
    git checkout -q -f -B main origin/main
    Ok '已连接，以后双击桌面「WAB 更新」即可更新'
  } else {
    Remove-Item -Recurse -Force (Join-Path $root '.git')
    Warn '连接失败（多半是网络问题）。不影响使用，只是暂时不能一键更新，重新运行本脚本可以再试。'
  }
}

# ---------- 4. 依赖 ----------
Step 4 '下载依赖（第一次比较慢，请耐心等）'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Warn '默认源下载失败，改用国内镜像重试...'
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com
  if ($LASTEXITCODE -ne 0) { Fail '依赖下载失败，请检查网络（开着代理的话试试关掉，或者反过来）后重新运行。' }
}
Ok '依赖已就绪'

# ---------- 5. 编译 ----------
Step 5 '编译服务端、打包扩展'
npm run build -w server
if ($LASTEXITCODE -ne 0) { Fail '服务端编译失败' }
npm run zip -w extension
if ($LASTEXITCODE -ne 0) { Fail '扩展打包失败' }
Ok "扩展安装包：$zip"

# ---------- 6. 开机自启 ----------
Step 6 '注册开机自启并启动服务'
# 重复安装时先停掉旧进程，否则新进程会因端口被占用起不来
$entry = Join-Path $server 'dist\index.js'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$installer = Join-Path $PSScriptRoot 'install-autostart.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $installer
if ($LASTEXITCODE -ne 0) {
  # 部分电脑注册「登录时启动」的计划任务需要管理员权限
  Write-Host '  需要管理员权限，请在弹出的窗口点「是」...'
  try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$installer`""
  } catch { Warn '没有获得管理员权限' }
}
$up = $false
for ($i = 0; $i -lt 10 -and -not $up; $i++) {
  try { Invoke-RestMethod -Uri "$panelUrl/api/health" -TimeoutSec 2 | Out-Null; $up = $true } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { Fail "服务没有启动成功。日志在：$(Join-Path $server 'data\server.log')" }
Ok "服务已启动：$panelUrl（以后开机登录会自动启动）"

# ---------- 7. 桌面快捷方式 ----------
Step 7 '创建桌面快捷方式'
$desktop = [Environment]::GetFolderPath('Desktop')
Set-Content -Path (Join-Path $desktop 'WAB 面板.url') -Encoding ASCII -Value "[InternetShortcut]`r`nURL=$panelUrl/"
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut((Join-Path $desktop 'WAB 更新.lnk'))
$lnk.TargetPath = Join-Path $PSScriptRoot 'update.cmd'
$lnk.WorkingDirectory = $root
$lnk.Save()
$lnk = $sh.CreateShortcut((Join-Path $desktop 'WAB 扩展安装包.lnk'))
$lnk.TargetPath = Join-Path $root 'extension'
$lnk.Save()
Ok '桌面上已有：「WAB 面板」「WAB 更新」「WAB 扩展安装包」'

Write-Host "`n==============================================" -ForegroundColor Green
Write-Host '   ✅ 安装完成！' -ForegroundColor Green
Write-Host '==============================================' -ForegroundColor Green
Write-Host @"

还差最后一步：把扩展装进 AdsPower（详细步骤见「使用教程.md」第三步）
  1. AdsPower → 应用中心 → 上传扩展 → 选 wab-extension.zip（马上会自动帮你打开它所在的文件夹）
  2. 应用到所有跑 WhatsApp 的环境
  3. 打开环境登录 WhatsApp Web，右下角出现绿色「WAB ✓」就成功了

现在会自动打开：WAB 面板 + 扩展所在文件夹
"@
Start-Process $panelUrl
Start-Process explorer.exe -ArgumentList "/select,`"$zip`""
