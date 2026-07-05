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
 * Extracts clean search keywords from a scene for stock video API queries.
 */
function getCleanKeywords(scene: Scene): string {
  if (scene.search_keywords && scene.search_keywords.trim().length > 0) {
    return scene.search_keywords.trim();
  }
  // Strip common cinematic / instruction stop words
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "with", "by",
    "slow", "pan", "zoom", "drift", "parallax", "cinematic", "photoreal", "photographic",
    "realism", "camera", "motion", "style", "viewed", "through", "lens", "astronomy",
    "channel", "focused", "important", "every", "scene", "must", "be", "genre",
    "frame", "example", "subtle", "gentle", "natural", "ambient", "movement", "no",
    "cartoon", "stylization", "jarring", "cuts", "looks", "like", "moving", "photograph",
    "documentary", "photography", "grounded", "nasa", "esa", "mission", "imagery",
    "detail", "color", "grading", "dramatic", "lighting", "aspect", "sharp", "focus",
    "overlays", "watermarks", "logos", "humans", "people", "figures", "faces", "astronauts",
  ]);

  const words = scene.visual_prompt
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Return top 3-4 distinct descriptive keywords
  const distinct = Array.from(new Set(words));
  return distinct.slice(0, 4).join(" ") || "space astronomy galaxy";
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

  const query = getCleanKeywords(scene);
  const ratio = getSetting("IMAGE_RATIO") || "16:9";
  const orientation = getOrientation(ratio);

  log(runId, "info", `Searching stock footage for scene #${scene.index} [query: '${query}']...`, { stage: "animate" });

  const tryPexels = async (): Promise<string | null> => {
    if (!pexelsKey) return null;
    try {
      const link = await searchPexels(pexelsKey, query, orientation);
      if (link) {
        await downloadFile(link, outPath);
        log(runId, "success", `Stock footage (Pexels) downloaded for scene #${scene.index}`, { stage: "animate" });
        return outPath;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(runId, "warn", `Pexels download failed for scene #${scene.index} (${msg.slice(0, 100)})`, { stage: "animate" });
    }
    return null;
  };

  const tryPixabay = async (): Promise<string | null> => {
    if (!pixabayKey) return null;
    try {
      const link = await searchPixabay(pixabayKey, query);
      if (link) {
        await downloadFile(link, outPath);
        log(runId, "success", `Stock footage (Pixabay) downloaded for scene #${scene.index}`, { stage: "animate" });
        return outPath;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(runId, "warn", `Pixabay download failed for scene #${scene.index} (${msg.slice(0, 100)})`, { stage: "animate" });
    }
    return null;
  };

  let result: string | null = null;
  if (provider === "pexels") {
    result = await tryPexels();
  } else if (provider === "pixabay") {
    result = await tryPixabay();
  } else {
    // "all": Round-robin alternate which service we search first based on scene index
    if (scene.index % 2 === 0) {
      result = (await tryPexels()) || (await tryPixabay());
    } else {
      result = (await tryPixabay()) || (await tryPexels());
    }
  }

  if (!result) {
    log(runId, "warn", `No stock footage match found for query '${query}' — falling back to AI generation for scene #${scene.index}`, { stage: "animate" });
  }

  return result;
}
