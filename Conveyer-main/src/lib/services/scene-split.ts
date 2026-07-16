import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { getSetting, getRunDirectorNotes } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { getRunDir } from "../run-paths";

export interface Scene {
  index: number;
  text: string;
  visual_prompt: string;
  search_keywords?: string;
  duration_hint_sec: number;
  overlay_text?: string;
}

/**
 * Chunk threshold for scene-split.
 *
 * Gemini 2.5 Flash/Pro caps output at 65 535 tokens. A scene-split JSON
 * entry averages ~180 tokens (text + 60–120-word visual_prompt + duration),
 * so a 3 000-word script → ~300 scenes → ~54 K output — we are then
 * uncomfortably close to the hard cap. Anything longer we split into
 * ≤ 3 000-word chunks at SENTENCE boundaries and scene-split each chunk
 * separately, then concatenate. The pipeline downstream (TTS, video,
 * assembly) is unaware any chunking happened.
 *
 * Why sentence boundaries: the LLM never sees a half-sentence at the seam,
 * so coverage stays clean and no scene is born torn-in-two.
 */
const WORDS_PER_CHUNK = 3000;

/**
 * Splits the script into scenes. Supports Google Gemini (default, cheap) and
 * Anthropic Claude. Scripts longer than ~3 000 words (≈ 20–25 min of
 * narration) are automatically chunked — no manual intervention needed.
 */
