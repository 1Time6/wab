import { execFile, spawn } from 'node:child_process';

/**
 * 系统通知：macOS 用 osascript，Windows 用 PowerShell 托盘气泡。失败静默。
 * 标题/内容通过环境变量传给 PowerShell，避免引号转义问题。
 */
export function notifyMac(title: string, body: string) {
  if (process.env.WAB_NOTIFY === '0') return;
  if (process.platform === 'darwin') {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Ping"`], () => {});
    return;
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Warning',
      '$n.Visible = $true',
      '$n.ShowBalloonTip(8000, $env:WAB_NT, $env:WAB_NB, [System.Windows.Forms.ToolTipIcon]::Warning)',
      'Start-Sleep -Seconds 9',
      '$n.Dispose()',
    ].join('; ');
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { env: { ...process.env, WAB_NT: title, WAB_NB: body }, detached: true, stdio: 'ignore', windowsHide: true },
      );
      child.on('error', () => {});
      child.unref();
    } catch {}
  }
}

export const notify = notifyMac;
