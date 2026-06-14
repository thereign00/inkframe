import { app } from "electron";
import path from "path";
import fs from "fs";

// ── Configuration ──────────────────────────────────────────────────────
// Set GUMROAD_PRODUCT_ID env var or replace this placeholder after
// creating your Gumroad product.
const GUMROAD_PRODUCT_ID =
  process.env.GUMROAD_PRODUCT_ID || "vPv7JAdZ2PVJFCkp_RO2xA==";
const LICENSE_FILE = "license.json";

export interface StoredLicense {
  key: string;
  email: string;
  purchaseId: string;
  verifiedAt: string; // ISO date
}

export interface VerifyResult {
  valid: boolean;
  email?: string;
  purchaseId?: string;
  error?: string;
}

// ── File paths ─────────────────────────────────────────────────────────

function getLicenseFilePath(): string {
  return path.join(app.getPath("userData"), LICENSE_FILE);
}

// ── Read / Write stored license ────────────────────────────────────────

export function readStoredLicense(): StoredLicense | null {
  try {
    const raw = fs.readFileSync(getLicenseFilePath(), "utf-8");
    return JSON.parse(raw) as StoredLicense;
  } catch {
    return null;
  }
}

export function writeStoredLicense(license: StoredLicense): void {
  const dir = path.dirname(getLicenseFilePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getLicenseFilePath(), JSON.stringify(license, null, 2));
}

export function clearStoredLicense(): void {
  try {
    fs.unlinkSync(getLicenseFilePath());
  } catch {}
}

// ── Verify with Gumroad API ────────────────────────────────────────────

export async function verifyLicenseKey(
  licenseKey: string
): Promise<VerifyResult> {
  try {
    const response = await fetch(
      "https://api.gumroad.com/v2/licenses/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: GUMROAD_PRODUCT_ID,
          license_key: licenseKey.trim(),
          increment_uses_count: false,
        }),
      }
    );

    const data = (await response.json()) as Record<string, unknown>;

    if (data.success) {
      const purchase = data.purchase as Record<string, unknown> | undefined;
      // Check if purchase has been refunded / chargebacked / disputed
      if (
        purchase?.refunded ||
        purchase?.chargebacked ||
        purchase?.disputed
      ) {
        return {
          valid: false,
          error: "This license has been refunded or disputed.",
        };
      }
      // Check if subscription cancelled
      if (purchase?.subscription_cancelled_at) {
        return {
          valid: false,
          error: "This license subscription has been cancelled.",
        };
      }

      return {
        valid: true,
        email: (purchase?.email as string) || "",
        purchaseId:
          (purchase?.id as string) ||
          (purchase?.sale_id as string) ||
          "",
      };
    } else {
      return {
        valid: false,
        error: (data.message as string) || "Invalid license key.",
      };
    }
  } catch {
    // Network error — allow offline usage if we already have a stored license
    const stored = readStoredLicense();
    if (stored && stored.key === licenseKey.trim()) {
      return {
        valid: true,
        email: stored.email,
        purchaseId: stored.purchaseId,
      };
    }
    return {
      valid: false,
      error:
        "Could not reach the license server. Please check your internet connection.",
    };
  }
}

// ── High-level: check license on startup ───────────────────────────────

export async function checkLicenseOnStartup(): Promise<{
  licensed: boolean;
  needsActivation: boolean;
}> {
  const stored = readStoredLicense();
  if (!stored) {
    return { licensed: false, needsActivation: true };
  }

  // Re-verify with Gumroad (kill switch)
  const result = await verifyLicenseKey(stored.key);
  if (result.valid) {
    // Update verification timestamp
    writeStoredLicense({
      ...stored,
      verifiedAt: new Date().toISOString(),
    });
    return { licensed: true, needsActivation: false };
  } else {
    // License is no longer valid — clear it
    clearStoredLicense();
    return { licensed: false, needsActivation: true };
  }
}
