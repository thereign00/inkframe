/**
 * Cross-platform dialog helpers.
 * In Electron: uses native IPC dialogs (since window.prompt/alert don't work).
 * In browser (dev): falls back to standard window.prompt/alert/confirm.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;

/** Show a prompt dialog. Returns user input or null if cancelled. */
export async function appPrompt(message: string, defaultValue?: string): Promise<string | null> {
  if (electronAPI?.prompt) {
    return electronAPI.prompt(message, defaultValue);
  }
  // Fallback for browser dev mode
  return window.prompt(message, defaultValue);
}

/** Show an alert dialog. */
export async function appAlert(message: string): Promise<void> {
  if (electronAPI?.alert) {
    return electronAPI.alert(message);
  }
  window.alert(message);
}

/** Show a confirm dialog. Returns true if OK, false if cancelled. */
export async function appConfirm(message: string): Promise<boolean> {
  if (electronAPI?.confirm) {
    return electronAPI.confirm(message);
  }
  return window.confirm(message);
}
