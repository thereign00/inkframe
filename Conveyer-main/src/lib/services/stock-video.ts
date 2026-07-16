import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled, CancelledError } from "../cancellation";
import { type Scene } from "./scene-split";

/**
 * Selects scene indices that should use real stock footage based on the configured ratio percentage.
 */
export function pickScenesForStock(
  scenes: Scene[],
  ratioPercent: number,
  excludeIndices = new Set<number>()
): Set<number> {
  if (ratioPercent <= 0 || getSetting("STOCK_FOOTAGE_PROVIDER") === "off") return new Set();
  const available = scenes.filter((s) => !excludeIndices.has(s.index));
  if (ratioPercent >= 100) return new Set(available.map((s) => s.index));
  if (available.length === 0) return new Set();
  const target = Math.max(1, Math.round((available.length * ratioPercent) / 100));
  const step = available.length / target;
  const picks = new Set<number>();
  for (let i = 0; picks.size < target && i < available.length; i++) {
    const idx = Math.floor(i * step);
    if (available[idx]) {
      picks.add(available[idx].index);
    }
  }
  return picks;
}

// ── 1. Keyword Extraction (visualPromptToQuery) ─────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "up", "down", "into", "over", "after",
  "slow", "pan", "zoom", "drift", "parallax", "cinematic", "photoreal", "photographic", "high", "low", "angle", "wide", "close", "shot",
  "realism", "camera", "motion", "style", "viewed", "through", "lens", "astronomy", "abstract", "concept", "conceptual", "symbolic",
  "channel", "focused", "important", "every", "scene", "must", "be", "genre", "very", "extremely", "highly", "ultra", "super",
  "frame", "example", "subtle", "gentle", "natural", "ambient", "movement", "no", "yes", "showing", "depicting", "featuring",
  "cartoon", "stylization", "jarring", "cuts", "looks", "like", "moving", "photograph", "dramatic", "lighting", "aspect", "sharp",
  "documentary", "photography", "grounded", "nasa", "esa", "mission", "imagery", "4k", "8k", "hd", "video", "footage", "background",
  "detail", "color", "grading", "focus", "atmosphere", "mood", "feeling", "vibe", "aesthetic", "digital", "virtual",
  "overlays", "watermarks", "logos", "humans", "people", "figures", "faces", "astronauts",
]);

/**
 * Converts a detailed visual prompt sentence into clean keywords for stock search engines.
 * Strips punctuation and stop symbols, trimming to ~maxKeywords concise keywords focused on the subject.
 */
export function visualPromptToQuery(prompt: string, maxKeywords = 18): string {
  const words = prompt
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase().trim())
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  const unique = Array.from(new Set(words));
  return unique.slice(0, maxKeywords).join(" ");
}

/**
 * Extracts clean search queries from a scene for stock video API lookups.
 */
function getSearchQueries(scene: Scene): string[] {
  const kwQuery = scene.search_keywords ? visualPromptToQuery(scene.search_keywords, 8) : "";
  const visualQuery = visualPromptToQuery(scene.visual_prompt || "", 12);

  const queries: string[] = [];
  if (kwQuery) queries.push(kwQuery);
  if (visualQuery && !queries.includes(visualQuery)) queries.push(visualQuery);

  // Add shorter 3-keyword focal query for broad matching
  const shortWords = visualPromptToQuery(scene.visual_prompt || "", 4);
  if (shortWords && !queries.includes(shortWords)) queries.push(shortWords);

  return queries.length > 0 ? queries : ["nature landscape"];
}

/**
 * Maps IMAGE_RATIO (e.g. "16:9") to stock video orientation keyword ("landscape", "portrait", "square").
 */
function getOrientation(ratio: string): "landscape" | "portrait" | "square" {
  if (ratio === "9:16" || ratio === "3:4" || ratio === "2:3") return "portrait";
  if (ratio === "1:1") return "square";
  return "landscape";
}

// ── 2. Technical Filtering & Deduplication ──────────────────────────────────

const usedClipIds = new Set<string>();

/** Clear deduplication set at start of a run if needed. */
export function clearUsedStockIds(): void {
  usedClipIds.clear();
}

export interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

/**
 * Inspects all MP4 renditions of a candidate clip and selects the cleanest resolution
 * up to maxHeight (usually 1080p) so videos don't look blurry or unnecessarily heavy.
 */
export function pickBestVideoFile(files: PexelsVideoFile[] | undefined, maxHeight = 1080): PexelsVideoFile | null {
  if (!files || files.length === 0) return null;
  const mp4s = files.filter((f) => f.file_type === "video/mp4" && f.link && f.height > 0);
  if (mp4s.length === 0) return null;

  // Prefer HD renditions up to maxHeight (e.g. <= 1080p), highest resolution first
  const valid = mp4s.filter((f) => f.height <= maxHeight);
  if (valid.length > 0) {
    valid.sort((a, b) => b.height - a.height);
    return valid[0];
  }
  // If all exceed maxHeight, pick the smallest one available
  mp4s.sort((a, b) => a.height - b.height);
  return mp4s[0];
}

