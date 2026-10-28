const WDA_NONE = 0x00;
const WDA_MONITOR = 0x01;
const WDA_EXCLUDEFROMCAPTURE = 0x11;
const GW_CHILD = 5;
const GW_HWNDNEXT = 2;

let api = null;
let loadError = null;

function loadApi() {
  if (api || loadError) return api;

  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      SetWindowDisplayAffinity: user32.func(
        'int __stdcall SetWindowDisplayAffinity(uintptr_t hWnd, uint32_t dwAffinity)'
      ),
      GetWindowDisplayAffinity: user32.func(
        'int __stdcall GetWindowDisplayAffinity(uintptr_t hWnd, _Out_ uint32_t *pdwAffinity)'
      ),
      GetWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32_t uCmd)'),
      GetParent: user32.func('uintptr_t __stdcall GetParent(uintptr_t hWnd)')
    };
    return api;
  } catch (error) {
    loadError = error && error.message ? error.message : String(error);
    return null;
  }
}

function hwndFromHandle(nativeHandle) {
  if (!nativeHandle) return 0n;
  const buffer = Buffer.isBuffer(nativeHandle) ? nativeHandle : Buffer.from(nativeHandle);
  if (buffer.length >= 8) return buffer.readBigUInt64LE(0);
  if (buffer.length >= 4) return BigInt(buffer.readUInt32LE(0));
  return 0n;
}

function toHwnd(value) {
  if (value === null || value === undefined || value === 0 || value === 0n) return 0n;
  try {
    const hwnd = typeof value === 'bigint' ? value : BigInt(value);
    return hwnd === 0n ? 0n : hwnd;
  } catch {
    return 0n;
  }
}

function isTopLevel(hwnd) {
  const user32 = loadApi();
  return toHwnd(user32.GetParent(hwnd)) === 0n;
}

function collectHwnds(rootHwnd) {
  const user32 = loadApi();
  const found = [];
  const seen = new Set();
  const stack = [rootHwnd];

  while (stack.length > 0) {
    const current = toHwnd(stack.pop());
    if (!current) continue;
    const key = current.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(current);

    let child = toHwnd(user32.GetWindow(current, GW_CHILD));
    while (child) {
      stack.push(child);
      child = toHwnd(user32.GetWindow(child, GW_HWNDNEXT));
    }
  }

  return found;
}

function readAffinity(hwnd) {
  const user32 = loadApi();
  const slot = [0];
  const ok = user32.GetWindowDisplayAffinity(hwnd, slot);
  if (!ok) return null;
  return slot[0];
}

function setAffinity(hwnd, affinity) {
  const user32 = loadApi();
  return Boolean(user32.SetWindowDisplayAffinity(hwnd, affinity));
}

function applyExcludeFromCapture(browserWindow) {
  if (!browserWindow || typeof browserWindow.getNativeWindowHandle !== 'function') {
    return { protected: false, hwndCount: 0, method: null, error: 'No window handle' };
  }

  const user32 = loadApi();
  if (!user32) {
    return {
      protected: false,
      hwndCount: 0,
      method: 'electron',
      error: loadError || 'koffi unavailable'
    };
  }

  const root = hwndFromHandle(browserWindow.getNativeWindowHandle());
  if (!root) {
    return { protected: false, hwndCount: 0, method: 'native', error: 'Empty HWND' };
  }

  const hwnds = collectHwnds(root).filter(isTopLevel);
  let excluded = 0;
  let monitorFallback = 0;
  let failed = 0;

  for (const hwnd of hwnds) {
    const excludedOk = setAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    const excludedAffinity = readAffinity(hwnd);
    if (excludedOk && (excludedAffinity === WDA_EXCLUDEFROMCAPTURE || excludedAffinity === null)) {
      excluded += 1;
      continue;
    }

    const monitorOk = setAffinity(hwnd, WDA_MONITOR);
    const monitorAffinity = readAffinity(hwnd);
    if (monitorOk && (monitorAffinity === WDA_MONITOR || monitorAffinity === null)) {
      monitorFallback += 1;
      continue;
    }

    failed += 1;
  }

  const protectedNow = excluded > 0 || monitorFallback > 0;
  return {
    protected: protectedNow,
    hwndCount: hwnds.length,
    excluded,
    monitorFallback,
    failed,
    affinity: excluded > 0 ? WDA_EXCLUDEFROMCAPTURE : monitorFallback > 0 ? WDA_MONITOR : WDA_NONE,
    method: 'native',
    error: failed && !protectedNow ? `SetWindowDisplayAffinity failed on ${failed} hwnd(s)` : null
  };
}

module.exports = {
  applyExcludeFromCapture,
  WDA_EXCLUDEFROMCAPTURE
};
