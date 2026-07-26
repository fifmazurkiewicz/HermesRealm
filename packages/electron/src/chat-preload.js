/**
 * Preload script for the Chat BrowserWindow.
 * Plain JS — loaded directly by Electron; no build step needed.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hermesRealmChat', {
  sendInput: (text) => ipcRenderer.send('hermes:input', text),
  onOutput: (callback) => {
    ipcRenderer.on('hermes:output', (_event, text) => callback(text));
  },
  getStatus: () => ipcRenderer.invoke('hermes:status'),
  removeOutputListener: () => {
    ipcRenderer.removeAllListeners('hermes:output');
  },
});