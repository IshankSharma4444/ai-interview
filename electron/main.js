const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, clipboard } = require('electron');
const { applyExcludeFromCapture } = require('./native/exclude-from-capture');
const { SessionManager } = require('../src/services/session-manager');
const { KeyManager } = require('../src/services/key-manager');
const { providers } = require('../src/services/ai-provider');

const sessionManager = new SessionManager();
const keyManager = new KeyManager();

// Load env keys into key manager
function loadEnvKeys() {
  if (process.env.GROQ_API_KEY) {
    keyManager.setKeys('groq', [{ id: 'env_groq', value: process.env.GROQ_API_KEY, enabled: true }]);
  }
  if (process.env.GEMINI_API_KEY) {
    keyManager.setKeys('gemini', [{ id: 'env_gemini', value: process.env.GEMINI_API_KEY, enabled: true }]);
  }
  if (process.env.OPENAI_API_KEY) {
    keyManager.setKeys('openai', [{ id: 'env_openai', value: process.env.OPENAI_API_KEY, enabled: true }]);
  }
}

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const useDevServer = !app.isPackaged && process.env.RENDERER_MODE !== 'file';
const isFocusTest = process.env.FOCUS_TEST === '1';
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';
const TOGGLE_ACCELERATOR = 'CommandOrControl+Shift+Space';
const FOREGROUND_SCRIPT = path.join(__dirname, 'native', 'foreground.ps1');
const SELECTION_WATCHER_SCRIPT = path.join(__dirname, 'native', 'selection-watcher.ps1');
const GRAB_SELECTION_SCRIPT = path.join(__dirname, 'native', 'grab-selection.ps1');

let win = null;
let selectionWatcherProcess = null;
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
  add('Left', { type: 'arrow-left' });
  add('Right', { type: 'arrow-right' });
  add('Up', { type: 'arrow-up' });
  add('Down', { type: 'arrow-down' });

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
  const width = 580;
  const height = 660;
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
    resizable: true,
    minWidth: 380,
    minHeight: 260,
    maxWidth: 1600,
    maxHeight: 1400,
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
    stopSelectionWatcher();
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

  startSelectionWatcher();
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

function startSelectionWatcher() {
  if (selectionWatcherProcess) return;
  try {
    const overlayHwnd = win && !win.isDestroyed() && typeof win.getNativeWindowHandle === 'function'
      ? String(win.getNativeWindowHandle().readInt32LE(0))
      : '0';

    selectionWatcherProcess = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SELECTION_WATCHER_SCRIPT,
        '-OverlayHwnd',
        overlayHwnd
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    selectionWatcherProcess.stdout.on('data', (chunk) => {
      const msg = chunk.toString();
      if (msg.includes('SELECTION_COPIED')) {
        setTimeout(() => {
          try {
            if (win && !win.isDestroyed()) {
              const text = clipboard.readText();
              if (text && text.trim()) {
                win.webContents.send('clipboard:changed', text.trim());
              }
            }
          } catch {}
        }, 70);
      }
    });

    selectionWatcherProcess.on('exit', () => {
      selectionWatcherProcess = null;
    });
  } catch (err) {
    console.error('[selection-watcher] error starting:', err && err.message ? err.message : err);
  }
}

