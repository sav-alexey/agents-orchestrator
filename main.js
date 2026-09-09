// This process is only a window onto the backend — the backend itself, the
// `claude` CLI it drives and Qdrant all live in `docker compose`. Nothing is
// spawned here: two backends on one SQLite file is the failure this avoids.
// Same UI is reachable in a browser at http://localhost:8080.
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');

const BACKEND_PORT = 8756;
const BACKEND_URL = process.env.ORCHESTRATOR_BACKEND || `http://127.0.0.1:${BACKEND_PORT}`;

let mainWindow = null;

function waitForBackend(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`${BACKEND_URL}/health`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`No backend at ${BACKEND_URL}`));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#1e1f22',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // A turn streams its reply while the user is often looking at something
      // else; a throttled (unfocused/occluded) window stops compositing and the
      // accumulating text only repaints when focus returns — "switch the window
      // there and back to see it". Keep painting regardless of focus.
      backgroundThrottling: false,
    },
  });
  // The page has no way to read this process's env, so the backend it should
  // talk to is handed over in the URL.
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { api: BACKEND_URL },
  });

  // Links inside messages open in the real browser — never replace the app UI.
  const openExternally = (url) => {
    if (/^https?:\/\//i.test(url) || url.startsWith('mailto:')) shell.openExternal(url);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      openExternally(url);
    }
  });
}

// The page asks for a folder; only this process can show a native picker.
ipcMain.handle('pick-directory', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Add a project',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

app.whenReady().then(async () => {
  try {
    await waitForBackend();
  } catch (err) {
    // The window would only render a wall of fetch errors, so say what is
    // actually wrong and how to fix it.
    dialog.showErrorBox(
      'Backend is not running',
      `${err.message}\n\nStart the stack first:\n\n    docker compose up -d\n\n` +
        'Or point this window elsewhere with ORCHESTRATOR_BACKEND=http://host:port.'
    );
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
