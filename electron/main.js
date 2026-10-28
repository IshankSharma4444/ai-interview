const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, clipboard } = require('electron');
const { applyExcludeFromCapture } = require('./native/exclude-from-capture');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const useDevServer = !app.isPackaged && process.env.RENDERER_MODE !== 'file';
const isFocusTest = process.env.FOCUS_TEST === '1';
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const TOGGLE_ACCELERATOR = 'CommandOrControl+Shift+Space';
const FOREGROUND_SCRIPT = path.join(__dirname, 'native', 'foreground.ps1');

let win = null;
let routingActive = false;
let routingFailures = [];
let registeredRoutingKeys = [];
let lastForeground = null;
let transitioning = false;
let controlServer = null;
let captureStatus = {
  protected: false,
  hwndCount: 0,
  method: null,
  error: null
};
let captureTimer = null;
let lastCaptureLog = '';

function buildRoutingKeys() {
  const entries = [];
  const add = (accel, action) => entries.push({ accel, action });

  for (let index = 0; index < 26; index += 1) {
    const lower = String.fromCharCode(97 + index);
    const upper = lower.toUpperCase();
    add(upper, { type: 'text', value: lower });
    add(`Shift+${upper}`, { type: 'text', value: upper });
  }

  const shiftedDigits = ')!@#$%^&*(';
  for (let digit = 0; digit < 10; digit += 1) {
    add(String(digit), { type: 'text', value: String(digit) });
    add(`Shift+${digit}`, { type: 'text', value: shiftedDigits[digit] });
  }

  const punctuation = [
    [',', ','],
    ['.', '.'],
    ['/', '/'],
    [';', ';'],
    ["'", "'"],
    ['[', '['],
    [']', ']'],
    ['\\', '\\'],
    ['-', '-'],
    ['=', '='],
    ['`', '`']
  ];

  const shiftedPunctuation = {
    ',': '<',
    '.': '>',
    '/': '?',
    ';': ':',
    "'": '"',
    '[': '{',
    ']': '}',
    '\\': '|',
    '-': '_',
    '=': '+',
    '`': '~'
  };

  for (const [key, value] of punctuation) {
    add(key, { type: 'text', value });
    add(`Shift+${key}`, { type: 'text', value: shiftedPunctuation[key] });
  }

  add('Space', { type: 'text', value: ' ' });
  add('Shift+Space', { type: 'text', value: ' ' });
  add('Backspace', { type: 'backspace' });
  add('Shift+Backspace', { type: 'backspace' });
  add('Enter', { type: 'enter' });
  add('Shift+Enter', { type: 'enter' });
  add('Escape', { type: 'escape' });
  add('Shift+Escape', { type: 'escape' });

  return entries;
}

const ROUTING_KEYS = buildRoutingKeys();

function logCaptureStatus(reason) {
  const summary = JSON.stringify({
    reason,
    protected: captureStatus.protected,
    method: captureStatus.method,
    hwndCount: captureStatus.hwndCount,
    excluded: captureStatus.excluded,
    monitorFallback: captureStatus.monitorFallback,
    failed: captureStatus.failed,
    error: captureStatus.error
  });
  if (summary === lastCaptureLog) return;
  lastCaptureLog = summary;
  console.log('[capture-exclusion]', summary);
}

function protectFromCapture(reason) {
  if (!win || win.isDestroyed()) {
    captureStatus = { protected: false, hwndCount: 0, method: null, error: 'No window' };
    return captureStatus;
  }

  try {
    if (typeof win.setOpacity === 'function') {
      win.setOpacity(1);
    }
    win.setContentProtection(true);
  } catch (err) {
    console.error('[capture-exclusion] setContentProtection failed:', err && err.message ? err.message : err);
  }

  const nativeResult = applyExcludeFromCapture(win);
  captureStatus = {
    protected: Boolean(nativeResult.protected),
    hwndCount: nativeResult.hwndCount || 0,
    excluded: nativeResult.excluded || 0,
    monitorFallback: nativeResult.monitorFallback || 0,
    failed: nativeResult.failed || 0,
    method: nativeResult.method || 'electron',
    error: nativeResult.error || null
  };

  logCaptureStatus(reason);
  updateStatus();
  return captureStatus;
}

