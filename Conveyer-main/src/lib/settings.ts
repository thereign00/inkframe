import db from "./db";

/**
 * Keys the user can edit through the UI or via .env.
 * UI takes precedence over .env (env is only the fallback when the DB row is empty).
 */
export const SETTING_KEYS = [
  // ── Required API keys ─────────────────────────────────────────────
  "GOOGLE_API_KEY",          // Gemini — scene splitting
  "LABS69_API_KEY",          // 69labs — TTS + images + img2vid (all-in-one)

  // ── Optional / backup providers ───────────────────────────────────
  "ELEVENLABS_API_KEY",      // direct ElevenLabs (without 69labs)
  "ELEVENLABS_VOICE_ID",     // ElevenLabs voice ID (for direct ElevenLabs mode)
  "ELEVENLABS_MODEL",        // ElevenLabs model (for direct ElevenLabs mode)
  "PIXABAY_API_KEY",         // Pixabay API key for stock footage
  "PEXELS_API_KEY",          // Pexels API key for stock footage
  "KIEAI_API_KEY",            // Kie AI — unified gateway (TTS + images + video)
  "REPLICATE_API_TOKEN",     // Replicate (Flux / Kling)
  "ANTHROPIC_API_KEY",       // Claude (alternative to Gemini)
  "OPENAI_API_KEY",          // OpenAI TTS / image backup
  "FAL_API_KEY",             // fal.ai (alternative to Replicate)
  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (LLM) ─────────────────────────────────────────
  "SCENE_SPLIT_PROVIDER",    // google | anthropic
  "SCENE_SPLIT_MODEL",       // e.g. gemini-flash-latest, claude-sonnet-4-6
  "DIRECTOR_MODE",           // "1" to enable holistic story analysis before scene breakdown
  "DIRECTOR_PROMPT",         // Custom instructions for the AI Director when planning videos & handling errors
  "INTRO_HOOK_PERCENT",      // Percentage of initial scenes with rapid intro pacing & title cards (0-40, default 10)

  // ── Text-to-Speech ────────────────────────────────────────────────
  "TTS_PROVIDER",            // 69labs | kieai | elevenlabs | openai
  "TTS_FALLBACK_PROVIDER",   // Fallback if primary TTS fails (off | 69labs | kieai | elevenlabs | openai)
  "TTS_VOICE_PROVIDER",      // For 69labs: edgetts | elevenlabs | voice-clone
  "TTS_VOICE_ID",            // Voice id (ElevenLabs / Edge / clone UUID)
  "TTS_MODEL",               // e.g. eleven_multilingual_v2
  "TTS_SPLIT_TYPE",          // smart | paragraphs | max_length

  // ── ElevenLabs voice fine-tuning ──────────────────────────────────
  "TTS_SPEED",               // 0.7–1.2 (lower = slower)
  "TTS_STABILITY",           // 0–1
  "TTS_SIMILARITY_BOOST",    // 0–1
  "TTS_STYLE",               // 0–1
  "TTS_USE_SPEAKER_BOOST",   // "1" / "0" / ""

  // ── Auto-pause (stops TTS from "swallowing" sentence ends) ────────
  "TTS_AUTO_PAUSE",          // "1" to enable
  "TTS_PAUSE_DURATION",      // seconds (0.1–30)
  "TTS_PAUSE_FREQUENCY",     // 1–100

  // ── Images ────────────────────────────────────────────────────────
  "IMAGE_PROVIDER",          // 69labs | kieai | replicate | openai | fal | comfyui
  "IMAGE_FALLBACK_PROVIDER", // Fallback if primary provider fails (off | 69labs | kieai | comfyui)
  "IMAGE_MODEL",             // e.g. nano-banana-pro, imagen-4, seedream-4.5
  "IMAGE_RATIO",             // e.g. 16:9, 9:16, 1:1
  "IMAGE_RESOLUTION",        // 1k | 2k | 4k (for models that support it)
  "KIEAI_DEFAULT_IMAGE_MODEL", // Default KieAI image model (used during fallback)

  // ── Local ComfyUI (Offline AI Engine) ─────────────────────────────
  "COMFYUI_URL",             // e.g. http://127.0.0.1:8188
  "COMFYUI_API_KEY",         // Optional API key for ComfyUI Cloud
  "COMFYUI_IMAGE_WORKFLOW",  // Custom ComfyUI API JSON for txt2img (empty = default SDXL/Flux)
  "COMFYUI_VIDEO_WORKFLOW",  // Custom ComfyUI API JSON for img2vid (empty = default SVD)

  // ── Animations (img2vid) ──────────────────────────────────────────
  "ANIMATION_PROVIDER",      // off | 69labs | kieai | replicate | fal | comfyui
  "ANIMATION_FALLBACK_PROVIDER", // Fallback if primary animation provider fails (off | 69labs | kieai | comfyui)
  "ANIMATION_MODEL",         // e.g. veo-video, grok-imagine-video
  "ANIMATION_RATIO_PERCENT", // 0–100, percentage of scenes to animate
  "ANIMATION_DISTRIBUTION",  // first-half | alternating | random | all
  "ANIMATION_DURATION",      // seconds (provider-dependent)
  "ANIMATION_KEEP_VEO_AUDIO", // "1" to keep Veo's generated ambient audio
  "VIDEO_QUALITY",             // 480p | 720p | 1080p (for Runway/Minimax/Wan models)
  "KIEAI_DEFAULT_VIDEO_MODEL", // Default KieAI video model (used during fallback)
  "STOCK_FOOTAGE_RATIO_PERCENT", // 0-100, percentage of scenes to use stock video
  "STOCK_FOOTAGE_PROVIDER",    // all | pixabay | pexels | off
  "REAL_MATCH_THRESHOLD",      // 0-100 threshold for AI relevance gating of stock footage
  "REAL_IMAGE_RATIO_PERCENT",  // 0-100, percentage of scenes to use verified real images (Wikimedia/NASA)
  "REAL_IMAGE_PROVIDER",       // all | wikimedia | nasa | off

  // ── Video assembly (FFmpeg) ───────────────────────────────────────
  "VIDEO_RESOLUTION",        // e.g. 1920x1080
  "VIDEO_FPS",               // 24 / 30 / 60
  "SCENE_DURATION_SECONDS",  // fallback duration when TTS length is unknown
  "SCENE_DURATION",           // per-scene duration in seconds when TTS is off
  "TRANSITION_DURATION",     // crossfade between scenes in seconds (0 = none)
  "SCENE_TAIL_SILENCE",      // silence appended to each clip's audio (seconds), creates breathing room between scenes

  // ── Performance / Concurrency ─────────────────────────────────────
  "IMAGE_CONCURRENCY",       // parallel image jobs
  "TTS_CONCURRENCY",         // parallel TTS jobs
  "ANIMATION_CONCURRENCY",   // parallel img2vid jobs
  "ASSEMBLE_CONCURRENCY",    // parallel FFmpeg clip renders
  "ASSEMBLE_XFADE_CHUNKS",            // 1 = monolithic xfade (legacy); anything else = hierarchical
  "ASSEMBLE_XFADE_MAX_CLIPS_PER_PASS", // hard cap on inputs per ffmpeg xfade call (default 50)
  "BATCH_SIZE",                // how many scenes process concurrently in each batch

  // ── Google Drive sync ─────────────────────────────────────────────
  // OAuth2 credentials from Google Cloud Console (Web Application client).
  // Redirect URI must be set to http://localhost:3000/api/gdrive/oauth/callback
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  // Refresh token, set automatically after the user completes the OAuth flow.
  // Don't edit by hand.
  "GDRIVE_REFRESH_TOKEN",
  // Email of the Google account that authorized — set automatically, shown in UI.
  "GDRIVE_CONNECTED_EMAIL",
  // Folder IDs in Drive. Empty = auto-create `Conveyer/Final Videos` and
  // `Conveyer/Clips Library` in the user's Drive root on first sync.
  "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
  "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
  // Master switch. Empty/"0" = disabled (don't upload). "1" = upload after every run.
  "GDRIVE_SYNC_ENABLED",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

/**
 * In-memory override map for channel-scoped settings.
 * Populated by `applyChannelOverrides()` whenever the active channel changes
 * or settings are saved.  `getSetting()` checks this map FIRST — if the key
 * is present, it returns the in-memory value, bypassing the DB entirely.
 * This guarantees the pipeline always uses exactly what the user saved.
 */
const _overrides = new Map<string, string>();

/** Load channel-scoped settings into the in-memory override map.
 *  Called by channels.ts whenever settings are saved or a channel is activated. */
export function applyChannelOverrides(settings: Record<string, string>) {
  _overrides.clear();
  for (const key of CHANNEL_SCOPED_KEYS) {
    const val = key in settings && settings[key] !== undefined ? settings[key] : (DEFAULTS[key] ?? "");
    _overrides.set(key, val);
    // Also persist to DB for non-pipeline readers (settings page, etc)
    upsertStmt.run(key, val);
  }
}

/** Clear in-memory overrides (used when switching channels). */
export function clearChannelOverrides() {
  _overrides.clear();
}

export function getSetting(key: SettingKey): string {
  // 1. In-memory override (from active channel) takes highest priority
  const override = _overrides.get(key);
  if (override !== undefined && override !== "") return override;
  // 2. DB value
  const row = getStmt.get(key) as { value: string } | undefined;
  if (row && row.value !== "") return row.value;
  // 3. Environment variable fallback
  return process.env[key] ?? "";
}

export function setSetting(key: SettingKey, value: string) {
  upsertStmt.run(key, value);
  // Keep override map in sync if this is a scoped key
  if ((CHANNEL_SCOPED_KEYS as readonly string[]).includes(key)) {
    _overrides.set(key, value);
  }
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  return out;
}

/** Keys whose values are secrets and should be masked when sent to the UI. */
function isSecretKey(key: string): boolean {
  return key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET");
}

/** Safe version — masks secret keys/tokens/secrets. Handles multi-line key lists too. */
export function getMaskedSettings(): Record<string, string> {
  const all = getAllSettings();
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isSecretKey(k)) {
      if (!v) {
        masked[k] = "";
      } else {
        // Mask each line/entry separately so multi-key fields show all entries
        const parts = v.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
        masked[k] = parts.map((p) => `${p.slice(0, 4)}…${p.slice(-4)}`).join("\n");
      }
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export const DEFAULTS: Record<SettingKey, string> = {
  // Required API keys — empty by default, user must provide
  GOOGLE_API_KEY: "",
  LABS69_API_KEY: "",

  // Optional providers
  ELEVENLABS_API_KEY: "",
  ELEVENLABS_VOICE_ID: "21m00Tcm4TlvDq8ikWAM", // Rachel
  ELEVENLABS_MODEL: "eleven_multilingual_v2",
  PIXABAY_API_KEY: "",
  PEXELS_API_KEY: "",
  KIEAI_API_KEY: "",
  REPLICATE_API_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  FAL_API_KEY: "",
  FFMPEG_PATH: "",

  // Storage — empty = use default (DATA_DIR/runs)
  RUNS_OUTPUT_DIR: "",

  // Scene split
  SCENE_SPLIT_PROVIDER: "google",
  SCENE_SPLIT_MODEL: "gemini-flash-latest",
  DIRECTOR_MODE: "0",
  DIRECTOR_PROMPT: "",
  INTRO_HOOK_PERCENT: "10",

  // TTS — default runs through KieAI's ElevenLabs gateway.
  // 69labs is still available as an alternative (set TTS_PROVIDER to "69labs").
  // Voice names (e.g. "Rachel", "Adam") work on KieAI; voice IDs work on 69labs.
  TTS_PROVIDER: "kieai",
  TTS_VOICE_PROVIDER: "elevenlabs",
  TTS_VOICE_ID: "Rachel", // ElevenLabs "Rachel" — works on both KieAI and 69labs
  TTS_MODEL: "eleven_multilingual_v2",
  TTS_SPLIT_TYPE: "smart",

  // Voice fine-tuning (slightly slower + small style for documentary feel)
  TTS_SPEED: "0.93",
  TTS_STABILITY: "0.6",
  TTS_SIMILARITY_BOOST: "0.75",
  TTS_STYLE: "0.15",
  TTS_USE_SPEAKER_BOOST: "1",

  // Auto-pause on sentence boundaries
  TTS_AUTO_PAUSE: "1",
  TTS_PAUSE_DURATION: "0.4",
  TTS_PAUSE_FREQUENCY: "1",
  TTS_FALLBACK_PROVIDER: "",

  // Images — KieAI uses flux-kontext-pro by default; 69labs uses nano-banana-pro
  IMAGE_PROVIDER: "kieai",
  IMAGE_FALLBACK_PROVIDER: "",
  IMAGE_MODEL: "flux-kontext-pro",
  IMAGE_RATIO: "16:9",
  IMAGE_RESOLUTION: "1k",
  COMFYUI_URL: "http://127.0.0.1:8188",
  COMFYUI_API_KEY: "",
  COMFYUI_IMAGE_WORKFLOW: "",
  COMFYUI_VIDEO_WORKFLOW: "",

  // Animations — KieAI by default; 69labs available per channel
  ANIMATION_PROVIDER: "kieai",
  ANIMATION_FALLBACK_PROVIDER: "",
  ANIMATION_MODEL: "veo-video",
  ANIMATION_RATIO_PERCENT: "100",
  ANIMATION_DISTRIBUTION: "all",
  ANIMATION_DURATION: "5",
  ANIMATION_KEEP_VEO_AUDIO: "",
  VIDEO_QUALITY: "720p",
  KIEAI_DEFAULT_IMAGE_MODEL: "flux-kontext-pro",
  KIEAI_DEFAULT_VIDEO_MODEL: "veo3_fast",
  STOCK_FOOTAGE_RATIO_PERCENT: "0",
  STOCK_FOOTAGE_PROVIDER: "all",
  REAL_MATCH_THRESHOLD: "65",
  REAL_IMAGE_RATIO_PERCENT: "0",
  REAL_IMAGE_PROVIDER: "all",

  // Video assembly
  VIDEO_RESOLUTION: "1920x1080",
  VIDEO_FPS: "30",
  SCENE_DURATION_SECONDS: "5",
  SCENE_DURATION: "6",
  TRANSITION_DURATION: "0.5",
  SCENE_TAIL_SILENCE: "0.4",

  // Performance
  IMAGE_CONCURRENCY: "5",
  TTS_CONCURRENCY: "3",
  ANIMATION_CONCURRENCY: "3",
  ASSEMBLE_CONCURRENCY: "4",
  ASSEMBLE_XFADE_CHUNKS: "4",
  ASSEMBLE_XFADE_MAX_CLIPS_PER_PASS: "50",
  BATCH_SIZE: "10",

  // Google Drive — all empty by default. User fills client_id/secret;
  // OAuth flow fills refresh_token + email; folders auto-create on first sync.
  GDRIVE_CLIENT_ID: "",
  GDRIVE_CLIENT_SECRET: "",
  GDRIVE_REFRESH_TOKEN: "",
  GDRIVE_CONNECTED_EMAIL: "",
  GDRIVE_FINAL_VIDEOS_FOLDER_ID: "",
  GDRIVE_CLIPS_LIBRARY_FOLDER_ID: "",
  GDRIVE_SYNC_ENABLED: "",
};

/** Write defaults for any keys that aren't already in the DB. */
export function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const row = getStmt.get(k) as { value: string } | undefined;
    if (!row) upsertStmt.run(k, v);
  }
}

