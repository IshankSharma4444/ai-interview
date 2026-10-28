const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const chromeCandidates = [
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
];

const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Focus Test Page</title>
  <style>
    body { font: 16px/1.5 Segoe UI, sans-serif; padding: 40px; }
    input { width: 560px; padding: 12px; font-size: 18px; }
  </style>
</head>
<body>
  <h1>Chrome focus target</h1>
  <p>If text appears below, the assistant leaked keystrokes into Chrome.</p>
  <input id="probe" autofocus placeholder="Chrome input - must stay empty">
  <script>
    const report = (url, value) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: String(value)
    }).catch(() => {});
    document.addEventListener('keydown', (event) => report('/key', event.key));
    document.getElementById('probe').addEventListener('input', (event) => report('/input', event.target.value));
    window.addEventListener('focus', () => report('/focus', '1'));
    report('/loaded', '1');
  </script>
</body>
</html>`;

const log = { loaded: 0, keys: [], inputs: [], focus: 0 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  return chromeCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
        return;
      }

      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/loaded') log.loaded += 1;
        if (request.url === '/key') log.keys.push(body);
        if (request.url === '/input') log.inputs.push(body);
        if (request.url === '/focus') log.focus += 1;
        response.writeHead(204);
        response.end();
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor(check, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (check()) return true;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writePowerShellScript() {
  const file = path.join(os.tmpdir(), `floating-assistant-activate-${Date.now()}.ps1`);
  const script = `
param([int]$ControlPort)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FocusWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

  public static bool ForceForeground(IntPtr hWnd) {
    IntPtr foreground = GetForegroundWindow();
    uint foregroundPid;
    uint targetPid;
    uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid);
    uint targetThread = GetWindowThreadProcessId(hWnd, out targetPid);
    bool attached = false;
    if (foregroundThread != 0 && targetThread != 0 && foregroundThread != targetThread) {
      attached = AttachThreadInput(foregroundThread, targetThread, true);
    }
    ShowWindow(hWnd, 9);
    bool ok = SetForegroundWindow(hWnd);
    if (attached) AttachThreadInput(foregroundThread, targetThread, false);
    return ok && GetForegroundWindow() == hWnd;
  }
}
"@

$chrome = Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like '*Focus Test Page*' } |
  Select-Object -First 1

if (-not $chrome) {
  Write-Output 'ACTIVATE_FAILED no Chrome window titled Focus Test Page'
  exit 2
}

if (-not [FocusWin32]::ForceForeground($chrome.MainWindowHandle)) {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.AppActivate($chrome.Id) | Out-Null
  } catch { }
  Start-Sleep -Milliseconds 500
  if (-not [FocusWin32]::ForceForeground($chrome.MainWindowHandle)) {
    Write-Output 'ACTIVATE_FAILED Chrome did not become foreground'
    exit 3
  }
}

Start-Sleep -Milliseconds 600
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('hello')
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Start-Sleep -Milliseconds 500

if ([FocusWin32]::GetForegroundWindow() -ne $chrome.MainWindowHandle) {
  Write-Output 'ACTIVATE_FAILED foreground changed during typing'
  exit 4
}

