import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { type Scene } from "./scene-split";

/**
 * Selects scene indices that should use real stock footage based on the configured ratio percentage.
 */
export function pickScenesForStock(scenes: Scene[], ratioPercent: number): Set<number> {
  if (ratioPercent >= 100) return new Set(scenes.map((s) => s.index));
  if (ratioPercent <= 0) return new Set();
  const target = Math.max(1, Math.round((scenes.length * ratioPercent) / 100));
  const step = scenes.length / target;
  const picks = new Set<number>();
  for (let i = 0; picks.size < target && i < scenes.length; i++) {
    picks.add(Math.floor(i * step));
  }
  return picks;
}

/**
 * Extracts clean, multi-tier search queries from a scene for stock video API queries.
 */
function getSearchQueries(scene: Scene): string[] {
  const stopWords = new Set([
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

  function cleanString(str: string): string[] {
    return str
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length > 2 && !stopWords.has(w));
  }

  const queries: string[] = [];

  if (scene.search_keywords && scene.search_keywords.trim().length > 0) {
    const kwWords = cleanString(scene.search_keywords);
    if (kwWords.length > 0) {
      queries.push(kwWords.slice(0, 3).join(" "));
      if (kwWords.length >= 2) {
        const q2 = kwWords.slice(0, 2).join(" ");
        if (!queries.includes(q2)) queries.push(q2);
      }
      if (!queries.includes(kwWords[0])) queries.push(kwWords[0]);
    }
  }

  const vpWords = cleanString(scene.visual_prompt);
  if (vpWords.length > 0) {
    const q3 = vpWords.slice(0, 3).join(" ");
    if (!queries.includes(q3)) queries.push(q3);
    if (vpWords.length >= 2) {
      const q2 = vpWords.slice(0, 2).join(" ");
      if (!queries.includes(q2)) queries.push(q2);
    }
  }

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

interface PexelsVideoFile {
  id: number;
  quality: string;
  file_type: string;
  width: number;
  height: number;
  link: string;
}

interface PexelsResponse {
  videos?: {
    id: number;
    duration: number;
    video_files?: PexelsVideoFile[];
  }[];
}

async function searchPexels(apiKey: string, query: string, orientation: string): Promise<string | null> {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=${orientation}`;
  const resp = await fetch(url, {
    headers: { Authorization: apiKey },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as PexelsResponse;
  if (!data.videos || data.videos.length === 0) return null;

  for (const vid of data.videos) {
    if (!vid.video_files || vid.video_files.length === 0) continue;
    // Prefer HD mp4
    const mp4s = vid.video_files.filter((f) => f.file_type === "video/mp4" && f.link);
    if (mp4s.length === 0) continue;
    const hd = mp4s.find((f) => f.quality === "hd" || (f.width >= 1280 && f.width <= 1920));
    if (hd) return hd.link;
    return mp4s[0].link;
  }
  return null;
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
    videos?: {
      large?: PixabayVideoVariant;
      medium?: PixabayVideoVariant;
      small?: PixabayVideoVariant;
      tiny?: PixabayVideoVariant;
    };
  }[];
}

async function searchPixabay(apiKey: string, query: string): Promise<string | null> {
  const url = `https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=5&video_type=film`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = (await resp.json()) as PixabayResponse;
  if (!data.hits || data.hits.length === 0) return null;

  for (const hit of data.hits) {
    if (!hit.videos) continue;
    const best = hit.videos.medium || hit.videos.large || hit.videos.small;
    if (best && best.url) return best.url;
  }
  return null;
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
 * Searches and downloads stock video from Pexels or Pixabay.
 * Returns the local file path if successful, or null if no match / failure (graceful fallback).
 */
export async function fetchStockVideo(
  runId: string,
  scene: Scene,
  outPath: string
): Promise<string | null> {
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

  log(runId, "info", `Searching stock footage for scene #${scene.index} [queries: ${queries.map(q => `'${q}'`).join(", ")}]...`, { stage: "animate" });

  const tryPexels = async (query: string): Promise<string | null> => {
    if (!pexelsKey) return null;
    try {
      const link = await searchPexels(pexelsKey, query, orientation);
      if (link) {
        await downloadFile(link, outPath);
        log(runId, "success", `Stock footage (Pexels) downloaded for scene #${scene.index} [query: '${query}']`, { stage: "animate" });
        return outPath;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(runId, "warn", `Pexels download failed for scene #${scene.index} [query: '${query}'] (${msg.slice(0, 100)})`, { stage: "animate" });
    }
    return null;
  };

  const tryPixabay = async (query: string): Promise<string | null> => {
    if (!pixabayKey) return null;
    try {
      const link = await searchPixabay(pixabayKey, query);
      if (link) {
        await downloadFile(link, outPath);
        log(runId, "success", `Stock footage (Pixabay) downloaded for scene #${scene.index} [query: '${query}']`, { stage: "animate" });
        return outPath;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(runId, "warn", `Pixabay download failed for scene #${scene.index} [query: '${query}'] (${msg.slice(0, 100)})`, { stage: "animate" });
    }
    return null;
  };

  for (const query of queries) {
    let result: string | null = null;
    if (provider === "pexels") {
      result = await tryPexels(query);
    } else if (provider === "pixabay") {
      result = await tryPixabay(query);
    } else {
      if (scene.index % 2 === 0) {
        result = (await tryPexels(query)) || (await tryPixabay(query));
      } else {
        result = (await tryPixabay(query)) || (await tryPexels(query));
      }
    }
    if (result) return result;
  }

  log(runId, "warn", `No stock footage match found for queries [${queries.join(", ")}] — falling back to AI generation for scene #${scene.index}`, { stage: "animate" });
  return null;
}