export async function splitScript(runId: string, script: string): Promise<Scene[]> {
  const provider = (getSetting("SCENE_SPLIT_PROVIDER") || "google").toLowerCase();
  let systemPrompt = getPrompt("scene_split");

  const customDirectorPrompt = getSetting("DIRECTOR_PROMPT");
  if (customDirectorPrompt && customDirectorPrompt.trim()) {
    log(runId, "info", `🎬 Active Channel Director Mode Instructions: "${customDirectorPrompt.trim().slice(0, 100)}..."`, { stage: "scene_split" });
    systemPrompt = `${systemPrompt}\n\n=== CHANNEL DIRECTOR INSTRUCTIONS & FULL PIPELINE GUIDANCE ===\nThe Channel Director has provided the following creative rules, pacing guidance, and error-prevention guidelines. You are the Autonomous Director in charge of planning the scenes and solutions according to these instructions:\n\n${customDirectorPrompt.trim()}\n\nYou MUST strictly follow these Director Instructions when planning scene visuals, search keywords, tone, and pacing.`;
  }

  const runNotes = getRunDirectorNotes(runId);
  if (runNotes) {
    log(runId, "info", `🎬 Video-Specific Director Notes: "${runNotes.slice(0, 100)}..."`, { stage: "scene_split" });
    systemPrompt = `${systemPrompt}\n\n=== THIS VIDEO'S DIRECTOR & VISUAL GUIDANCE ===\nThe user has provided specific guidance for what kind of images, style, or focus they want in THIS video:\n"${runNotes}"\n\nYou MUST strictly follow these notes when writing visual_prompt and search_keywords!`;
  }

  if (getSetting("DIRECTOR_MODE") === "1") {
    log(runId, "info", "🎬 Director Mode enabled — reading script and analyzing topic, visual themes, and cinematography...", { stage: "scene_split" });
    try {
      const vision = await analyzeDirectorVision(runId, provider, script);
      if (vision && vision.trim()) {
        log(runId, "success", "🎬 Director Mode Analysis Complete:", { stage: "scene_split" });

        // Output each section of the analysis clearly in the logs so the user sees what the topic is about!
        const lines = vision.trim().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.match(/^[0-9#=*-]+\.?\s*(DETECTED|OVERARCHING|STILL|VIDEO|TOPIC|THEME|PROMPTING|CINEMATOGRAPHY)/i) || trimmed.startsWith("#") || trimmed.startsWith("===") || trimmed.startsWith("---")) {
            log(runId, "info", `   📍 ${trimmed.replace(/^[#=*-\s]+/, "")}`, { stage: "scene_split" });
          } else {
            log(runId, "info", `      ${trimmed}`, { stage: "scene_split" });
          }
        }

        systemPrompt = `${systemPrompt}\n\n=== DIRECTORIAL VISION BREAKDOWN ===\nYou MUST strictly adhere to the following Directorial Vision Breakdown for all scene visual prompts and motion instructions to maintain topic accuracy, setting continuity, color palette, lighting, and mood across the video:\n\n${vision.trim()}\n\nCRITICAL DIRECTORIAL INSTRUCTIONS:\n1. TOPIC ACCURACY: This script is about the DETECTED TOPIC above. Every scene's "visual_prompt" MUST accurately depict this subject matter with high visual fidelity.\n2. IMAGE & VIDEO PROMPTING: Follow the STILL IMAGE PROMPTING RULES and VIDEO ANIMATION PROMPTING RULES established above for each scene's visual description.\n3. STOCK KEYWORDS: While visual_prompt must be detailed and cinematic, "search_keywords" MUST remain simple 1 to 3 concrete physical nouns (under 3 words) suitable for literal stock footage matching.\n4. TEXT OVERLAYS: You are the Director overseeing on-screen typography. On-screen text MUST BE EXTREMELY RARE and impactful (used in at most 15-20% of scenes). DO NOT put overlay_text on ordinary dialogue or explanation scenes! ONLY output "overlay_text" when introducing a major chapter title (e.g. "PART 1: THE ANOMALY") or emphasizing a crucial number/year (e.g. "263 GALAXIES" or "$45 BILLION"). For all other scenes, set "overlay_text" to null.`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(runId, "warn", `Director Mode analysis failed (${msg.slice(0, 150)}) — proceeding with standard scene split`, { stage: "scene_split" });
    }
  }

  const totalWords = script.trim().split(/\s+/).filter(Boolean).length;
  log(runId, "info", `Splitting script (${provider}) — ${totalWords} words`, {
    stage: "scene_split",
    data: { scriptChars: script.length, totalWords },
  });

  let allScenes: Scene[];

  if (totalWords <= WORDS_PER_CHUNK) {
    // Small enough for one pass.
    allScenes = await splitOneChunk(runId, provider, systemPrompt, script, 0);
  } else {
    // Long script — split at sentence boundaries and scene-split each chunk.
    const chunks = chunkScript(script, WORDS_PER_CHUNK);
    log(
      runId,
      "info",
      `Script is too long for one ${provider} call (over ${WORDS_PER_CHUNK} words) — ` +
        `splitting into ${chunks.length} chunks for scene_split`,
      { stage: "scene_split", data: { chunkCount: chunks.length, totalWords } }
    );

    allScenes = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkWords = chunks[i].trim().split(/\s+/).filter(Boolean).length;
      log(
        runId,
        "info",
        `Scene-splitting chunk ${i + 1}/${chunks.length} (${chunkWords} words)`,
        { stage: "scene_split" }
      );
      const chunkScenes = await splitOneChunk(
        runId,
        provider,
        systemPrompt,
        chunks[i],
        allScenes.length
      );
      allScenes.push(...chunkScenes);
    }
  }

  // Programmatic safeguard: ensure on-screen text overlays are rare and impactful.
  // We enforce a minimum cooldown of 3 scenes between overlays so viewers aren't overwhelmed.
  let lastOverlayIndex = -999;
  for (let i = 0; i < allScenes.length; i++) {
    const s = allScenes[i];
    if (s.overlay_text) {
      const isChapter = /^((chapter|part|section|episode|#)\s*\d+)/i.test(s.overlay_text);
      if (!isChapter && i - lastOverlayIndex < 3 && i !== 0) {
        delete s.overlay_text;
      } else {
        lastOverlayIndex = i;
      }
    }
  }

  // ── Dynamic Intro Hook & Title Card Enforcer (First X% of Video) ─────────
  const introHookPercent = Number(getSetting("INTRO_HOOK_PERCENT") ?? 10);
  if (introHookPercent > 0 && allScenes.length > 0) {
    const hookCount = Math.max(1, Math.round((allScenes.length * introHookPercent) / 100));
    log(
      runId,
      "info",
      `🚀 Applying Dynamic Intro Hook & Title Cards to first ${hookCount} scene(s) (${introHookPercent}% of video)`,
      { stage: "scene_split" }
    );
    // Ensure Opening Title Card on Scene #0 if missing
    if (!allScenes[0].overlay_text && allScenes[0].text) {
      const firstWords = allScenes[0].text
        .replace(/[^a-zA-Z0-9\s]/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 4)
        .join(" ")
        .toUpperCase();
      if (firstWords) {
        allScenes[0].overlay_text = firstWords;
      }
    }
  }

  // Coverage check — words in scene.text vs original script. <70% means the
  // model summarized; we warn but still return what we got.
  const sceneWords = allScenes.reduce(
    (sum, s) => sum + s.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const coverage = totalWords > 0 ? (sceneWords / totalWords) * 100 : 0;

  log(
    runId,
    "success",
    `Done: ${allScenes.length} scenes · script coverage ${coverage.toFixed(0)}% (${sceneWords}/${totalWords} words)`,
    {
      stage: "scene_split",
      data: { scenes: allScenes.slice(0, 5).map((s) => ({ i: s.index, text: s.text.slice(0, 60) })) },
    }
  );

  if (coverage < 70) {
    log(
      runId,
      "warn",
      `⚠️ Low coverage (${coverage.toFixed(0)}%) — the model likely summarized the script. Review the scene_split prompt on /prompts.`,
      { stage: "scene_split" }
    );
  }

  return allScenes;
}

/**
 * Sends one chunk of script to the configured LLM and returns its scenes,
 * re-indexed starting at `sceneIndexOffset` so they line up inside the
 * full-script scene array.
 */
async function splitOneChunk(
  runId: string,
  provider: string,
  systemPrompt: string,
  scriptChunk: string,
  sceneIndexOffset: number
): Promise<Scene[]> {
  let raw: string;
  if (provider === "google") {
    raw = await splitWithGemini(systemPrompt, scriptChunk);
  } else if (provider === "anthropic") {
    raw = await splitWithClaude(systemPrompt, scriptChunk);
  } else {
    throw new Error(`Unknown SCENE_SPLIT_PROVIDER: ${provider}`);
  }

  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (e) {
    // Save raw output so we can see what went wrong — one file per chunk so
    // chunks don't overwrite each other's dumps.
    try {
      const runDir = getRunDir(runId);
      fs.mkdirSync(runDir, { recursive: true });
      const filename = `scene_split_raw_${sceneIndexOffset}.txt`;
      fs.writeFileSync(path.join(runDir, filename), raw, "utf-8");
      log(runId, "error", `Raw output saved to ${runDir}/${filename} (${raw.length} chars)`, {
        stage: "scene_split",
      });
    } catch {}
    throw e;
  }
  if (!Array.isArray(json)) {
    log(runId, "error", "LLM did not return an array", {
      stage: "scene_split",
      data: { raw: raw.slice(0, 500) },
    });
    throw new Error("scene_split: model did not return a JSON array");
  }

  return json.map((s, i) => ({
    index: sceneIndexOffset + i,
    text: String(s.text ?? ""),
    visual_prompt: String(s.visual_prompt ?? ""),
    search_keywords: s.search_keywords ? String(s.search_keywords) : undefined,
    duration_hint_sec: Number(s.duration_hint_sec ?? 6),
    overlay_text: s.overlay_text ? String(s.overlay_text).trim() : undefined,
  }));
}

/**
 * Splits a script into chunks at sentence boundaries, targeting `targetWords`
 * per chunk. A "sentence" is anything up to a `.`, `!` or `?`.
 *
 * If the script has no sentence terminators we return it whole — bad chunking
 * is worse than no chunking, and the only way to get here is a script written
 * without punctuation, which won't scene-split well anyway.
 */
function chunkScript(script: string, targetWords: number): string[] {
  const sentenceRegex = /[^.!?]+[.!?]+["')\]]*\s*/g;
  const matches = script.match(sentenceRegex);
  if (!matches || matches.length === 0) return [script];

  // If the regex didn't consume the trailing characters (e.g. a final
  // sentence without a terminator), append the leftover so we cover 100%
  // of the script.
  const sentences: string[] = [...matches];
  const captured = matches.join("");
  if (captured.length < script.length) {
    sentences.push(script.slice(captured.length));
  }

  const chunks: string[] = [];
  let current = "";
  let currentWords = 0;
  for (const sent of sentences) {
    const sentWords = sent.trim().split(/\s+/).filter(Boolean).length;
    if (currentWords > 0 && currentWords + sentWords > targetWords) {
      chunks.push(current.trim());
      current = "";
      currentWords = 0;
    }
    current += sent;
    currentWords += sentWords;
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks;
}

async function splitWithGemini(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Script:\n\n${script}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
      // 65535 — Gemini 2.5 Flash/Pro hard max for output. Per-chunk we target
      // ~3 000 words of input → ~54 K of output, leaving an 11 K-token buffer
      // before the hard cap. Anything that still overflows surfaces below
      // with a clear "split the script" message.
      maxOutputTokens: 65535,
      // Disable thinking — for structured output it just wastes the token budget
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // Retry with exponential backoff for transient errors
  // (503 UNAVAILABLE / 429 RATE_LIMIT / 500 — common Google API blips)
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_RETRIES = 4;
  let attempt = 0;
  let lastErr = "";

  while (attempt <= MAX_RETRIES) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (resp.ok) {
      const json = (await resp.json()) as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
          finishReason?: string;
        }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
      };
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      const reason = cand?.finishReason;
      if (reason && reason !== "STOP") {
        throw new Error(
          `Gemini finish=${reason} (output cut off, tokens=${json.usageMetadata?.candidatesTokenCount}). ` +
            `Even a single ~3 000-word chunk produced more than Gemini's 65 535-token output cap — ` +
            `try lowering WORDS_PER_CHUNK in scene-split.ts, or shorten this script chunk's visual_prompt instructions.`
        );
      }
      if (!text) throw new Error(`Gemini: empty output (${JSON.stringify(json).slice(0, 300)})`);
      return text;
    }
    const errText = (await resp.text()).slice(0, 400);
    lastErr = `Gemini ${resp.status}: ${errText}`;
    if (!RETRYABLE.has(resp.status) || attempt === MAX_RETRIES) {
      throw new Error(lastErr);
    }
    // 1s, 2s, 4s, 8s
    const waitMs = 1000 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, waitMs));
    attempt++;
  }
  throw new Error(lastErr);
}

