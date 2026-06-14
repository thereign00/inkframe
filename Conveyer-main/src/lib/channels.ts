import crypto from "node:crypto";
import db from "./db";
import { getAllPrompts, setPrompt, type PromptName, PROMPT_NAMES } from "./prompts";
import {
  getSetting,
  setSetting,
  CHANNEL_SCOPED_KEYS,
  applyChannelOverrides,
  clearChannelOverrides,
  type SettingKey,
} from "./settings";

// ── Types ────────────────────────────────────────────────────────────────

export interface Channel {
  id: string;
  name: string;
  prompts_json: string;
  settings_json: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  is_active: number;
}

// ── Prepared statements ──────────────────────────────────────────────────

const stmts = {
  list: db.prepare(
    "SELECT id, name, is_active FROM channels ORDER BY created_at ASC"
  ),
  getById: db.prepare("SELECT * FROM channels WHERE id = ?"),
  getActive: db.prepare("SELECT * FROM channels WHERE is_active = 1 LIMIT 1"),
  insert: db.prepare(
    `INSERT INTO channels (id, name, prompts_json, settings_json, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ),
  updateName: db.prepare(
    "UPDATE channels SET name = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  updateSnapshot: db.prepare(
    `UPDATE channels SET prompts_json = ?, settings_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  ),
  setActive: db.prepare(
    "UPDATE channels SET is_active = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  clearActive: db.prepare(
    "UPDATE channels SET is_active = 0 WHERE is_active = 1"
  ),
  deleteById: db.prepare("DELETE FROM channels WHERE id = ?"),
  count: db.prepare("SELECT COUNT(*) as cnt FROM channels"),
  nameExists: db.prepare(
    "SELECT 1 FROM channels WHERE name = ? COLLATE NOCASE LIMIT 1"
  ),
  nameExistsExcluding: db.prepare(
    "SELECT 1 FROM channels WHERE name = ? COLLATE NOCASE AND id != ? LIMIT 1"
  ),
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Snapshot the current live prompts from the prompts table. */
function snapshotPrompts(): Record<string, string> {
  return getAllPrompts();
}

/** Snapshot the current live channel-scoped settings from the settings table. */
function snapshotScopedSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CHANNEL_SCOPED_KEYS) {
    out[key] = getSetting(key);
  }
  return out;
}

/** Apply a prompts snapshot to the live prompts table. */
function applyPrompts(prompts: Record<string, string>) {
  for (const name of PROMPT_NAMES) {
    if (name in prompts) {
      setPrompt(name, prompts[name]);
    }
  }
}

/** Apply a scoped-settings snapshot to BOTH the in-memory override map
 *  AND the live settings table.  The in-memory map is what getSetting()
 *  reads first, so this guarantees immediate visibility. */
function applyScopedSettings(settings: Record<string, string>) {
  applyChannelOverrides(settings);
}

function assertUniqueName(name: string, excludeId?: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Channel name cannot be empty.");
  const exists = excludeId
    ? stmts.nameExistsExcluding.get(trimmed, excludeId)
    : stmts.nameExists.get(trimmed);
  if (exists) throw new Error(`A channel named "${trimmed}" already exists.`);
}

// ── Public API ───────────────────────────────────────────────────────────

export function listChannels(): ChannelSummary[] {
  return stmts.list.all() as ChannelSummary[];
}

export function getActiveChannel(): Channel | null {
  return (stmts.getActive.get() as Channel) ?? null;
}

export function getChannelById(id: string): Channel | null {
  return (stmts.getById.get(id) as Channel) ?? null;
}

/**
 * Update the stored prompts for a non-active channel directly.
 * For active channels, use the prompts page + saveActiveChannel() instead.
 */
export function updateChannelPrompts(id: string, prompts: Record<string, string>) {
  const ch = stmts.getById.get(id) as Channel | undefined;
  if (!ch) throw new Error(`Channel ${id} not found.`);

  // Merge with existing prompts_json (in case only some keys are provided)
  const existing = JSON.parse(ch.prompts_json) as Record<string, string>;
  const merged = { ...existing, ...prompts };
  const settingsJson = ch.settings_json; // keep settings unchanged

  stmts.updateSnapshot.run(JSON.stringify(merged), settingsJson, id);
}

/**
 * Update the stored scoped settings for a channel directly.
 * Merges provided keys with the existing settings_json.
 * For active channels, also applies the changes to the live settings table.
 */
export function updateChannelSettings(id: string, settings: Record<string, string>) {
  const ch = stmts.getById.get(id) as Channel | undefined;
  if (!ch) throw new Error(`Channel ${id} not found.`);

  const existing = JSON.parse(ch.settings_json) as Record<string, string>;
  const merged = { ...existing, ...settings };
  const promptsJson = ch.prompts_json; // keep prompts unchanged

  stmts.updateSnapshot.run(promptsJson, JSON.stringify(merged), id);

  // If this is the active channel, force-sync ALL saved settings to the live table.
  // We re-read from DB to guarantee we write exactly what was saved.
  if (ch.is_active === 1) {
    const fresh = stmts.getById.get(id) as Channel;
    const freshSettings = JSON.parse(fresh.settings_json) as Record<string, string>;
    applyScopedSettings(freshSettings);
  }
}