function startCaptureProtectionLoop() {
  if (captureTimer) return;
  captureTimer = setInterval(() => {
    if (win && !win.isDestroyed() && win.isVisible()) {
      protectFromCapture('tick');
    }
  }, 1500);
}

function stopCaptureProtectionLoop() {
  if (!captureTimer) return;
  clearInterval(captureTimer);
  captureTimer = null;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 480;
  const height = 560;
  const x = workArea.x + workArea.width - width - 24;
  const y = workArea.y + Math.round((workArea.height - height) / 2);

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    backgroundColor: '#0b0d12',
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    opacity: 1,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: useDevServer
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setMenuBarVisibility(false);

  win.on('closed', () => {
    stopCaptureProtectionLoop();
    win = null;
  });
  win.on('show', () => protectFromCapture('show'));
  win.on('ready-to-show', () => protectFromCapture('ready-to-show'));
  win.on('focus', updateStatus);
  win.on('blur', updateStatus);
  win.webContents.on('did-finish-load', () => protectFromCapture('did-finish-load'));

  protectFromCapture('create');

  const loading = useDevServer
    ? win.loadURL(DEV_URL)
    : win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  loading.catch((error) => {
    console.error('[load] failed:', error);
  });

  return win;
}

function getStatus() {
  return {
    visible: Boolean(win && win.isVisible()),
    overlayFocused: Boolean(win && win.isFocused()),
    routingActive,
    routingFailures,
    foreground: lastForeground,
    captureProtected: Boolean(captureStatus.protected)
  };
}

function updateStatus() {
  const status = getStatus();
  if (win && !win.isDestroyed()) {
    win.webContents.send('overlay:status', status);
  }
  return status;
}

function queryForeground() {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        FOREGROUND_SCRIPT
      ],
      { windowsHide: true, timeout: 10000 },
      (error, stdout) => {
        if (error) {
          console.error('[foreground] query failed:', error.message);
          resolve(null);
          return;
        }

        try {
          const clean = String(stdout).replace(/^\uFEFF/, '').trim();
          resolve(JSON.parse(clean));
        } catch (parseError) {
          console.error('[foreground] parse failed:', parseError.message);
          resolve(null);
        }
      }
    );
  });
}

function handleRoutedKey(action) {
  if (!routingActive || !win || win.isDestroyed()) return;

  if (action.type === 'escape') {
    hideOverlay();
    return;
  }

  if (action.type === 'text') {
    win.webContents.send('overlay:key', { text: action.value });
    return;
  }

  if (action.type === 'backspace') {
    win.webContents.send('overlay:key', { key: 'Backspace' });
    return;
  }

  if (action.type === 'enter') {
    win.webContents.send('overlay:key', { key: 'Enter' });
  }
}

function startRouting() {
  if (routingActive) return { active: true, failed: [] };

  const failures = [];
  registeredRoutingKeys = [];

  for (const entry of ROUTING_KEYS) {
    try {
      const registered = globalShortcut.register(entry.accel, () => {
        handleRoutedKey(entry.action);
      });

      if (registered) {
        registeredRoutingKeys.push(entry.accel);
      } else {
        failures.push(entry.accel);
      }
    } catch (error) {
      failures.push(entry.accel);
    }
  }

  routingFailures = failures;
  routingActive = registeredRoutingKeys.length > 0;

  if (failures.length > 0) {
    console.error('[routing] keys that could not be registered:', failures.join(', '));
  }

  updateStatus();
  return { active: routingActive, failed: failures };
}

function stopRouting() {
  for (const accelerator of registeredRoutingKeys) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // ignored
    }
  }

  registeredRoutingKeys = [];
  routingFailures = [];
  routingActive = false;
  updateStatus();
}

async function showOverlay() {
  if (!win) createWindow();
  protectFromCapture('before-show');
  if (win && win.isVisible()) {
    startCaptureProtectionLoop();
    return;
  }

  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  protectFromCapture('after-show');
  startCaptureProtectionLoop();

  const routing = startRouting();
  updateStatus();

  const foreground = await queryForeground();
  if (foreground) {
    lastForeground = foreground;
    if (win && !win.isDestroyed()) {
      win.webContents.send('overlay:foreground', foreground);
    }
  }

  console.log(
    '[focus] overlayFocused=%s routing=%s foreground=%s',
    win ? win.isFocused() : null,
    routing.active,
    foreground ? `${foreground.process} "${foreground.title}"` : 'unknown'
  );

  updateStatus();
}

