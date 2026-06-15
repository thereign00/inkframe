/**
 * Cross-platform dialog helpers.
 * Uses in-page modals that work in both Electron and browser.
 * (window.prompt/alert/confirm don't work in Electron.)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;
const isElectron = !!electronAPI;

// ── Shared modal styles ────────────────────────────────────────────

const OVERLAY_STYLE = `
  position:fixed;inset:0;z-index:99999;
  display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);
  font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
`;

const BOX_STYLE = `
  background:#1a1a2e;color:#e0e0e0;border:1px solid #333;
  border-radius:12px;padding:24px;min-width:380px;max-width:480px;
  box-shadow:0 20px 60px rgba(0,0,0,0.5);
`;

const BTN_BASE = `
  padding:8px 22px;border:none;border-radius:6px;
  font-size:13px;font-weight:500;cursor:pointer;
  transition:background 0.15s;
`;

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.style.cssText = OVERLAY_STYLE;
  return overlay;
}

function createBox(): HTMLDivElement {
  const box = document.createElement("div");
  box.style.cssText = BOX_STYLE;
  return box;
}

// ── appPrompt ──────────────────────────────────────────────────────

/** Show a prompt dialog. Returns user input string or null if cancelled. */
export function appPrompt(message: string, defaultValue?: string): Promise<string | null> {
  if (!isElectron) {
    return Promise.resolve(window.prompt(message, defaultValue));
  }

  return new Promise((resolve) => {
    const overlay = createOverlay();
    const box = createBox();

    const label = document.createElement("div");
    label.textContent = message;
    label.style.cssText = "font-size:14px;margin-bottom:12px;color:#ccc;";

    const input = document.createElement("input");
    input.type = "text";
    input.value = defaultValue || "";
    input.style.cssText = `
      width:100%;padding:10px 12px;border:1px solid #444;border-radius:6px;
      background:#0d0d1a;color:#fff;font-size:14px;outline:none;
      box-sizing:border-box;
    `;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:16px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = BTN_BASE + "background:#2a2a3e;color:#aaa;";
    cancelBtn.onmouseover = () => (cancelBtn.style.background = "#333");
    cancelBtn.onmouseout = () => (cancelBtn.style.background = "#2a2a3e");

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = BTN_BASE + "background:#6c63ff;color:#fff;";
    okBtn.onmouseover = () => (okBtn.style.background = "#5a52d5");
    okBtn.onmouseout = () => (okBtn.style.background = "#6c63ff");

    function close(value: string | null) {
      overlay.remove();
      resolve(value);
    }

    cancelBtn.onclick = () => close(null);
    okBtn.onclick = () => close(input.value);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") close(input.value);
      if (e.key === "Escape") close(null);
    });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(null);
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Auto-focus and select text
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}

// ── appAlert ───────────────────────────────────────────────────────

/** Show an alert dialog. */
export function appAlert(message: string): Promise<void> {
  if (!isElectron) {
    window.alert(message);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const overlay = createOverlay();
    const box = createBox();

    const msg = document.createElement("div");
    msg.textContent = message;
    msg.style.cssText = "font-size:14px;line-height:1.5;color:#ccc;white-space:pre-wrap;";

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:16px;";

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = BTN_BASE + "background:#6c63ff;color:#fff;";
    okBtn.onmouseover = () => (okBtn.style.background = "#5a52d5");
    okBtn.onmouseout = () => (okBtn.style.background = "#6c63ff");

    function close() {
      overlay.remove();
      resolve();
    }

    okBtn.onclick = close;
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    // Allow Enter/Escape to dismiss
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        document.removeEventListener("keydown", onKey);
        close();
      }
    };
    document.addEventListener("keydown", onKey);

    btnRow.appendChild(okBtn);
    box.appendChild(msg);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => okBtn.focus());
  });
}

// ── appConfirm ─────────────────────────────────────────────────────

/** Show a confirm dialog. Returns true if OK, false if cancelled. */
export function appConfirm(message: string): Promise<boolean> {
  if (!isElectron) {
    return Promise.resolve(window.confirm(message));
  }

  return new Promise((resolve) => {
    const overlay = createOverlay();
    const box = createBox();

    const msg = document.createElement("div");
    msg.textContent = message;
    msg.style.cssText = "font-size:14px;line-height:1.5;color:#ccc;white-space:pre-wrap;";

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:16px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = BTN_BASE + "background:#2a2a3e;color:#aaa;";
    cancelBtn.onmouseover = () => (cancelBtn.style.background = "#333");
    cancelBtn.onmouseout = () => (cancelBtn.style.background = "#2a2a3e");

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = BTN_BASE + "background:#6c63ff;color:#fff;";
    okBtn.onmouseover = () => (okBtn.style.background = "#5a52d5");
    okBtn.onmouseout = () => (okBtn.style.background = "#6c63ff");

    function close(result: boolean) {
      overlay.remove();
      resolve(result);
    }

    cancelBtn.onclick = () => close(false);
    okBtn.onclick = () => close(true);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close(false);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") { document.removeEventListener("keydown", onKey); close(true); }
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(false); }
    };
    document.addEventListener("keydown", onKey);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(msg);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => okBtn.focus());
  });
}
