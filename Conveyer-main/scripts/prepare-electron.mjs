/**
 * prepare-electron.mjs
 *
 * Run after `next build` and before `electron-builder`.
 * 1. Copies .next/static → .next/standalone/.next/static (Next.js requires this)
 * 2. Copies ffmpeg + ffprobe binaries → build/bin/
 * 3. Rebuilds better-sqlite3 native addon for Electron's Node ABI
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

// ── 1. Copy .next/static ────────────────────────────────────────────────
const staticSrc = path.join(root, ".next", "static");
const staticDest = path.join(root, ".next", "standalone", ".next", "static");

if (fs.existsSync(staticSrc)) {
  fs.cpSync(staticSrc, staticDest, { recursive: true });
  console.log("✓ Copied .next/static → standalone");
} else {
  console.error("✗ .next/static not found — did `next build` run?");
  process.exit(1);
}

// ── 2. Copy FFmpeg + FFprobe binaries ───────────────────────────────────
const binDir = path.join(root, "build", "bin");
fs.mkdirSync(binDir, { recursive: true });

function copyBinary(label, resolverFn) {
  try {
    const srcPath = resolverFn();
    if (!srcPath || !fs.existsSync(srcPath)) {
      console.warn(`⚠ ${label}: binary not found`);
      return;
    }
    const destPath = path.join(binDir, path.basename(srcPath));
    fs.copyFileSync(srcPath, destPath);
    console.log(`✓ ${label} → build/bin/${path.basename(srcPath)}`);
  } catch (e) {
    console.warn(`⚠ ${label}: ${e.message}`);
  }
}

copyBinary("ffmpeg", () => require("@ffmpeg-installer/ffmpeg").path);
copyBinary("ffprobe", () => require("@ffprobe-installer/ffprobe").path);

// ── 3. Rebuild better-sqlite3 for Electron ──────────────────────────────
// @electron/rebuild was unreliable — it downloads prebuilt binaries that
// match the system Node ABI instead of Electron's. Using prebuild-install
// directly with --runtime electron ensures the correct ABI 133 binary.
const electronPkgPath = path.join(root, "node_modules", "electron", "package.json");
const electronVersion = JSON.parse(fs.readFileSync(electronPkgPath, "utf-8")).version;
console.log(`ℹ Electron version: ${electronVersion}`);

const prebuildCmd = `npx prebuild-install --runtime electron --target ${electronVersion} --arch x64 --force`;

// Helper: run prebuild-install in a better-sqlite3 directory
function rebuildSqlite(label, sqliteDir) {
  if (!fs.existsSync(sqliteDir)) {
    console.log(`ℹ ${label}: not found (skipped)`);
    return false;
  }
  console.log(`⏳ ${label}…`);
  try {
    execSync(prebuildCmd, { cwd: sqliteDir, stdio: "inherit" });
    console.log(`✓ ${label}`);
    return true;
  } catch (e) {
    console.warn(`⚠ ${label} failed:`, e.message);
    return false;
  }
}

// 3a. Project root (for electron:dev)
rebuildSqlite(
  "Prebuild better-sqlite3 (project root)",
  path.join(root, "node_modules", "better-sqlite3")
);

// 3b. Standalone node_modules (for packaged app)
const standaloneRoot = path.join(root, ".next", "standalone");
const sqlitePath = path.join(standaloneRoot, "node_modules", "better-sqlite3");
rebuildSqlite("Prebuild better-sqlite3 (standalone)", sqlitePath);

// 3c. Turbopack hashed copies under .next/standalone/.next/node_modules/
// e.g. better-sqlite3-90e2652d1716b047/ — each needs its own prebuild
const turboModules = path.join(standaloneRoot, ".next", "node_modules");
if (fs.existsSync(turboModules)) {
  const entries = fs.readdirSync(turboModules);
  for (const entry of entries) {
    if (!entry.startsWith("better-sqlite3")) continue;
    const turboDir = path.join(turboModules, entry);
    rebuildSqlite(`Prebuild Turbopack copy: ${entry}`, turboDir);
  }
}

console.log("\n✓ Electron build preparation complete\n");

// ── 4. Resolve symlinks in standalone directory ─────────────────────────
// Windows requires admin for symlinks; electron-builder will fail trying to
// copy them. Replace all symlinks with actual copies of the target.
console.log("⏳ Resolving symlinks in standalone directory…");
let symlinkCount = 0;

function resolveSymlinks(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      const lstats = fs.lstatSync(fullPath);
      if (lstats.isSymbolicLink()) {
        const realPath = fs.realpathSync(fullPath);
        fs.rmSync(fullPath, { recursive: true, force: true });
        if (fs.statSync(realPath).isDirectory()) {
          fs.cpSync(realPath, fullPath, { recursive: true });
        } else {
          fs.copyFileSync(realPath, fullPath);
        }
        symlinkCount++;
      } else if (lstats.isDirectory()) {
        resolveSymlinks(fullPath);
      }
    } catch (e) {
      console.warn(`  ⚠ Could not resolve ${fullPath}: ${e.message}`);
    }
  }
}

const standaloneDir = path.join(root, ".next", "standalone");
resolveSymlinks(standaloneDir);
console.log(`✓ Resolved ${symlinkCount} symlink(s)`);
console.log("\n✓ All preparation complete\n");
