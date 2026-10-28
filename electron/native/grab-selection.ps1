$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class SelectionGrabber {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

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
"@ -ReferencedAssemblies "System.Windows.Forms"

function Grab-Selection {
  try {
    # Send Ctrl+C to active foreground window
    [SelectionGrabber]::SendCopy()
    Start-Sleep -Milliseconds 60
    
    # Read text from clipboard
    $text = [System.Windows.Forms.Clipboard]::GetText()
    if ($text) {
      return $text
    }
  } catch {
    # ignore
  }
  return ""
}

$result = Grab-Selection
if ($result) {
  Write-Output $result
} else {
  Write-Output "EMPTY"
}