export interface CandidateClip {
  id: string;
  provider: "pexels" | "pixabay";
  durationSec: number;
  width: number;
  height: number;
  downloadUrl: string;
  description: string;
  score?: number;
}

interface PexelsResponse {
  videos?: {
    id: number;
    duration: number;
    url?: string;
    video_files?: PexelsVideoFile[];
  }[];
}

async function searchPexelsCandidates(apiKey: string, query: string, orientation: string, minDurationSec: number): Promise<CandidateClip[]> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=15&orientation=${orientation}`;
  const resp = await fetch(url, { headers: { Authorization: apiKey } });
  if (!resp.ok) return [];
  const data = (await resp.json()) as PexelsResponse;
  if (!data.videos || data.videos.length === 0) return [];

  const candidates: CandidateClip[] = [];
  for (const vid of data.videos) {
    const clipId = `pexels_${vid.id}`;
    if (usedClipIds.has(clipId)) continue;
    if (vid.duration < minDurationSec) continue;

    const bestFile = pickBestVideoFile(vid.video_files, 1080);
    if (!bestFile) continue;

    candidates.push({
      id: clipId,
      provider: "pexels",
      durationSec: vid.duration,
      width: bestFile.width,
      height: bestFile.height,
      downloadUrl: bestFile.link,
      description: vid.url ? `${query} (${vid.url.split("/").filter(Boolean).pop() || "stock"})` : query,
    });
  }
  return candidates;
}

interface PixabayVideoVariant {
  url: string;
  width: number;
  height: number;
}

interface PixabayResponse {
  hits?: {
    id: number;
    duration: number;
    tags?: string;
    videos?: {
      large?: PixabayVideoVariant;
      medium?: PixabayVideoVariant;
      small?: PixabayVideoVariant;
      tiny?: PixabayVideoVariant;
    };
  }[];
}

async function searchPixabayCandidates(apiKey: string, query: string, minDurationSec: number): Promise<CandidateClip[]> {
  const url = `https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=15&video_type=film`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const data = (await resp.json()) as PixabayResponse;
  if (!data.hits || data.hits.length === 0) return [];

  const candidates: CandidateClip[] = [];
  for (const hit of data.hits) {
    const clipId = `pixabay_${hit.id}`;
    if (usedClipIds.has(clipId)) continue;
    if (hit.duration < minDurationSec) continue;

    if (!hit.videos) continue;
    const variants = [hit.videos.medium, hit.videos.large, hit.videos.small].filter(
      (v): v is PixabayVideoVariant => Boolean(v && v.url && v.height <= 1080)
    );
    const best = variants[0] || hit.videos.medium || hit.videos.large || hit.videos.small;
    if (!best || !best.url) continue;

    candidates.push({
      id: clipId,
      provider: "pixabay",
      durationSec: hit.duration,
      width: best.width,
      height: best.height,
      downloadUrl: best.url,
      description: hit.tags || query,
    });
  }
  return candidates;
}

// ── 3. AI Relevance Gating (gateByRelevance) ────────────────────────────────

/**
 * AI Relevance Gate using Gemini:
 * Scores each candidate clip 0 to 100 on visual accuracy against the scene description.
 * Sorts candidates descending by relevance score and filters out any below REAL_MATCH_THRESHOLD.
 */
export async function gateByRelevance(
  runId: string,
  scenePrompt: string,
  candidates: CandidateClip[],
  thresholdStr?: string
): Promise<CandidateClip[]> {
  if (candidates.length === 0) return [];
  const threshold = Number(thresholdStr ?? getSetting("REAL_MATCH_THRESHOLD") ?? "65");
  if (threshold <= 0 || isNaN(threshold)) {
    return candidates;
  }

  const apiKey = getSetting("GOOGLE_API_KEY");
  if (!apiKey) {
    return candidates;
  }

  try {
    const model = getSetting("SCENE_SPLIT_MODEL") || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const candidateSummary = candidates
      .map((c, idx) => `[${idx}] ID: ${c.id} | Description/Tags: ${c.description} | Duration: ${c.durationSec}s`)
      .join("\n");

    const promptText = `You are a documentary film editor evaluating stock footage candidates for a scene.
Scene Visual Prompt: "${scenePrompt}"

Candidate Stock Video Clips:
${candidateSummary}

