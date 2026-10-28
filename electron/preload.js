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
  chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  getClipboard: () => ipcRenderer.invoke('clipboard:getText'),
  setClipboard: (text) => ipcRenderer.invoke('clipboard:setText', text),
  onClipboardChanged: (callback) => subscribe('clipboard:changed', callback),
  hide: () => ipcRenderer.send('overlay:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  logFocus: (note) => ipcRenderer.send('focus:log', note),
  newSession: () => ipcRenderer.invoke('session:new'),
  sessionState: () => ipcRenderer.invoke('session:state'),
  switchSession: (id) => ipcRenderer.invoke('session:switch', id),
  addKey: (payload) => ipcRenderer.invoke('keys:add', payload),
  removeKey: (payload) => ipcRenderer.invoke('keys:remove', payload),
  keysStatus: () => ipcRenderer.invoke('keys:status'),
  testKey: (payload) => ipcRenderer.invoke('keys:test', payload),
  resizeWindow: (size) => ipcRenderer.invoke('window:resize', size),
  getBounds: () => ipcRenderer.invoke('window:getBounds'),
  focusWindow: () => ipcRenderer.invoke('window:focus')
});
