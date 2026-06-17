import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import type { Scene } from "./scene-split";
import { createTtsJob, pollJob, downloadJob, tryNextKey, getKeyList } from "./labs69";
import { createKieTtsTask, pollKieTask, downloadKieTask } from "./kieai";

export interface TtsResult {
  /** Path to the mp3 file. */
  filePath: string;
  /** Approximate duration in seconds (from file size, refined later via ffprobe). */
  durationSec: number;
}

/**
 * Synthesizes one scene. Supports 69labs, KieAI, ElevenLabs (direct), OpenAI TTS.
 *
 * Key failover: if 69labs is the TTS provider and has multiple keys, tries
 * each key before falling back to TTS_FALLBACK_PROVIDER.
 *
 * Provider fallback: if TTS_FALLBACK_PROVIDER is set, retries with
 * the fallback provider when primary (all keys) fails.
 */
export async function synthesizeScene(
  runId: string,
  scene: Scene,
  outDir: string
): Promise<TtsResult> {
  const provider = (getSetting("TTS_PROVIDER") || "69labs").toLowerCase();
  const fallback = (getSetting("TTS_FALLBACK_PROVIDER") || "").toLowerCase().trim();
  const fileName = `scene_${String(scene.index).padStart(3, "0")}.mp3`;
  const filePath = path.join(outDir, fileName);

  // ── TTS disabled — generate a short silent audio file ──────────────────
  if (provider === "off") {
    const silenceDur = Number(getSetting("SCENE_DURATION") || "6");
    log(runId, "info", `TTS off — generating ${silenceDur}s silent audio for scene #${scene.index}`, {
      stage: "tts",
    });
    await generateSilence(filePath, silenceDur);
    return { filePath, durationSec: silenceDur };
  }

  // Try primary provider (with key failover for 69labs)
  try {
    return await synthesizeWithKeyFailover(runId, provider, scene, filePath);
  } catch (primaryErr) {
    // If no fallback configured, or same as primary, just throw
    if (!fallback || fallback === "off" || fallback === provider) {
      throw primaryErr;
    }

    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    log(runId, "warn",
      `TTS #${scene.index} primary (${provider}) failed all keys: ${msg.slice(0, 150)} → switching to fallback (${fallback})`,
      { stage: "tts" }
    );

    try {
      const result = await synthesizeWithKeyFailover(runId, fallback, scene, filePath);
      log(runId, "success", `TTS #${scene.index} recovered via fallback provider (${fallback})`, { stage: "tts" });
      return result;
    } catch (fallbackErr) {
      const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      log(runId, "error",
        `TTS #${scene.index} fallback (${fallback}) also failed: ${fbMsg.slice(0, 150)}`,
        { stage: "tts" }
      );
      throw primaryErr;
    }
  }
}

/**
 * Wraps synthesizeWithProvider with key-failover logic for 69labs.
 */
async function synthesizeWithKeyFailover(
  runId: string,
  provider: string,
  scene: Scene,
  filePath: string,
): Promise<TtsResult> {
  if (provider !== "69labs" || getKeyList().length <= 1) {
    return synthesizeWithProvider(runId, provider, scene, filePath);
  }

  const failedKeys = new Set<string>();
  let lastErr: Error | undefined;

  while (true) {
    try {
      return await synthesizeWithProvider(runId, provider, scene, filePath);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));

      const currentKey = getKeyList().find((k) => !failedKeys.has(k));
      if (currentKey) failedKeys.add(currentKey);

      const nextKey = tryNextKey(failedKeys);
      if (!nextKey) {
        log(runId, "warn",
          `TTS #${scene.index} exhausted all ${failedKeys.size} 69labs keys`,
          { stage: "tts" }
        );
        throw lastErr;
      }

      log(runId, "info",
        `TTS #${scene.index} key …${currentKey?.slice(-6) || "?"} failed → trying key …${nextKey.slice(-6)}`,
        { stage: "tts" }
      );
    }
  }
}

/**
 * Run TTS with a specific provider and validate output.
 */
