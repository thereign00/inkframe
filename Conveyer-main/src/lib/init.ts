// Server-only module — runs once per dev server start to seed default settings/prompts.
import { seedDefaults, getSetting, setSetting } from "./settings";
import { seedPromptDefaults } from "./prompts";
import { seedDefaultChannel, syncActiveChannelToLive } from "./channels";

let inited = false;
export function ensureInit() {
  if (inited) return;
  seedDefaults();
  seedPromptDefaults();

  // One-time migration: the old ANIMATION_PROVIDER default was "off", which
  // meant the pipeline silently skipped img2vid and produced a Ken-Burns
  // slideshow instead of the half-and-half mix users expect. Flip existing
  // DBs still on the legacy default to "69labs" so first-half clips kick
  // in. Users who explicitly chose `replicate` / `fal` are untouched; users
  // who actually want a static-image-only video can re-set it to "off" via
  // /advanced.
  if (getSetting("ANIMATION_PROVIDER") === "off") {
    setSetting("ANIMATION_PROVIDER", "69labs");
  }

  // One-time migration: the old TTS default pointed at Edge TTS
  // (TTS_VOICE_PROVIDER=edgetts + en-US-GuyNeural) even though the voice
  // fine-tuning defaults (stability / similarity / style / speaker-boost) are
  // all ElevenLabs-only — an inconsistency. The intended default is ElevenLabs
  // through 69labs. Flip ONLY DBs still on that exact untouched legacy combo
  // so a deliberate Edge / cloned-voice choice (any other voice id) is left
  // alone. Anyone who wants free Edge TTS can re-pick it in /advanced.
  if (
    getSetting("TTS_VOICE_PROVIDER") === "edgetts" &&
    getSetting("TTS_VOICE_ID") === "en-US-GuyNeural"
  ) {
    setSetting("TTS_VOICE_PROVIDER", "elevenlabs");
    setSetting("TTS_VOICE_ID", "G17SuINrv2H9FC6nvetn");
    if (!getSetting("TTS_MODEL")) setSetting("TTS_MODEL", "eleven_multilingual_v2");
  }

  // One-time migration: switch default providers from 69labs to kieai.
  // Only migrates if the user hasn't explicitly configured providers.
  // Users who want 69labs can switch back per-channel in the UI.
  if (getSetting("TTS_PROVIDER") === "69labs" && getSetting("IMAGE_PROVIDER") === "69labs") {
    setSetting("TTS_PROVIDER", "kieai");
    setSetting("IMAGE_PROVIDER", "kieai");
    setSetting("IMAGE_MODEL", "flux-kontext-pro");
    setSetting("TTS_VOICE_ID", "Rachel");
    if (getSetting("ANIMATION_PROVIDER") === "69labs") {
      setSetting("ANIMATION_PROVIDER", "kieai");
    }

    // Also migrate all existing channels' stored settings from 69labs to kieai
    const db = require("./db").default;
    const allChannels = db.prepare("SELECT id, settings_json FROM channels").all() as { id: string; settings_json: string }[];
    const updateStmt = db.prepare("UPDATE channels SET settings_json = ?, updated_at = datetime('now') WHERE id = ?");
    for (const ch of allChannels) {
      try {
        const settings = JSON.parse(ch.settings_json) as Record<string, string>;
        let changed = false;
        if (settings.TTS_PROVIDER === "69labs") { settings.TTS_PROVIDER = "kieai"; changed = true; }
        if (settings.IMAGE_PROVIDER === "69labs") { settings.IMAGE_PROVIDER = "kieai"; settings.IMAGE_MODEL = "flux-kontext-pro"; changed = true; }
        if (settings.ANIMATION_PROVIDER === "69labs") { settings.ANIMATION_PROVIDER = "kieai"; changed = true; }
        if (changed) {
          if (!settings.TTS_VOICE_ID || settings.TTS_VOICE_ID === "G17SuINrv2H9FC6nvetn") {
            settings.TTS_VOICE_ID = "Rachel";
          }
          updateStmt.run(JSON.stringify(settings), ch.id);
        }
      } catch { /* skip invalid JSON */ }
    }
  }

  // Seed the default "Space" channel from current live prompts/settings.
  // Runs AFTER migrations so the channel captures post-migration values.
  seedDefaultChannel();

  // Force-sync: write the active channel's settings_json into the live
  // settings table.  This guarantees the live table always matches what
  // the user saved — no stale rows left behind by migrations or HMR restarts.
  syncActiveChannelToLive();

  inited = true;
}

