/**
 * HermesRealm Electron main process.
 *
 * - Wraps the Age of Agents server + client in a BrowserWindow.
 * - Provides a "Visualization" ↔ "Chat" toggle via the app menu.
 * - Chat mode spawns the Hermes CLI as a child process and pipes
 *   user input → stdin, stdout → output area.
 */

import { app, BrowserWindow, Menu, ipcMain, dialog } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// ── Paths ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Hermes CLI executable under D:\Hermes. */
function findHermesCli(): string | null {
  // Check common locations inside D:\Hermes.
  const candidates = [
    'D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes.exe',
    'D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes',
    'D:\\Hermes\\hermes.exe',
    'D:\\Hermes\\target\\release\\hermes.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Try PATH-resolved names on Windows via where.
  try {
    const result = spawn('where', ['hermes'], {
      shell: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Synchronous check: `where` may be async; prefer the known path.
  } catch {
    /* not found */
  }
  return null;
}

const HERMES_CLI = findHermesCli();

// ── State ────────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let chatWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let hermesProcess: ChildProcess | null = null;

const SERVER_PORT = 8123;
const CLIENT_DEV_URL = `http://localhost:5173`;
const MODES = ['visualization', 'chat'] as const;
type AppMode = (typeof MODES)[number];
let activeMode: AppMode = 'visualization';

// ── Server lifecycle ─────────────────────────────────────────────────────────
function startServer(): void {
  // In dev, use tsx to run the server; in production, use node on built output.
  const serverDir = path.join(PROJECT_ROOT, 'packages', 'server');
  // Prefer `npm run dev` via the root workspace so we don't reinvent the dev pipeline.
  serverProcess = spawn('npm', ['run', 'dev', '-w', '@agent-citadel/server'], {
    cwd: PROJECT_ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  serverProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[server] ${data.toString().trim()}`);
  });
  serverProcess.stderr?.on('data', (data: Buffer) => {
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

function killServer(): void {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    // On Windows, tree-kill is ideal but SIGTERM works in many cases.
  }
}

// ── Hermes CLI chat lifecycle ────────────────────────────────────────────────
function startHermesCli(): void {
  if (hermesProcess) return; // already running
  if (!HERMES_CLI) {
    console.error('Hermes CLI not found. Expected at D:\\Hermes\\hermes-agent\\venv\\Scripts\\hermes');
    return;
  }

  // Launch hermes in interactive mode via PTY-like approach.
  // Note: `hermes chat` is the single-query mode; for interactive chat we use `hermes`.
  hermesProcess = spawn(HERMES_CLI, ['chat'], {
    cwd: 'D:\\Hermes',
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  hermesProcess.stdout?.on('data', (data: Buffer) => {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send('hermes:output', data.toString());
    }
  });
  hermesProcess.stderr?.on('data', (data: Buffer) => {
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

function sendToHermes(text: string): void {
  if (hermesProcess && hermesProcess.stdin && hermesProcess.exitCode === null) {
    hermesProcess.stdin.write(text + '\n');
  }
}

function killHermes(): void {
  if (hermesProcess && hermesProcess.exitCode === null) {
    hermesProcess.kill('SIGTERM');
    hermesProcess = null;
  }
}

// ── Window management ────────────────────────────────────────────────────────
function createMainWindow(): void {
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

  // In dev, load from Vite dev server; in production, load built HTML.
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

  // Remove default title suffix.
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });
  mainWindow.setTitle('HermesRealm');
}

function createChatWindow(): void {
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

  // Only start Hermes CLI when chat window opens.
  startHermesCli();
}

// ── Menu ─────────────────────────────────────────────────────────────────────
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
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
          id: 'mode-visualization',
          label: 'Visualization',
          type: 'radio',
          checked: activeMode === 'visualization',
          click: () => {
            activeMode = 'visualization';
            if (mainWindow) mainWindow.focus();
          },
        },
        {
          id: 'mode-chat',
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

// ── IPC handlers ─────────────────────────────────────────────────────────────
function registerIpc(): void {
  // Chat window sends user input to Hermes CLI.
  ipcMain.on('hermes:input', (_event, text: string) => {
    if (hermesProcess) {
      sendToHermes(text);
    } else if (HERMES_CLI) {
      // Hermes CLI not started yet (e.g., one-shot mode: spawn with -q).
      hermesProcess = spawn(HERMES_CLI, ['chat', '-q', text], {
        cwd: 'D:\\Hermes',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const chunks: string[] = [];
      hermesProcess.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
      hermesProcess.stderr?.on('data', (d: Buffer) => chunks.push(`[stderr] ${d.toString()}`));
      hermesProcess.on('close', () => {
        if (chatWindow && !chatWindow.isDestroyed()) {
          chatWindow.webContents.send('hermes:output', chunks.join(''));
        }
        hermesProcess = null;
      });
    }
  });

  // Get Hermes CLI status.
  ipcMain.handle('hermes:status', () => {
    return {
      found: HERMES_CLI !== null,
      path: HERMES_CLI,
      running: hermesProcess !== null && hermesProcess.exitCode === null,
    };
  });
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerIpc();
  buildMenu();

  // Start the AoA server backend.
  startServer();

  // Give server a head start, then create main window.
  createMainWindow();
});

app.on('window-all-closed', () => {
  killServer();
  killHermes();
  // On macOS, apps typically stay active until Cmd+Q.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  killServer();
  killHermes();
});

app.on('activate', () => {
  // macOS: re-create window when dock icon clicked.
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});