// Server-only module — runs once per dev server start to seed default settings/prompts.
import { seedDefaults } from "./settings";
import { seedPromptDefaults } from "./prompts";
import { seedDefaultChannel, syncActiveChannelToLive } from "./channels";

let inited = false;
export function ensureInit() {
  if (inited) return;
  seedDefaults();
  seedPromptDefaults();

  // Seed the default "Space" channel from current live prompts/settings.
  seedDefaultChannel();

  // Force-sync: write the active channel's settings_json into the live
  // settings table. This guarantees the live table always matches what
  // the user saved — no stale rows left behind by HMR restarts.
  syncActiveChannelToLive();

  inited = true;
}