/**
 * Create a new channel.
 * @param name   Display name (must be unique).
 * @param fromActive  If true, snapshot the current live prompts+settings.
 *                    If false, use hard-coded defaults from the source.
 */
export function createChannel(name: string, fromActive = true): Channel {
  assertUniqueName(name);
  const id = crypto.randomUUID();
  const promptsJson = JSON.stringify(snapshotPrompts());
  const settingsJson = JSON.stringify(
    fromActive ? snapshotScopedSettings() : defaultScopedSettings()
  );
  stmts.insert.run(id, name.trim(), promptsJson, settingsJson, 0);
  return stmts.getById.get(id) as Channel;
}

/**
 * Duplicate an existing channel under a new name.
 */
export function duplicateChannel(id: string, newName: string): Channel {
  const source = stmts.getById.get(id) as Channel | undefined;
  if (!source) throw new Error(`Channel ${id} not found.`);
  assertUniqueName(newName);
  const newId = crypto.randomUUID();
  stmts.insert.run(
    newId,
    newName.trim(),
    source.prompts_json,
    source.settings_json,
    0
  );
  return stmts.getById.get(newId) as Channel;
}

/**
 * Rename a channel.
 */
export function renameChannel(id: string, name: string) {
  const ch = stmts.getById.get(id) as Channel | undefined;
  if (!ch) throw new Error(`Channel ${id} not found.`);
  assertUniqueName(name, id);
  stmts.updateName.run(name.trim(), id);
}

/**
 * Delete a channel. If it was the active channel, activate another one.
 * If no channels remain, re-seed a default.
 */
export function deleteChannel(id: string) {
  const ch = stmts.getById.get(id) as Channel | undefined;
  if (!ch) throw new Error(`Channel ${id} not found.`);
  const wasActive = ch.is_active === 1;
  stmts.deleteById.run(id);

  if (wasActive) {
    const remaining = listChannels();
    if (remaining.length > 0) {
      // Activate the first remaining channel
      switchChannel(remaining[0].id);
    } else {
      // No channels left — re-seed default
      seedDefaultChannel();
    }
  }
}

/**
 * Switch to a channel: write its saved prompts + scoped settings into
 * the live tables. Wrapped in a transaction for atomicity.
 */
export const switchChannel = db.transaction((id: string) => {
  const ch = stmts.getById.get(id) as Channel | undefined;
  if (!ch) throw new Error(`Channel ${id} not found.`);

  // Parse the stored snapshots
  const prompts = JSON.parse(ch.prompts_json) as Record<string, string>;
  const settings = JSON.parse(ch.settings_json) as Record<string, string>;

  // Apply to live tables
  applyPrompts(prompts);
  applyScopedSettings(settings);

  // Mark this channel as active, clear others
  stmts.clearActive.run();
  stmts.setActive.run(1, id);
});

/**
 * Save the current live prompts + scoped settings back into the active
 * channel's row. This is how edits made on /prompts or /settings/advanced
 * get persisted into the channel.
 */
export function saveActiveChannel() {
  const active = getActiveChannel();
  if (!active) throw new Error("No active channel to save.");

  const promptsJson = JSON.stringify(snapshotPrompts());
  const settingsJson = JSON.stringify(snapshotScopedSettings());
  stmts.updateSnapshot.run(promptsJson, settingsJson, active.id);
}

/**
 * Force-sync: read the active channel's settings_json and write EVERY
 * scoped key into the live settings table.  This guarantees the pipeline
 * always sees what the user saved — no stale rows, no missed keys.
 *
 * Call this at the start of every pipeline run and after any settings save.
 */
export function syncActiveChannelToLive() {
  const active = getActiveChannel();
  if (!active) return;

  const settings = JSON.parse(active.settings_json) as Record<string, string>;
  applyScopedSettings(settings);
}

/**
 * On first run (or after deleting the last channel), create a default
 * channel from the current live prompts/settings. Idempotent — does
 * nothing if channels already exist.
 */
export function seedDefaultChannel() {
  const { cnt } = stmts.count.get() as { cnt: number };
  if (cnt > 0) return;

  const id = crypto.randomUUID();
  const promptsJson = JSON.stringify(snapshotPrompts());
  const settingsJson = JSON.stringify(snapshotScopedSettings());
  stmts.insert.run(id, "Space", promptsJson, settingsJson, 1);
}

// ── Internal helpers ─────────────────────────────────────────────────────

/** Build a scoped-settings snapshot from the hard-coded DEFAULTS. */
function defaultScopedSettings(): Record<string, string> {
  // Import DEFAULTS at function level to avoid circular-init issues.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DEFAULTS } = require("./settings") as { DEFAULTS: Record<string, string> };
  const out: Record<string, string> = {};
  for (const key of CHANNEL_SCOPED_KEYS) {
    out[key] = DEFAULTS[key] ?? "";
  }
  return out;
}
