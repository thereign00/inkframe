import { BrowserWindow, ipcMain } from "electron";
import path from "path";
import { verifyLicenseKey, writeStoredLicense } from "./license";

export function showLicenseWindow(): Promise<boolean> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 480,
      height: 420,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      title: "Inkframe — Activate License",
      backgroundColor: "#0a0a14",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
      show: false,
    });

    // Load inline HTML
    const html = getLicenseHTML();
    win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    );
    win.once("ready-to-show", () => win.show());

    // Handle activation request from renderer
    const handler = async (
      _event: Electron.IpcMainInvokeEvent,
      licenseKey: string
    ): Promise<{ success: boolean; error?: string }> => {
      const result = await verifyLicenseKey(licenseKey);
      if (result.valid) {
        writeStoredLicense({
          key: licenseKey.trim(),
          email: result.email || "",
          purchaseId: result.purchaseId || "",
          verifiedAt: new Date().toISOString(),
        });
        win.close();
        // resolve(true) is called by the "closed" handler below
        return { success: true };
      } else {
        return { success: false, error: result.error || "Invalid license key." };
      }
    };

    // Register the handler (will be removed when window closes)
    ipcMain.handle("license:activate", handler);

    let activated = false;
    win.on("closed", () => {
      ipcMain.removeHandler("license:activate");
      // If we wrote a license before closing, it was successful
      try {
        const fs = require("fs");
        const { app } = require("electron");
        const licensePath = path.join(
          app.getPath("userData"),
          "license.json"
        );
        if (fs.existsSync(licensePath)) {
          activated = true;
        }
      } catch {}
      resolve(activated);
    });
  });
}

function getLicenseHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activate Inkframe</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a14;
    color: #e8e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    -webkit-app-region: drag;
    user-select: none;
  }
  .container {
    -webkit-app-region: no-drag;
    width: 380px;
    padding: 36px;
    background: linear-gradient(135deg, #14142a 0%, #1a1a2e 100%);
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.06);
    box-shadow: 0 24px 48px rgba(0,0,0,0.4);
  }
  .logo {
    font-size: 24px;
    font-weight: 800;
    text-align: center;
    margin-bottom: 6px;
    background: linear-gradient(135deg, #a78bfa, #818cf8);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle {
    text-align: center;
    color: #8a8aa0;
    font-size: 13px;
    margin-bottom: 28px;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #8a8aa0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  input {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.05);
    color: #e8e8f0;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;
  }
  input:focus {
    border-color: #818cf8;
    box-shadow: 0 0 0 3px rgba(129,140,248,0.15);
  }
  button {
    width: 100%;
    padding: 12px;
    margin-top: 20px;
    border-radius: 10px;
    border: none;
    background: linear-gradient(135deg, #818cf8, #a78bfa);
    color: white;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
  }
  button:hover { opacity: 0.9; }
  button:active { transform: scale(0.98); }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
  }
  .error {
    margin-top: 14px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.2);
    color: #f87171;
    font-size: 13px;
    display: none;
  }
  .spinner {
    display: none;
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin: 0 auto;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="container">
  <div class="logo">Inkframe</div>
  <div class="subtitle">Enter your license key to activate</div>
  <label for="key">License Key</label>
  <input type="text" id="key" placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX" autocomplete="off" spellcheck="false">
  <button id="btn">
    <span id="btnText">Activate</span>
    <div class="spinner" id="spinner"></div>
  </button>
  <div class="error" id="error"></div>
</div>
<script>
  async function activate() {
    var key = document.getElementById('key').value.trim();
    if (!key) return;

    var btn = document.getElementById('btn');
    var btnText = document.getElementById('btnText');
    var spinner = document.getElementById('spinner');
    var error = document.getElementById('error');

    btn.disabled = true;
    btnText.style.display = 'none';
    spinner.style.display = 'inline-block';
    error.style.display = 'none';

    try {
      var result = await window.electronAPI.activateLicense(key);
      if (!result.success) {
        error.textContent = result.error;
        error.style.display = 'block';
      }
      // If success, the window will be closed by the main process
    } catch (e) {
      error.textContent = 'An unexpected error occurred.';
      error.style.display = 'block';
    } finally {
      btn.disabled = false;
      btnText.style.display = 'inline';
      spinner.style.display = 'none';
    }
  }

  document.getElementById('btn').addEventListener('click', activate);
  document.getElementById('key').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') activate();
  });
</script>
</body>
</html>`;
}
