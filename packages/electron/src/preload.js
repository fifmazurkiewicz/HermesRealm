/**
 * Preload script for the main (Visualization) BrowserWindow.
 * Plain JS — loaded directly by Electron; no build step needed.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hermesRealm', {
  getMode: () => ipcRenderer.invoke('hermes:mode'),
  onModeChange: (callback) => {
    ipcRenderer.on('mode:changed', (_event, mode) => callback(mode));
  },
});