# Query the app while this script is still alive and Chrome is still
# foreground. This avoids a false failure caused by the test console taking
# focus back when the injection process exits.
$result = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/query" -f $ControlPort) -Method Get -TimeoutSec 15
Write-Output ("QUERY_RESULT " + ($result | ConvertTo-Json -Compress -Depth 8))
Write-Output 'TYPED'
`;

  fs.writeFileSync(file, script, 'utf8');
  return file;
}

function runActivation(scriptFile, controlPort) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, '-ControlPort', String(controlPort)],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }
  );

  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

function cleanupChrome(userDataDir) {
  const escaped = userDataDir.replace(/'/g, "''");
  const command = `
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${escaped}') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
    timeout: 15000
  });
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Chrome may still hold a lock; the OS temp cleaner can remove it later.
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome not found. Install Chrome or adjust the path in scripts/focus-test.js.');
    process.exit(2);
  }

  const server = await startServer();
  const port = server.address().port;
  const userDataDir = path.join(os.tmpdir(), `floating-assistant-focus-${Date.now()}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  console.log(`[test] Chrome: ${chrome}`);
  console.log(`[test] test page: http://127.0.0.1:${port}/`);

  const chromeProcess = spawn(
    chrome,
    [
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      `--app=http://127.0.0.1:${port}/`
    ],
    { stdio: 'ignore', windowsHide: false }
  );

  let electronProcess = null;
  let electronOutput = '';
  let result = null;
  let resultResolve = null;
  let ready = false;
  let controlPort = null;

  const resultPromise = new Promise((resolve) => {
    resultResolve = resolve;
  });

  try {
    await waitFor(() => log.loaded > 0, 20000, 'Chrome to load the test page');
    await delay(1500);
    console.log('[test] Chrome page loaded. Starting Electron overlay.');

    const electronPath = require('electron');
    electronProcess = spawn(electronPath, ['.'], {
      cwd: root,
      env: { ...process.env, FOCUS_TEST: '1', RENDERER_MODE: 'file' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false
    });

    const pipe = (stream, prefix) => {
      stream.setEncoding('utf8');
      const reader = readline.createInterface({ input: stream });
      reader.on('line', (line) => {
        electronOutput += `${line}\n`;
        console.log(`[electron] ${line}`);

        if (line.startsWith('FOCUS_TEST_READY ') && !ready) {
          ready = true;
          try {
            const payload = JSON.parse(line.slice('FOCUS_TEST_READY '.length));
            controlPort = payload.controlPort || null;
          } catch (error) {
            controlPort = null;
          }

          runTest().catch((error) => {
            result = { pass: false, reason: String(error) };
            resultResolve(result);
          });
        }
      });
    };

    pipe(electronProcess.stdout, 'out');
    pipe(electronProcess.stderr, 'err');

    electronProcess.on('exit', (code) => {
      if (!result) {
        result = { pass: false, reason: `Electron exited early with code ${code}` };
        resultResolve(result);
      }
    });

    async function runTest() {
      if (!controlPort) {
        throw new Error('Electron did not report a test control port');
      }

      console.log('[test] Activating Chrome and injecting "hello" + Enter.');
      const scriptFile = writePowerShellScript();
      const injection = runActivation(scriptFile, controlPort);
      console.log('[test] injection stdout:', injection.stdout || '(none)');
      if (injection.stderr) console.log('[test] injection stderr:', injection.stderr);

      const lines = injection.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.includes('TYPED')) {
        throw new Error(`Could not route test through Chrome: ${injection.stdout || injection.stderr || 'unknown error'}`);
      }

      const queryLine = lines.find((line) => line.startsWith('QUERY_RESULT '));
      if (!queryLine) {
        throw new Error('The injection script did not return an app query result');
      }

      const payload = JSON.parse(queryLine.slice('QUERY_RESULT '.length));
      result = evaluate(payload);
      resultResolve(result);
    }

    const timeout = delay(30000).then(() => {
      if (!result) {
        result = { pass: false, reason: 'Timed out waiting for focus test result' };
        resultResolve(result);
      }
    });

    result = await Promise.race([resultPromise, timeout]);
  } finally {
    if (controlPort) {
      try {
        await fetch(`http://127.0.0.1:${controlPort}/quit`, {
          signal: AbortSignal.timeout(3000)
        });
      } catch {
        // ignored
      }
    }

    await delay(500);
    if (electronProcess && !electronProcess.killed) {
      try {
        electronProcess.kill();
      } catch {
        // ignored
      }
    }

    cleanupChrome(userDataDir);
    server.close();

    if (!chromeProcess.killed) {
      try {
        chromeProcess.kill();
      } catch {
        // ignored
      }
    }
  }

  const output = {
    testedAt: new Date().toISOString(),
    automated: true,
    result,
    chromePage: {
      loaded: log.loaded,
      receivedKeys: log.keys,
      receivedInput: log.inputs,
      focusEvents: log.focus
    },
    electronLogTail: electronOutput.trim().split(/\r?\n/).slice(-20)
  };

  const outFile = path.join(root, 'focus-test-result.json');
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log('\n=== FOCUS TEST RESULT ===');
  console.log(JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  process.exit(result && result.pass ? 0 : 1);
}

function evaluate(payload) {
  const foregroundProcess = String(payload.foreground && payload.foreground.process || '').toLowerCase();
  const foregroundTitle = String(payload.foreground && payload.foreground.title || '');
  const chromeForeground = foregroundProcess.includes('chrome');
  const overlayFocused = payload.overlayFocused === true;
  const assistantReceived = payload.lastSent === 'hello';
  const leakedKeys = log.keys.length;
  const leakedInput = log.inputs.length;

  const checks = {
    chromeRemainsForeground: chromeForeground,
    overlayNeverFocused: !overlayFocused,
    overlayVisible: payload.visible === true,
    keyRoutingActive: payload.routingActive === true,
    assistantReceivedTypedText: assistantReceived,
    chromeReceivedNoKeys: leakedKeys === 0,
    chromeReceivedNoInput: leakedInput === 0
  };

  const pass = Object.values(checks).every(Boolean);

  return {
    pass,
    checks,
    observed: {
      foregroundProcess: foregroundProcess || '(none)',
      foregroundTitle,
      overlayFocused,
      routingActive: payload.routingActive,
      assistantInput: payload.input,
      assistantLastSent: payload.lastSent,
      assistantResponse: payload.response,
      chromeReceivedKeys: log.keys,
      chromeReceivedInput: log.inputs
    }
  };
}

main().catch((error) => {
  console.error('[test] failed:', error);
  process.exit(1);
});