Score each candidate from 0 to 100 based on how well its visual description matches the scene prompt.
Return ONLY a valid JSON array of objects with keys "index" (number) and "score" (number 0-100). Example:
[{"index": 0, "score": 85}, {"index": 1, "score": 40}]`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    });

    if (!resp.ok) {
      log(runId, "warn", `AI Relevance Gating API returned status ${resp.status} — using technical candidate ranking`, { stage: "animate" });
      return candidates;
    }

    const data = (await resp.json()) as any;
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOut) return candidates;

    const scores = JSON.parse(textOut) as { index: number; score: number }[];
    const scoreMap = new Map<number, number>();
    for (const item of scores) {
      if (typeof item.index === "number" && typeof item.score === "number") {
        scoreMap.set(item.index, item.score);
      }
    }

    for (let i = 0; i < candidates.length; i++) {
      candidates[i].score = scoreMap.get(i) ?? 50;
    }

    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const passed = candidates.filter((c) => (c.score ?? 0) >= threshold);

    if (passed.length > 0) {
      log(
        runId,
        "info",
        `AI Relevance Gate selected top clip '${passed[0].id}' (Score: ${passed[0].score}/100, threshold: ${threshold}) out of ${candidates.length} candidates`,
        { stage: "animate" }
      );
      return passed;
    }

    log(
      runId,
      "warn",
      `AI Relevance Gate: no stock clip met threshold ${threshold} (best score: ${candidates[0]?.score ?? 0}/100) — falling back to AI generation`,
      { stage: "animate" }
    );
    return [];
  } catch (err) {
    log(runId, "warn", `AI Relevance Gating failed (${err instanceof Error ? err.message : String(err)}) — falling back to top technical candidate`, { stage: "animate" });
    return candidates;
  }
}

async function downloadFile(url: string, outPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to download clip from ${url} (status ${resp.status})`);
  }
  const buffer = await resp.arrayBuffer();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(buffer));
}

/**
 * Searches, filters, AI-relevance-gates, and downloads stock video from Pexels or Pixabay.
 * Returns the local file path if successful, or null if no match / failure (graceful fallback).
 */
export async function fetchStockVideo(
  runId: string,
  scene: Scene,
  outPath: string
): Promise<string | null> {
  checkCancelled(runId);
  const provider = (getSetting("STOCK_FOOTAGE_PROVIDER") || "all").toLowerCase();
  if (provider === "off") return null;

  const pexelsKey = getSetting("PEXELS_API_KEY");
  const pixabayKey = getSetting("PIXABAY_API_KEY");

  if (!pexelsKey && !pixabayKey) {
    log(runId, "warn", "Stock footage requested but neither PEXELS_API_KEY nor PIXABAY_API_KEY is set in Settings — falling back to AI generation", { stage: "animate" });
    return null;
  }

  const queries = getSearchQueries(scene);
  const ratio = getSetting("IMAGE_RATIO") || "16:9";
  const orientation = getOrientation(ratio);
  const minDurationSec = scene.duration_hint_sec || 4;

  log(runId, "info", `Searching stock footage for scene #${scene.index} [queries: ${queries.map(q => `'${q}'`).join(", ")}]...`, { stage: "animate" });

  const allCandidates: CandidateClip[] = [];

  for (const query of queries) {
    checkCancelled(runId);
    if (provider === "pexels" || provider === "all") {
      if (pexelsKey) {
        const pexelsRes = await searchPexelsCandidates(pexelsKey, query, orientation, minDurationSec);
        allCandidates.push(...pexelsRes);
      }
    }
    if (provider === "pixabay" || provider === "all") {
      if (pixabayKey) {
        const pixabayRes = await searchPixabayCandidates(pixabayKey, query, minDurationSec);
        allCandidates.push(...pixabayRes);
      }
    }
    if (allCandidates.length >= 5) break;
  }

  if (allCandidates.length === 0) {
    log(runId, "warn", `No stock footage candidate met technical criteria (minDuration >= ${minDurationSec}s, orientation '${orientation}') for queries [${queries.join(", ")}] — falling back to AI generation for scene #${scene.index}`, { stage: "animate" });
    return null;
  }

  // AI Relevance Gating
  const gated = await gateByRelevance(runId, scene.visual_prompt || "", allCandidates);
  if (gated.length === 0) {
    return null;
  }

  const bestClip = gated[0];
  try {
    checkCancelled(runId);
    await downloadFile(bestClip.downloadUrl, outPath);
    usedClipIds.add(bestClip.id);
    log(runId, "success", `Stock footage (${bestClip.provider}) downloaded for scene #${scene.index} [id: ${bestClip.id}, duration: ${bestClip.durationSec}s]`, { stage: "animate" });
    return outPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(runId, "warn", `Stock footage download failed for scene #${scene.index} (${bestClip.provider} ${bestClip.id}): ${msg.slice(0, 100)}`, { stage: "animate" });
    return null;
  }
}
