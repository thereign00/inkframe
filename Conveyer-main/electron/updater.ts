import { autoUpdater } from "electron-updater";
import { BrowserWindow, dialog } from "electron";
import { app } from "electron";
import fs from "fs";
import path from "path";

// ── Debug log (same file as main.ts) ────────────────────────────────────
const logFile = path.join(__dirname, "..", "electron-debug.log");
function log(msg: string) {
  const line = `[${new Date().toISOString()}] [updater] ${msg}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
}

// ── Configuration ───────────────────────────────────────────────────────
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Initialize the auto-updater. Call this once after the main window is ready.
 *
 * Behavior:
 *  - Checks for updates on startup, then every 4 hours.
 *  - Downloads updates silently in the background.
 *  - When ready, shows a dialog asking the user to restart.
 *  - Errors are logged but never crash the app.
 *  - Disabled in dev mode (app.isPackaged === false).
 */
export function initAutoUpdater(mainWindow: BrowserWindow): void {
  if (!app.isPackaged) {
    log("Skipping auto-updater in dev mode");
    return;
  }

  // ── Settings ────────────────────────────────────────────────────────
  autoUpdater.autoDownload = true;       // download in background
  autoUpdater.autoInstallOnAppQuit = true; // install when user quits
  autoUpdater.autoRunAppAfterInstall = true;

  // ── Events ──────────────────────────────────────────────────────────

  autoUpdater.on("checking-for-update", () => {
    log("Checking for update…");
  });

  autoUpdater.on("update-available", (info) => {
    log(`Update available: v${info.version}`);
  });

  autoUpdater.on("update-not-available", (info) => {
    log(`Already on latest: v${info.version}`);
  });

  autoUpdater.on("download-progress", (progress) => {
    log(
      `Downloading: ${progress.percent.toFixed(1)}% ` +
      `(${(progress.transferred / 1e6).toFixed(1)}/${(progress.total / 1e6).toFixed(1)} MB)`
    );
  });

  autoUpdater.on("update-downloaded", (info) => {
    log(`Update downloaded: v${info.version}`);

    // Ask the user if they want to restart now
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: `Inkframe v${info.version} has been downloaded.`,
        detail: "Restart now to apply the update?",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          log("User chose to restart — installing update");
          autoUpdater.quitAndInstall(false, true);
        } else {
          log("User deferred update — will install on next quit");
        }
      });
  });

  autoUpdater.on("error", (err) => {
    log(`Update error: ${err.message}`);
    // Never crash or show an error dialog for update failures.
    // The app continues working normally on the current version.
  });

  // ── Initial check ──────────────────────────────────────────────────
  log("Auto-updater initialized — checking for updates");
  autoUpdater.checkForUpdates().catch((err) => {
    log(`Initial update check failed: ${err.message}`);
  });

  // ── Periodic checks ────────────────────────────────────────────────
  setInterval(() => {
    log("Periodic update check");
    autoUpdater.checkForUpdates().catch((err) => {
      log(`Periodic update check failed: ${err.message}`);
    });
  }, CHECK_INTERVAL_MS);
}