async function synthesizeWithProvider(
  runId: string,
  provider: string,
  scene: Scene,
  filePath: string,
): Promise<TtsResult> {
  const fileName = path.basename(filePath);

  log(runId, "info", `TTS scene #${scene.index} (${provider})`, {
    stage: "tts",
    data: { provider, text: scene.text.slice(0, 80) },
  });

  if (provider === "69labs") {
    await labs69Tts(runId, scene.text, filePath);
  } else if (provider === "kieai") {
    await kieaiTts(runId, scene.text, filePath);
  } else if (provider === "elevenlabs") {
    await elevenLabs(scene.text, filePath);
  } else if (provider === "openai") {
    await openaiTts(scene.text, filePath);
  } else {
    throw new Error(`Unknown TTS provider: ${provider}`);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`TTS output file missing: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  // Sanity check: a valid MP3 with speech should be at least 1 KB.
  if (stats.size < 1024) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw new Error(`TTS output too small (${stats.size} bytes) — likely failed or empty audio`);
  }
  const durationSec = Math.max(1, stats.size / 16000);

  log(runId, "success", `TTS done: ${fileName} (~${durationSec.toFixed(1)}s)`, {
    stage: "tts",
  });
  return { filePath, durationSec };
}

async function labs69Tts(runId: string, text: string, outPath: string) {
  const voiceId = getSetting("TTS_VOICE_ID") || "en-US-GuyNeural";
  const voiceProviderRaw = (getSetting("TTS_VOICE_PROVIDER") || "edgetts").toLowerCase();
  const voiceProvider =
    voiceProviderRaw === "elevenlabs" || voiceProviderRaw === "edgetts" || voiceProviderRaw === "voice-clone"
      ? (voiceProviderRaw as "elevenlabs" | "edgetts" | "voice-clone")
      : "edgetts";
  const modelId = getSetting("TTS_MODEL") || undefined;
  const splitTypeRaw = (getSetting("TTS_SPLIT_TYPE") || "smart").toLowerCase();
  const splitType =
    splitTypeRaw === "paragraphs" || splitTypeRaw === "max_length"
      ? (splitTypeRaw as "smart" | "paragraphs" | "max_length")
      : "smart";

  // ElevenLabs-specific fine-tuning
  const voiceSettings: {
    stability?: number;
    similarityBoost?: number;
    speed?: number;
    style?: number;
    useSpeakerBoost?: boolean;
  } = {};
  if (voiceProvider === "elevenlabs") {
    const stability = parseFloatOr(getSetting("TTS_STABILITY"), NaN);
    const similarity = parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), NaN);
    const speed = parseFloatOr(getSetting("TTS_SPEED"), NaN);
    const style = parseFloatOr(getSetting("TTS_STYLE"), NaN);
    const speakerBoost = getSetting("TTS_USE_SPEAKER_BOOST");

    if (!Number.isNaN(stability)) voiceSettings.stability = clamp(stability, 0, 1);
    if (!Number.isNaN(similarity)) voiceSettings.similarityBoost = clamp(similarity, 0, 1);
    if (!Number.isNaN(speed)) voiceSettings.speed = clamp(speed, 0.7, 1.2);
    if (!Number.isNaN(style)) voiceSettings.style = clamp(style, 0, 1);
    if (speakerBoost === "1") voiceSettings.useSpeakerBoost = true;
    else if (speakerBoost === "0") voiceSettings.useSpeakerBoost = false;
  }

  // Auto-pause — stops TTS from rushing through sentence ends
  const autoPauseEnabled = getSetting("TTS_AUTO_PAUSE") === "1";
  const autoPauseDuration = parseFloatOr(getSetting("TTS_PAUSE_DURATION"), NaN);
  const autoPauseFrequency = parseFloatOr(getSetting("TTS_PAUSE_FREQUENCY"), NaN);

  const jobId = await createTtsJob({
    text,
    voiceId,
    voiceProvider,
    modelId,
    splitType,
    voiceSettings,
    autoPauseEnabled,
    autoPauseDuration: !Number.isNaN(autoPauseDuration) ? clamp(autoPauseDuration, 0.1, 30) : undefined,
    autoPauseFrequency: !Number.isNaN(autoPauseFrequency) ? clamp(autoPauseFrequency, 1, 100) : undefined,
    runId,
  });
  log(runId, "debug", `69labs TTS job ${jobId.slice(0, 8)}… (${voiceProvider}/${voiceId}, speed=${voiceSettings.speed ?? "default"}, pause=${autoPauseEnabled ? `${autoPauseDuration}s` : "off"})`, { stage: "tts" });
  await pollJob("tts", jobId, runId, "tts");
  await downloadJob("tts", jobId, outPath);
}

async function kieaiTts(runId: string, text: string, outPath: string) {
  const rawVoice = getSetting("TTS_VOICE_ID") || "";
  const rawModel = getSetting("TTS_MODEL") || "";

  // Map 69labs / ElevenLabs model names to Kie AI's format
  const KIE_TTS_MODEL_MAP: Record<string, string> = {
    "eleven_multilingual_v2": "elevenlabs/text-to-speech-multilingual-v2",
    "eleven_flash_v2_5": "elevenlabs/text-to-speech-turbo-2-5",
    "eleven_monolingual_v1": "elevenlabs/text-to-speech-multilingual-v2",
  };
  const kieModel = rawModel.startsWith("elevenlabs/")
    ? rawModel
    : KIE_TTS_MODEL_MAP[rawModel] || "elevenlabs/text-to-speech-multilingual-v2";

  const stability = parseFloatOr(getSetting("TTS_STABILITY"), 0.6);
  const similarity = parseFloatOr(getSetting("TTS_SIMILARITY_BOOST"), 0.75);

  // Kie AI accepts voice names (e.g. "Rachel", "Adam") directly.
  // If the user set a known legacy ElevenLabs voice ID, map it to a name.
  // Otherwise, pass through exactly what the user configured.
  const KIE_VOICE_ID_TO_NAME: Record<string, string> = {
    "21m00Tcm4TlvDq8ikWAM": "Rachel",
    "ErXwobaYiN019PkySvjV": "Antoni",
    "pNInz6obpgDQGcFmaJgB": "Adam",
    "VR6AewLTigWG4xSOukaG": "Arnold",
    "TxGEqnHWrfWFTfGW9XjX": "Josh",
    "EXAVITQu4vr4xnSDxMaL": "Bella",
    "MF3mGyEYCl7XYWbV9V6O": "Elli",
    "yoZ06aMxZJJ28mfd3POQ": "Sam",
    "jBpfAIEqQ950yJCAlMOl": "George",
    "onwK4e9ZLuTAKqWW03F9": "Daniel",
    "XB0fDUnXU5powFXDhCwa": "Charlotte",
    "G17SuINrv2H9FC6nvetn": "Christopher",
  };
  // Use the user's value directly — only map if it's a known legacy ID
  const voiceName = KIE_VOICE_ID_TO_NAME[rawVoice] || rawVoice || "Rachel";

  log(runId, "debug", `KieAI TTS using voice=${voiceName} model=${kieModel}`, { stage: "tts" });

  const taskId = await createKieTtsTask({
    text,
    voiceId: voiceName,
    model: kieModel,
    stability: Number.isNaN(stability) ? undefined : stability,
    similarityBoost: Number.isNaN(similarity) ? undefined : similarity,
    runId,
  });
  log(runId, "debug", `KieAI TTS task ${taskId.slice(0, 8)}… (${kieModel}/${voiceName})`, { stage: "tts" });
  const data = await pollKieTask(taskId, runId, "tts");
  await downloadKieTask(data, outPath);
}

function parseFloatOr(s: string, fallback: number): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

async function elevenLabs(text: string, outPath: string) {
  const apiKey = getSetting("ELEVENLABS_API_KEY");
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  const voiceId = getSetting("TTS_VOICE_ID") || "21m00Tcm4TlvDq8ikWAM";
  const model = getSetting("TTS_MODEL") || "eleven_multilingual_v2";

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: model }),
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ElevenLabs ${resp.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function openaiTts(text: string, outPath: string) {
  const apiKey = getSetting("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("TTS_MODEL") || "gpt-4o-mini-tts";
  const voice = getSetting("TTS_VOICE_ID") || "alloy";

  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, voice, input: text, format: "mp3" }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI TTS ${resp.status}: ${body.slice(0, 300)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

// ── Silent audio generator (for TTS-off mode) ────────────────────────────

async function generateSilence(outPath: string, durationSec: number): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { getSetting: gs } = await import("../settings");
  const ffmpegPath = gs("FFMPEG_PATH") || "ffmpeg";

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        "-f", "lavfi",
        "-i", `anullsrc=r=44100:cl=mono`,
        "-t", String(durationSec),
        "-c:a", "libmp3lame",
        "-b:a", "128k",
        "-y",
        outPath,
      ],
      { timeout: 15_000 },
      (err) => {
        if (err) reject(new Error(`ffmpeg silence generation failed: ${err.message}`));
        else resolve();
      }
    );
  });
}