function stopSelectionWatcher() {
  if (selectionWatcherProcess) {
    try {
      selectionWatcherProcess.kill();
    } catch {}
    selectionWatcherProcess = null;
  }
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
    return;
  }

  if (action.type === 'arrow-left') {
    win.webContents.send('overlay:key', { key: 'ArrowLeft' });
    return;
  }

  if (action.type === 'arrow-right') {
    win.webContents.send('overlay:key', { key: 'ArrowRight' });
    return;
  }

  if (action.type === 'arrow-up') {
    win.webContents.send('overlay:key', { key: 'ArrowUp' });
    return;
  }

  if (action.type === 'arrow-down') {
    win.webContents.send('overlay:key', { key: 'ArrowDown' });
    return;
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
  sessionManager.init();

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

  ipcMain.handle('clipboard:copyForegroundSelection', () => {
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GRAB_SELECTION_SCRIPT],
        { windowsHide: true, timeout: 4000 },
        (_err, stdout) => {
          setTimeout(() => {
            try {
              const text = clipboard.readText() || (stdout ? String(stdout).trim() : '');
              resolve(text);
            } catch {
              resolve('');
            }
          }, 50);
        }
      );
    });
  });

  let lastWatchedClipboard = '';
  setInterval(() => {
    try {
      if (win && !win.isDestroyed()) {
        const text = clipboard.readText();
        if (text && text.trim() && text !== lastWatchedClipboard) {
          lastWatchedClipboard = text;
          win.webContents.send('clipboard:changed', text);
        }
      }
    } catch {}
  }, 350);

  ipcMain.handle('session:new', () => sessionManager.newSession());
  ipcMain.handle('session:state', () => sessionManager.getState());
  ipcMain.handle('session:switch', (_e, id) => sessionManager.switchSession(id));

  ipcMain.handle('window:resize', (_e, { width, height }) => {
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      win.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: Math.max(380, width || bounds.width),
        height: Math.max(260, height || bounds.height)
      });
      return true;
    }
    return false;
  });

  ipcMain.handle('window:getBounds', () => {
    return win && !win.isDestroyed() ? win.getBounds() : null;
  });

  ipcMain.handle('window:focus', () => false);

  ipcMain.handle('keys:add', (_e, payload) => {
    if (!payload || !payload.provider || !payload.key) return false;
    const list = keyManager.keys[payload.provider] || [];
    keyManager.setKeys(payload.provider, [...list, { id: `k_${Date.now()}`, value: payload.key, enabled: true }]);
    return true;
  });
  ipcMain.handle('keys:remove', (_e, payload) => {
    if (!payload || !payload.provider || !payload.id) return false;
    keyManager.removeKey(payload.provider, payload.id);
    return true;
  });
  ipcMain.handle('keys:status', () => {
    return {
      groq: keyManager.getKeysStatus('groq'),
      gemini: keyManager.getKeysStatus('gemini'),
      openai: keyManager.getKeysStatus('openai')
    };
  });
  ipcMain.handle('keys:test', async (_e, payload) => {
    if (!payload || !payload.provider) return { ok: false };
    const provider = payload.provider;
    const prov = providers[provider];
    if (!prov) return { ok: false };
    const key = keyManager.getUsableKey(provider);
    if (!key) return { ok: false, error: 'no usable key' };
    try {
      const messages = [{ role: 'user', content: 'ping' }];
      const resp = await prov.call({ apiKey: key.value, model: prov.defaultModel, messages });
      if (resp.status === 401) { keyManager.markInvalid(provider, key.id); return { ok: false, reason: 'invalid' }; }
      if (resp.status === 429) { keyManager.markRateLimited(provider, key.id, 60); return { ok: false, reason: 'rate_limited' }; }
      const content = prov.parse(resp);
      if (content) return { ok: true };
      return { ok: false };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('ai:chat', async (_event, payload) => {
    const p = typeof payload === 'string' ? { prompt: payload, provider: process.env.PROVIDER || 'groq', model: process.env.MODEL || process.env.GROQ_MODEL || process.env.GEMINI_MODEL || process.env.OPENAI_MODEL } : payload || {};
    const prompt = typeof p.prompt === 'string' ? p.prompt : '';
    if (!prompt.trim()) {
      return { error: 'Empty prompt.' };
    }

    if (isFocusTest) {
      return { text: `Focus-test echo: ${prompt.trim()}` };
    }

    const providerName = p.provider || process.env.PROVIDER || 'groq';
    const prov = providers[providerName];
    if (!prov) {
      return { error: 'Unknown provider.' };
    }
    let model = p.model || process.env.MODEL;
    if (!model) {
      if (providerName === 'groq') model = process.env.GROQ_MODEL || prov.defaultModel;
      else if (providerName === 'gemini') model = process.env.GEMINI_MODEL || prov.defaultModel;
      else if (providerName === 'openai') model = process.env.OPENAI_MODEL || prov.defaultModel;
      else model = prov.defaultModel;
    }

    const history = sessionManager.getMessagesForRequest();
    const messages = [...history, { role: 'user', content: prompt.trim() }];

    const maxRetries = 3;
    let attempts = 0;
    while (attempts < maxRetries) {
      attempts += 1;
      const key = keyManager.getUsableKey(providerName);
      if (!key) break;
      try {
        const resp = await prov.call({ apiKey: key.value, model, messages });
        if (resp.status === 429) {
          const retryAfter = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
          keyManager.markRateLimited(providerName, key.id, retryAfter ? parseInt(retryAfter, 10) : null);
          if (attempts >= maxRetries) break;
          await new Promise((r) => setTimeout(r, 500 * attempts));
          continue;
        }
        if (resp.status === 401) {
          keyManager.markInvalid(providerName, key.id);
          if (attempts >= maxRetries) break;
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (resp.status === 403) {
          if (attempts >= maxRetries) break;
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (resp.status >= 500) {
          if (attempts >= maxRetries) break;
          await new Promise((r) => setTimeout(r, 500 * attempts));
          continue;
        }
        if (resp.status === 400) {
          const msg = resp.data && resp.data.error && resp.data.error.message ? resp.data.error.message : `Provider error (${resp.status})`;
          return { error: msg };
        }
        const content = prov.parse(resp);
        if (content) {
          sessionManager.addMessage('user', prompt.trim());
          sessionManager.addMessage('assistant', content);
          return { text: content };
        }
        break;
      } catch (error) {
        if (attempts >= maxRetries) break;
        await new Promise((r) => setTimeout(r, 300 * attempts));
        continue;
      }
    }

    if (p.fallback && providerName !== 'groq') {
      try {
        const fallbackProv = providers['groq'];
        const key = keyManager.getUsableKey('groq');
        if (key) {
          const resp = await fallbackProv.call({ apiKey: key.value, model: fallbackProv.defaultModel, messages });
          const content = fallbackProv.parse(resp);
          if (content) {
            sessionManager.addMessage('user', prompt.trim());
            sessionManager.addMessage('assistant', content);
            return { text: content };
          }
        }
      } catch {}
    }

    const envKey = process.env.GROQ_API_KEY;
    if (envKey && providerName === 'groq') {
      try {
        const resp = await providers.groq.call({ apiKey: envKey, model, messages });
        const content = providers.groq.parse(resp);
        if (content) {
          sessionManager.addMessage('user', prompt.trim());
          sessionManager.addMessage('assistant', content);
          return { text: content };
        }
        if (resp.status === 429 || resp.status >= 500) return { error: 'Rate limit or provider error. Try another key or later.' };
        if (resp.status === 401) return { error: 'Invalid API key.' };
        const detail = resp.data && resp.data.error && resp.data.error.message ? resp.data.error.message : `Groq error (${resp.status})`;
        return { error: detail };
      } catch (error) {
        return { error: String(error && error.message ? error.message : error) };
      }
    }

    return { error: 'All configured keys unavailable or request failed.' };
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
  loadEnvKeys();
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
  stopSelectionWatcher();
  globalShortcut.unregisterAll();
  if (controlServer) {
    try {
      controlServer.close();
    } catch {
      // ignored
    }
  }
});
