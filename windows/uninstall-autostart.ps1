$taskName = 'WAB Server'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine -like '*server\dist\index.js*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host '已停止并移除 WAB 开机自启'
