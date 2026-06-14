import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  /** App version from package.json */
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),

  /** Open a folder/file in the system file browser */
  openPath: (p: string): Promise<string> => ipcRenderer.invoke("app:open-path", p),

  /** Get the port the Next.js server is running on */
  getPort: (): Promise<number> => ipcRenderer.invoke("app:get-port"),

  /** Current platform */
  platform: process.platform,

  // ── License ────────────────────────────────────────────────────────

  /** Activate a license key (used by the activation window) */
  activateLicense: (key: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("license:activate", key),

  /** Deactivate / remove current license */
  deactivateLicense: (): Promise<void> =>
    ipcRenderer.invoke("license:deactivate"),

  /** Get current license info */
  getLicenseInfo: (): Promise<{ licensed: boolean; email?: string } | null> =>
    ipcRenderer.invoke("license:info"),
});