/**
 * Channel-scoped keys — the niche-defining subset of settings that each
 * channel stores its own copy of. Everything NOT in this list (API keys,
 * paths, video assembly, concurrency, Drive) stays global.
 */
export const CHANNEL_SCOPED_KEYS: SettingKey[] = [
  "IMAGE_PROVIDER", "IMAGE_FALLBACK_PROVIDER", "IMAGE_MODEL", "IMAGE_RATIO", "IMAGE_RESOLUTION",
  "COMFYUI_IMAGE_WORKFLOW", "COMFYUI_VIDEO_WORKFLOW",
  "TTS_PROVIDER", "TTS_FALLBACK_PROVIDER", "TTS_VOICE_PROVIDER", "TTS_VOICE_ID", "TTS_MODEL", "TTS_SPLIT_TYPE",
  "TTS_SPEED", "TTS_STABILITY", "TTS_SIMILARITY_BOOST", "TTS_STYLE", "TTS_USE_SPEAKER_BOOST",
  "TTS_AUTO_PAUSE", "TTS_PAUSE_DURATION", "TTS_PAUSE_FREQUENCY",
  "ANIMATION_PROVIDER", "ANIMATION_FALLBACK_PROVIDER", "ANIMATION_MODEL", "ANIMATION_RATIO_PERCENT",
  "ANIMATION_DISTRIBUTION", "ANIMATION_DURATION", "ANIMATION_KEEP_VEO_AUDIO",
  "VIDEO_QUALITY",
  "KIEAI_DEFAULT_IMAGE_MODEL", "KIEAI_DEFAULT_VIDEO_MODEL",
  "DIRECTOR_MODE", "DIRECTOR_PROMPT", "INTRO_HOOK_PERCENT", "STOCK_FOOTAGE_RATIO_PERCENT", "STOCK_FOOTAGE_PROVIDER",
  "REAL_IMAGE_RATIO_PERCENT", "REAL_IMAGE_PROVIDER",
];

/** Retrieve run-specific director notes from config_json if provided by user on run creation */
export function getRunDirectorNotes(runId: string): string {
  try {
    const row = db.prepare("SELECT config_json FROM runs WHERE id = ?").get(runId) as { config_json?: string } | undefined;
    if (row?.config_json) {
      const parsed = JSON.parse(row.config_json);
      return (parsed.directorNotes || "").trim();
    }
  } catch {}
  return "";
}