function hideOverlay() {
  if (!win) return;
  stopRouting();
  stopCaptureProtectionLoop();
  win.hide();
  updateStatus();
}

async function toggleOverlay() {
  if (transitioning) return;
  transitioning = true;

  try {
    if (win && win.isVisible()) {
      hideOverlay();
      setTimeout(() => {
        transitioning = false;
      }, 50);
    } else {
      showOverlay().finally(() => {
        setTimeout(() => {
          transitioning = false;
        }, 50);
      });
    }
  } catch {
    setTimeout(() => {
      transitioning = false;
    }, 50);
  }
}

function registerIpc() {
  ipcMain.handle('overlay:status', () => getStatus());
  ipcMain.handle('clipboard:getText', () => {
    try {
      return clipboard.readText();
    } catch {
      return '';
    }
  });
  ipcMain.handle('clipboard:setText', (_event, text) => {
    try {
      if (typeof text === 'string') {
        clipboard.writeText(text);
      }
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('ai:chat', async (_event, prompt) => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return { error: 'Empty prompt.' };
    }

    if (isFocusTest) {
      return { text: `Focus-test echo: ${prompt.trim()}` };
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return { error: 'Missing GROQ_API_KEY in .env' };
    }

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt.trim() }],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        return { error: `Groq error (${response.status}): ${errorText}` };
      }

      const data = await response.json();
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) {
        return { error: 'Empty response from Groq.' };
      }

      return { text: content };
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.on('overlay:hide', () => {
    hideOverlay();
  });

  ipcMain.on('app:quit', () => {
    app.quit();
  });

  ipcMain.on('focus:log', (_event, note) => {
    console.log('[renderer]', String(note));
  });
}

function buildTestPayload(foreground, state) {
  return {
    ...(state || {}),
    foreground,
    overlayFocused: win ? win.isFocused() : null,
    visible: win ? win.isVisible() : false,
    routingActive,
    routingFailures
  };
}

function startControlServer() {
  return new Promise((resolve, reject) => {
    controlServer = http.createServer(async (request, response) => {
      try {
        if (request.url === '/ping') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"ok":true}');
          return;
        }

        if (request.url === '/query') {
          const foreground = await queryForeground();
          let state = null;

          try {
            state = await win.webContents.executeJavaScript(
              'window.__assistantTestState ? window.__assistantTestState() : null'
            );
          } catch (error) {
            state = { error: String(error) };
          }

          const payload = buildTestPayload(foreground, state);
          console.log('FOCUS_TEST_RESULT ' + JSON.stringify(payload));
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(payload));
          return;
        }

        if (request.url === '/quit') {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end('ok');
          setTimeout(() => app.quit(), 100);
          return;
        }

        response.writeHead(404);
        response.end('not found');
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });

    controlServer.on('error', reject);
    controlServer.listen(0, '127.0.0.1', () => resolve(controlServer.address().port));
  });
}

async function bootstrap() {
  registerIpc();
  createWindow();

  const registered = globalShortcut.register(TOGGLE_ACCELERATOR, toggleOverlay);
  if (!registered) {
    console.error('[shortcut] failed to register', TOGGLE_ACCELERATOR);
  }

  app.on('activate', () => {
    if (!win) createWindow();
  });

  if (isFocusTest) {
    win.webContents.once('did-finish-load', async () => {
      const controlPort = await startControlServer();
      await showOverlay();

      console.log(
        'FOCUS_TEST_READY ' +
          JSON.stringify({
            controlPort,
            visible: win ? win.isVisible() : false,
            overlayFocused: win ? win.isFocused() : null,
            routingActive,
            routingFailures
          })
      );
    });
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    toggleOverlay();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[startup] failed:', error);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (controlServer) {
    try {
      controlServer.close();
    } catch {
      // ignored
    }
  }
});
