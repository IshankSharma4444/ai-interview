$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ForegroundInfo {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@

$hwnd = [ForegroundInfo]::GetForegroundWindow()
$targetPid = 0
[ForegroundInfo]::GetWindowThreadProcessId($hwnd, [ref]$targetPid) | Out-Null

$title = New-Object System.Text.StringBuilder 1024
[ForegroundInfo]::GetWindowText($hwnd, $title, $title.Capacity) | Out-Null

$process = 'unknown'
try {
  $process = (Get-Process -Id $targetPid -ErrorAction Stop).ProcessName + '.exe'
} catch {
  $process = 'unknown'
}

[PSCustomObject]@{
  hwnd = [string]$hwnd.ToInt64()
  process = $process
  title = $title.ToString()
} | ConvertTo-Json -Compress
