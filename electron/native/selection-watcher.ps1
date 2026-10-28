param(
  [string]$OverlayHwnd = '0'
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class DragSelectionWatcher {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT lpPoint);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  public const byte VK_CONTROL = 0x11;
  public const byte VK_C = 0x43;
  public const uint KEYEVENTF_KEYUP = 0x0002;

  public static void SendCopy() {
    keybd_event(VK_CONTROL, 0, 0, 0);
    keybd_event(VK_C, 0, 0, 0);
    Thread.Sleep(20);
    keybd_event(VK_C, 0, KEYEVENTF_KEYUP, 0);
    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
  }
}
"@

$wasDown = $false
$isDragging = $false
$downX = 0
$downY = 0

Write-Output "READY"

while ($true) {
  Start-Sleep -Milliseconds 45
  
  $keyState = [DragSelectionWatcher]::GetAsyncKeyState(1)
  $isDown = ($keyState -band 0x8000) -ne 0
  
  $pt = New-Object DragSelectionWatcher+POINT
  [DragSelectionWatcher]::GetCursorPos([ref]$pt) | Out-Null
  
  if ($isDown) {
    if (-not $wasDown) {
      $wasDown = $true
      $isDragging = $false
      $downX = $pt.X
      $downY = $pt.Y
    } else {
      $dx = [Math]::Abs($pt.X - $downX)
      $dy = [Math]::Abs($pt.Y - $downY)
      if ($dx -gt 8 -or $dy -gt 8) {
        $isDragging = $true
      }
    }
  } else {
    if ($wasDown) {
      $wasDown = $false
      if ($isDragging) {
        $isDragging = $false
        
        $fgHwnd = [DragSelectionWatcher]::GetForegroundWindow()
        $fgStr = [string]$fgHwnd.ToInt64()
        
        # Don't send copy if foreground is the overlay itself
        if ($OverlayHwnd -and $OverlayHwnd -ne '0' -and $fgStr -eq $OverlayHwnd) {
          continue
        }
        
        # Finished mouse drag selection in browser / external window!
        Start-Sleep -Milliseconds 40
        [DragSelectionWatcher]::SendCopy()
        Write-Output "SELECTION_COPIED"
      }
    }
  }
}