async function splitWithClaude(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "claude-sonnet-4-6";
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Script:\n\n${script}` }],
  });
  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Extracts the first JSON array from a text response, even if the model added markdown or cut off the closing bracket. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  // Self-healing recovery for truncated JSON (e.g. missing closing bracket/brace from token cutoff)
  const startIdx = trimmed.indexOf("[");
  if (startIdx !== -1) {
    let candidate = trimmed.slice(startIdx).trim();
    // Remove trailing comma or incomplete token at the very end
    candidate = candidate.replace(/,\s*$/, "").replace(/,\s*([\}\]])$/, "$1");

    let openBrackets = 0;
    let openBraces = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < candidate.length; i++) {
      const c = candidate[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === "[") openBrackets++;
        else if (c === "]") openBrackets--;
        else if (c === "{") openBraces++;
        else if (c === "}") openBraces--;
      }
    }

    if (inString) candidate += '"';
    while (openBraces > 0) {
      candidate += "}";
      openBraces--;
    }
    while (openBrackets > 0) {
      candidate += "]";
      openBrackets--;
    }

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error("Could not parse JSON from model response");
}

async function analyzeDirectorVision(runId: string, provider: string, script: string): Promise<string> {
  const directorPrompt = getPrompt("director_analysis");
  let raw: string;
  if (provider === "anthropic") {
    raw = await splitWithClaude(directorPrompt, script);
  } else {
    raw = await splitWithGeminiText(directorPrompt, script);
  }
  try {
    const runDir = getRunDir(runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "director_vision.md"), raw, "utf-8");
  } catch {}
  return raw;
}

async function splitWithGeminiText(systemPrompt: string, script: string): Promise<string> {
  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (Settings)");
  const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: `Script:\n\n${script}` }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (resp.ok) {
    const json = (await resp.json()) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
      }[];
    };
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  }
  const errText = (await resp.text()).slice(0, 400);
  throw new Error(`Gemini ${resp.status}: ${errText}`);
}
