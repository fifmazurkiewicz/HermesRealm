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

// Paths
const __dirname = path.resolve(__dirname);
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
let hermesProcess = null;

const SERVER_PORT = 8123;
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
    console.log(`[server] ${data.toString().trim()}`);
  });
  serverProcess.stderr?.on('data', (data) => {
    console.error(`[server:err] ${data.toString().trim()}`);
  });
  serverProcess.on('error', (err) => {
    console.error('Failed to start server:', err);
  });
  serverProcess.on('exit', (code) => {
    console.log(`Server exited with code ${code}`);
    serverProcess = null;
  });

  console.log(`[electron] Server starting on port ${SERVER_PORT}...`);
}

function killServer() {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
  }
}

// Hermes CLI chat lifecycle
function startHermesCli() {
  if (hermesProcess) return;
  if (!HERMES_CLI) {
    console.error('Hermes CLI not found. Expected at D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes');
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
    console.error('Hermes CLI error:', err);
  });
  hermesProcess.on('exit', (code) => {
    console.log(`Hermes CLI exited with code ${code}`);
    hermesProcess = null;
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('hermes:output', `\n[Hermes CLI exited with code ${code}]\n`);
    }
  });

  console.log('[electron] Hermes CLI started');
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