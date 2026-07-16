import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from "electron";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import net from "net";
import fs from "fs";
import {
  checkLicenseOnStartup,
  readStoredLicense,
  clearStoredLicense,
} from "./license";
import { showLicenseWindow } from "./license-window";
import { initAutoUpdater } from "./updater";

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverPort = 0;

// File-based debug log (Electron's stdout isn't always visible in terminals)
const logFile = path.join(__dirname, "..", "electron-debug.log");
function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
}

log("=== Inkframe starting ===");
log(`isDev: ${isDev}`);
log(`__dirname: ${__dirname}`);

// ── Paths ──────────────────────────────────────────────────────────────

function getAppRoot(): string {
  // In dev: __dirname = <project>/electron/dist/ → go up 2 levels
  return isDev ? path.join(__dirname, "..", "..") : app.getAppPath();
}

function getServerJs(): string {
  return path.join(getAppRoot(), ".next", "standalone", "server.js");
}

function getDataDir(): string {
  // Always use ~/.conveyer-isabell across both dev and desktop production modes
  // so that settings, API keys, channels, and saved data are unified and shared.
  const os = require("os");
  return process.env.ISABELL_DATA_DIR ?? path.join(os.homedir(), ".conveyer-isabell");
}

function getFFmpegPath(): string | null {
  // 1. Packaged app: look in resources/bin/
  if (!isDev) {
    const bundled = path.join(process.resourcesPath, "bin", "ffmpeg.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  // 2. Dev: try @ffmpeg-installer/ffmpeg
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("@ffmpeg-installer/ffmpeg");
    if (pkg?.path && fs.existsSync(pkg.path)) return pkg.path;
  } catch {}
  // 3. Let the app fall back to system PATH or FFMPEG_PATH setting
  return null;
}

// ── Free port ──────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr !== "string") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("Could not determine port"));
      }
    });
    srv.on("error", reject);
  });
}

// ── Wait for server ────────────────────────────────────────────────────

async function waitForServer(
  port: number,
  timeout = 60_000
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/stats`);
      if (r.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start within ${timeout / 1000}s`);
}

// ── Start Next.js server ──────────────────────────────────────────────

async function startServer(): Promise<number> {
  const port = await findFreePort();
  serverPort = port;

  const serverJs = getServerJs();
  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `Next.js server not found at:\n${serverJs}\n\nRun "npm run build" first.`
    );
  }

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    ISABELL_DATA_DIR: dataDir,
    NODE_ENV: "production",
  };

  // Bundled FFmpeg — set as env var so getSetting() picks it up as fallback
  const ffmpegPath = getFFmpegPath();
  if (ffmpegPath) {
    env.FFMPEG_PATH = ffmpegPath;
  }

  log(`[main] Data dir: ${dataDir}`);
  log(`[main] FFmpeg:   ${ffmpegPath ?? "(system PATH)"}`);
  log(`[main] Server:   ${serverJs}`);
  log(`[main] Port:     ${port}`);

  serverProcess = spawn(process.execPath, [serverJs], {
    cwd: path.dirname(serverJs),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  serverProcess.stdout?.on("data", (d: Buffer) => {
    log(`[next] ${d.toString().trim()}`);
  });
  serverProcess.stderr?.on("data", (d: Buffer) => {
    log(`[next:err] ${d.toString().trim()}`);
  });
  serverProcess.on("exit", (code) => {
    log(`[next] Server exited (code ${code})`);
    if (mainWindow) {
      dialog.showErrorBox(
        "Inkframe",
        "The server process has stopped unexpectedly. The app will close."
      );
      app.quit();
    }
  });

  await waitForServer(port);
  log(`[main] Server ready at http://127.0.0.1:${port}`);
  return port;
}

// ── Window ──────────────────────────────────────────────────────────────

function createWindow(port: number) {
  const iconPath = path.join(getAppRoot(), "build", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Inkframe",
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    backgroundColor: "#0a0a14",
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    // Start checking for updates after the window is visible
    if (mainWindow) initAutoUpdater(mainWindow);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Open external links in the default browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  // ── Right-click context menu (Cut / Copy / Paste / Select All) ───
  mainWindow.webContents.on("context-menu", (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
    menu.popup();
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────────

function killServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

app.whenReady().then(async () => {
  log("[main] app.whenReady resolved");
  try {
    // ── License check (kill switch) ────────────────────────────────
    log("[main] Checking license...");
    const { needsActivation } = await checkLicenseOnStartup();

    if (needsActivation) {
      log("[main] No valid license — showing activation window");
      const activated = await showLicenseWindow();
      if (!activated) {
        log("[main] User closed license window without activating");
        app.quit();
        return;
      }
      log("[main] License activated successfully");
    } else {
      log("[main] License valid");
    }

    // ── Start app ──────────────────────────────────────────────────
    const port = await startServer();
    log(`[main] Creating window for port ${port}`);
    createWindow(port);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[main] FATAL: ${msg}`);
    dialog.showErrorBox("Inkframe — Startup Error", msg);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  killServer();
  app.quit();
});

app.on("before-quit", killServer);

// ── IPC handlers ────────────────────────────────────────────────────────

ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("app:open-path", (_ev, folderPath: string) => {
  return shell.openPath(folderPath);
});
ipcMain.handle("app:get-port", () => serverPort);

// ── License IPC handlers ────────────────────────────────────────────────

ipcMain.handle("license:info", () => {
  const stored = readStoredLicense();
  if (!stored) return null;
  return { licensed: true, email: stored.email };
});

ipcMain.handle("license:deactivate", () => {
  clearStoredLicense();
  log("[main] License deactivated by user");
});
