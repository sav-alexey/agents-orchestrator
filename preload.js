// The window runs with contextIsolation on and no Node access — the page is
// plain web code talking to the backend over HTTP. The one thing it cannot do
// for itself is browse the real filesystem, so that single capability is bridged
// here, and nothing else is.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orchestrator', {
  pickDirectory: () => ipcRenderer.invoke('pick-directory'),
});
