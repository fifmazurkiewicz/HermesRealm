/**
 * HermesRealm Electron main process.
 *
 * - Wraps the Age of Agents server + client in a BrowserWindow.
 * - Provides a "Visualization" / "Chat" toggle via the app menu.
 * - Chat mode spawns the Hermes CLI as a child process and pipes
 *   user input -> stdin, stdout -> output area.
 */

const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Paths — __dirname is already available in CommonJS
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Hermes CLI executable under D:\Hermes. */
function findHermesCli() {
  const candidates = [
    'D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes.exe',
    'D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes',
    'D:\\Hermes\\hermes.exe',
    'D:\\Hermes\\target\\release\\hermes.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const HERMES_CLI = findHermesCli();

// State
let mainWindow = null;
let chatWindow = null;
let serverProcess = null;
let clientProcess = null;
let hermesProcess = null;

const SERVER_PORT = 8123;
const CLIENT_PORT = 5173;
const CLIENT_DEV_URL = 'http://localhost:5173';
let activeMode = 'visualization';

// Server lifecycle
function startServer() {
  const serverDir = path.join(PROJECT_ROOT, 'packages', 'server');
  serverProcess = spawn('npm', ['run', 'dev', '-w', '@agent-citadel/server'], {
    cwd: PROJECT_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  serverProcess.stdout?.on('data', (data) => {
    safeLog('log', `[server] ${data.toString().trim()}`);
  });
  serverProcess.stderr?.on('data', (data) => {
    safeLog('error', `[server:err] ${data.toString().trim()}`);
  });
  serverProcess.on('error', (err) => {
    safeLog('error', 'Failed to start server:', err);
  });
  serverProcess.on('exit', (code) => {
    safeLog('log', `Server exited with code ${code}`);
    serverProcess = null;
  });

  safeLog('log', `[electron] Server starting on port ${SERVER_PORT}...`);
}

function killServer() {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
  }
  if (clientProcess && clientProcess.exitCode === null) {
    clientProcess.kill('SIGTERM');
  }
}

// Vite client dev server
function startClient() {
  clientProcess = spawn('npm', ['run', 'dev', '-w', '@agent-citadel/client'], {
    cwd: PROJECT_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  clientProcess.stdout?.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes('Local') || msg.includes('localhost') || msg.includes('ready')) {
      safeLog('log', `[client] ${msg}`);
    }
  });
  clientProcess.stderr?.on('data', (data) => {
    safeLog('error', `[client:err] ${data.toString().trim()}`);
  });
  clientProcess.on('exit', (code) => {
    safeLog('log', `Client exited with code ${code}`);
    clientProcess = null;
  });

  safeLog('log', `[electron] Client starting on port ${CLIENT_PORT}...`);
}

// Safe logger — prevents EPIPE crashes when child process pipes close
function safeLog(level, ...args) {
  try {
    const fn = level === 'error' ? console.error : console.log;
    fn(...args);
  } catch (e) {
    // EPIPE or similar — stdout/stderr pipe closed, ignore silently
  }
}

// Prevent EPIPE from crashing the app
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') { /* swallowed */ }
  else console.error('stdout error:', err);
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE') { /* swallowed */ }
  else console.error('stderr error:', err);
});
function startHermesCli() {
  if (hermesProcess) return;
  if (!HERMES_CLI) {
    safeLog('error', 'Hermes CLI not found. Expected at D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes');
    return;
  }

  hermesProcess = spawn(HERMES_CLI, ['chat'], {
    cwd: 'D:\\Hermes',
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  hermesProcess.stdout?.on('data', (data) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('hermes:output', data.toString());
    }
  });
  hermesProcess.stderr?.on('data', (data) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('hermes:output', `[stderr] ${data.toString()}`);
    }
  });
  hermesProcess.on('error', (err) => {
    safeLog('error', 'Hermes CLI error:', err);
  });
  hermesProcess.on('exit', (code) => {
    safeLog('log', `Hermes CLI exited with code ${code}`);
    hermesProcess = null;
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('hermes:output', `\n[Hermes CLI exited with code ${code}]\n`);
    }
  });

  safeLog('log', '[electron] Hermes CLI started');
}

function sendToHermes(text) {
  if (hermesProcess && hermesProcess.stdin && hermesProcess.exitCode === null) {
    hermesProcess.stdin.write(text + '\n');
  }
}

function killHermes() {
  if (hermesProcess && hermesProcess.exitCode === null) {
    hermesProcess.kill('SIGTERM');
    hermesProcess = null;
  }
}

// Window management
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'HermesRealm',
    backgroundColor: '#1a1a17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL(CLIENT_DEV_URL);
  } else {
    const clientDist = path.join(PROJECT_ROOT, 'dist', 'web', 'index.html');
    mainWindow.loadFile(clientDist);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });
  mainWindow.setTitle('HermesRealm');
}

function createChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.focus();
    return;
  }

  chatWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 500,
    minHeight: 400,
    title: 'HermesRealm — Chat',
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chatWindow.loadFile(path.join(__dirname, 'chat.html'));

  chatWindow.on('closed', () => {
    chatWindow = null;
    killHermes();
  });

  startHermesCli();
}

// Menu
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit', label: 'Exit HermesRealm' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Visualization',
          type: 'radio',
          checked: activeMode === 'visualization',
          click: () => {
            activeMode = 'visualization';
            if (mainWindow) mainWindow.focus();
          },
        },
        {
          label: 'Chat',
          type: 'radio',
          checked: activeMode === 'chat',
          click: () => {
            activeMode = 'chat';
            createChatWindow();
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About HermesRealm',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: 'About HermesRealm',
              message: 'HermesRealm — Age of Agents in an Electron shell.',
              detail: `Hermes CLI: ${HERMES_CLI ?? 'not found'}\nServer port: ${SERVER_PORT}`,
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// IPC handlers
function registerIpc() {
  ipcMain.on('hermes:input', (_event, text) => {
    if (hermesProcess) {
      sendToHermes(text);
    } else if (HERMES_CLI) {
      hermesProcess = spawn(HERMES_CLI, ['chat', '-q', text], {
        cwd: 'D:\\Hermes',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const chunks = [];
      hermesProcess.stdout?.on('data', (d) => chunks.push(d.toString()));
      hermesProcess.stderr?.on('data', (d) => chunks.push(`[stderr] ${d.toString()}`));
      hermesProcess.on('close', () => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('hermes:output', chunks.join(''));
        }
        hermesProcess = null;
      });
    }
  });

  ipcMain.handle('hermes:status', () => {
    return {
      found: HERMES_CLI !== null,
      path: HERMES_CLI,
      running: hermesProcess !== null && hermesProcess.exitCode === null,
    };
  });
}

// App lifecycle
app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  startServer();
  startClient();
  createMainWindow();
});

app.on('window-all-closed', () => {
  killServer();
  killHermes();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killServer();
  killHermes();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});