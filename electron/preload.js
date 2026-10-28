const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('assistant', {
  onKey: (callback) => subscribe('overlay:key', callback),
  onStatus: (callback) => subscribe('overlay:status', callback),
  onForeground: (callback) => subscribe('overlay:foreground', callback),
  getStatus: () => ipcRenderer.invoke('overlay:status'),
  chat: (prompt) => ipcRenderer.invoke('ai:chat', prompt),
  getClipboard: () => ipcRenderer.invoke('clipboard:getText'),
  setClipboard: (text) => ipcRenderer.invoke('clipboard:setText', text),
  hide: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  logFocus: (note) => ipcRenderer.send('focus:log', note)
});
