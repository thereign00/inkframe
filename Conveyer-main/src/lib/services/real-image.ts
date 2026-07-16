import fs from "node:fs";
import path from "node:path";
import { log } from "@/lib/logger";
import { getSetting, getRunDirectorNotes } from "@/lib/settings";
import type { Scene } from "./scene-split";

// In-memory set of used image URLs per run to guarantee no duplicate photos across scenes
const usedRealImageUrls = new Set<string>();

export function clearUsedRealImages(): void {
  usedRealImageUrls.clear();
}

/**
 * Strips stop words and converts a verbose scene prompt into concise factual search terms.
 */
function visualPromptToRealImageQuery(prompt: string): string[] {
  const clean = prompt
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stopWords = new Set([
    "a", "an", "the", "in", "on", "at", "by", "for", "with", "about", "against",
    "between", "into", "through", "during", "before", "after", "above", "below",
    "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why", "how",
    "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can",
    "will", "just", "should", "now", "close", "up", "shot", "wide", "camera", "angle",
    "cinematic", "lighting", "hyper", "realistic", "4k", "8k", "photo", "photograph",
    "image", "showing", "depicting", "illustration", "animated", "video",
  ]);

  const words = clean.split(" ").filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase()));

  // Extract entities / proper nouns / key space & science terms
  const entityRegex = /NASA|Hubble|Webb|JWST|Cassini|Apollo|Saturn|Mars|Jupiter|Galaxy|Nebula|Telescope|Planet|Orbit|Observatory|Astronaut|Spacecraft|Rover|Voyager|Black Hole|Supernova|Milky Way|Comet|Asteroid|Einstein|Newton|Galileo|Curiosity|Perseverance|\b[A-Z][a-zA-Z0-9_-]+\b/ig;
  const entities = (clean.match(entityRegex) || []).slice(0, 3);

  const queries = new Set<string>();
  if (entities.length > 1) queries.add(entities.join(" "));
  if (entities.length > 0) entities.forEach((e) => queries.add(e));
  if (words.length >= 4) queries.add(words.slice(0, 4).join(" "));
  if (words.length >= 3) queries.add(words.slice(0, 3).join(" "));
  if (words.length >= 2) queries.add(words.slice(0, 2).join(" "));
  if (words.length >= 1) queries.add(words[0]);

  return Array.from(queries).filter(Boolean);
}

interface CandidateImage {
  url: string;
  title: string;
  source: string;
  domain?: string;
  sourceUrl?: string;
  authorityScore?: number;
  motionType?: "zoom-in" | "zoom-out" | "slide-up" | "slide-down" | "slide-left" | "slide-right";
}

/**
 * Search NASA Open Image Library API (https://images-api.nasa.gov)
 */
async function searchNasaImages(query: string): Promise<CandidateImage[]> {
  try {
    const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=image`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Inkframe-App/1.0 (contact@inkframe.app)" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data?.collection?.items || [];

    const candidates: CandidateImage[] = [];
    for (const item of items) {
      const links = item.links || [];
      const dataArr = item.data || [];
      const title = dataArr[0]?.title || "NASA Image";

      for (const link of links) {
        if (link.rel === "preview" && link.href && typeof link.href === "string") {
          const imgUrl = link.href.replace("~thumb.jpg", "~orig.jpg").replace("~thumb.png", "~orig.png");
          if (!usedRealImageUrls.has(imgUrl) && !imgUrl.endsWith(".svg")) {
            candidates.push({ url: imgUrl, title, source: "NASA", authorityScore: 100 });
          }
        }
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

/**
 * Search Wikimedia Commons & Wikipedia REST APIs
 */
async function searchWikimediaImages(query: string): Promise<CandidateImage[]> {
  const candidates: CandidateImage[] = [];
  try {
    const headers = { "User-Agent": "Inkframe-App/1.0 (contact@inkframe.app)" };
    const [wikiRes, commonsRes] = await Promise.all([
      fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=8&prop=pageimages&piprop=original&format=json`, { headers }).catch(() => null),
      fetch(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url&format=json`, { headers }).catch(() => null),
    ]);

    if (wikiRes && wikiRes.ok) {
      const data = await wikiRes.json();
      const pages = data?.query?.pages;
      if (pages) {
        for (const pageId of Object.keys(pages)) {
          const page = pages[pageId];
          const origUrl = page?.original?.source;
          const title = page?.title || "Wikimedia Image";
          if (origUrl && typeof origUrl === "string") {
            const lower = origUrl.toLowerCase();
            if ((lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")) && !usedRealImageUrls.has(origUrl)) {
              candidates.push({ url: origUrl, title, source: "Wikimedia", authorityScore: 90 });
            }
          }
        }
      }
    }

    if (commonsRes && commonsRes.ok) {
      const data = await commonsRes.json();
      const pages = data?.query?.pages;
      if (pages) {
        for (const pageId of Object.keys(pages)) {
          const page = pages[pageId];
          const imgUrl = page?.imageinfo?.[0]?.url;
          const title = page?.title || "Commons Image";
          if (imgUrl && typeof imgUrl === "string") {
            const lower = imgUrl.toLowerCase();
            if ((lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")) && !usedRealImageUrls.has(imgUrl)) {
              candidates.push({ url: imgUrl, title, source: "Wikimedia", authorityScore: 90 });
            }
          }
        }
      }
    }
  } catch {}
  return candidates;
}

function calculateDomainAuthority(urlStr: string): number {
  try {
    const domain = new URL(urlStr).hostname.toLowerCase().replace("www.", "");
    if (/\.(gov|edu|mil)$/.test(domain)) return 95;
    if (/nasa\.gov|esa\.int|hubblesite\.org|webbtelescope\.org|jpl\.nasa\.gov|eso\.org|noirlab\.edu/.test(domain)) return 100;
    if (/wikipedia\.org|wikimedia\.org|archive\.org|britannica\.com|smithsonianmag\.com|nature\.com|nationalgeographic\.com/.test(domain)) return 90;
    if (/bbc\.co\.uk|bbc\.com|nytimes\.com|reuters\.com|apnews\.com|space\.com|universetoday\.com|sciencedaily\.com/.test(domain)) return 80;
    if (/pinterest|shutterstock|istock|gettyimages|stock|instagram|facebook|tiktok|reddit/.test(domain)) return 5;
    return 60;
  } catch {
    return 50;
  }
}

/**
 * Search live Web archives & authority domains directly across multiple independent sources
 */
async function searchWebImages(query: string): Promise<CandidateImage[]> {
  const candidates: CandidateImage[] = [];
  const seenUrls = new Set<string>();

  const processBingHtml = (html: string) => {
    const regex = /m='(\{.*?\})'/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      try {
        const item = JSON.parse(match[1]);
        const imgUrl = item.murl;
        const sourceUrl = item.purl || imgUrl;
        const title = item.desc || query;
        if (!imgUrl || typeof imgUrl !== "string") continue;
        const lower = imgUrl.toLowerCase();
        if (!(lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png"))) continue;
        if (usedRealImageUrls.has(imgUrl) || seenUrls.has(imgUrl)) continue;

        const authScore = calculateDomainAuthority(sourceUrl);
        if (authScore < 30) continue; // Instantly filter out low-authority / stock / pinterest sources

        let domain = "Web";
        try { domain = new URL(sourceUrl).hostname.replace("www.", ""); } catch {}

        seenUrls.add(imgUrl);
        candidates.push({
          url: imgUrl,
          title: cleanRealImageTitle(title, query),
          source: domain,
          domain,
          sourceUrl,
          authorityScore: authScore,
        });
        if (candidates.length >= 15) break;
      } catch {}
    }
  };

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    };

    // 1. Run top-ranking authority domain search & general web image search in parallel
    const authorityQuery = `${query} (site:nasa.gov OR site:esa.int OR site:wikipedia.org OR site:space.com OR site:nature.com OR site:bbc.co.uk OR site:scientificamerican.com OR site:jpl.nasa.gov OR site:hubblesite.org OR site:webbtelescope.org)`;
    const generalQuery = `${query} authentic real photograph -site:pinterest.com -site:shutterstock.com -site:stock.adobe.com`;

    const [authRes, genRes, ddgRes] = await Promise.all([
      fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(authorityQuery)}&form=HDRSC2`, { headers }).catch(() => null),
      fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(generalQuery)}&form=HDRSC2`, { headers }).catch(() => null),
      (async () => {
        try {
          const r1 = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { headers });
          if (!r1.ok) return null;
          const txt = await r1.text();
          const match = /vqd='([^']+)'/.exec(txt) || /vqd="([^"]+)"/.exec(txt) || /vqd=([0-9-]+)/.exec(txt);
          if (!match) return null;
          const vqd = match[1];
          const r2 = await fetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`, { headers });
          if (!r2.ok) return null;
          return await r2.json();
        } catch { return null; }
      })()
    ]);

    if (authRes && authRes.ok) processBingHtml(await authRes.text());
    if (genRes && genRes.ok) processBingHtml(await genRes.text());

    if (ddgRes && Array.isArray((ddgRes as any).results)) {
      for (const item of (ddgRes as any).results) {
        try {
          const imgUrl = item.image;
          const sourceUrl = item.url || imgUrl;
          const title = item.title || query;
          if (!imgUrl || typeof imgUrl !== "string") continue;
          const lower = imgUrl.toLowerCase();
          if (!(lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png"))) continue;
          if (usedRealImageUrls.has(imgUrl) || seenUrls.has(imgUrl)) continue;

          const authScore = calculateDomainAuthority(sourceUrl);
          if (authScore < 30) continue;

          let domain = "DuckDuckGo";
          try { domain = new URL(sourceUrl).hostname.replace("www.", ""); } catch {}

          seenUrls.add(imgUrl);
          candidates.push({
            url: imgUrl,
            title: cleanRealImageTitle(title, query),
            source: domain,
            domain,
            sourceUrl,
            authorityScore: authScore,
          });
          if (candidates.length >= 20) break;
        } catch {}
      }
    }
  } catch {}
  return candidates;
}

/**
 * Download image file to disk
 */
async function downloadRealImageFile(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Inkframe-App/1.0 (Desktop Science Video Engine)" },
    });
    if (!res.ok) return false;
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length < 5000) return false; // Ignore corrupted or tiny placeholder files

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Normalize and downscale archival image using sharp to prevent FFmpeg out-of-memory or MJPEG packet overflow on 100MB+ scans!
    try {
      const sharp = (await import("sharp")).default;
      const cleanBuffer = await sharp(buffer, { limitInputPixels: false })
        .resize({ width: 3840, height: 2160, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
      fs.writeFileSync(destPath, cleanBuffer);
      return true;
    } catch {
      // If sharp fails (e.g. unsupported raw format or extremely huge scan), only write raw if < 15MB
      if (buffer.length > 15 * 1024 * 1024) return false;
      fs.writeFileSync(destPath, buffer);
      return true;
    }
  } catch {
    return false;
  }
}

function cleanRealImageTitle(rawTitle: string, fallbackQuery: string): string {
  let clean = rawTitle
    .replace(/^File:/i, "")
    .replace(/\.[a-zA-Z0-9]{3,4}$/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b(PIA\d+|AS\d+|NH\d+)\b/ig, "")
    .trim();

  // If the title is a question or has a question mark ("What on Mars is a High Thermal-Inertia Surface?")
  // clean out the question wording to get the clean object name
  if (clean.includes("?") || /^What on|^How does|^Why is|^Where is|^Who is/i.test(clean)) {
    let stripped = clean
      .replace(/^What on /i, "")
      .replace(/^How does /i, "")
      .replace(/^Why is /i, "")
      .replace(/^Where is /i, "")
      .replace(/\bis a\b/i, "")
      .replace(/[?]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (stripped.length > 5) {
      clean = stripped;
    } else if (fallbackQuery) {
      clean = fallbackQuery;
    }
  }

  clean = clean.replace(/\s+/g, " ").trim();
  if (!clean || clean.toLowerCase() === "nasa image" || clean.toLowerCase() === "wikimedia image") {
    clean = fallbackQuery || "Factual Space Archive";
  }

  // Keep it concise and clean (~34 chars max) so it fits elegantly in the badge without crowding
  if (clean.length > 34) {
    const words = clean.split(" ");
    let short = "";
    for (const w of words) {
      if ((short + " " + w).trim().length <= 34) {
        short = (short + " " + w).trim();
      } else {
        break;
      }
    }
    clean = short || clean.slice(0, 34).trim();
  }

  return clean;
}

export function deriveMotionFromText(text: string): "zoom-in" | "zoom-out" | "slide-up" | "slide-down" | "slide-left" | "slide-right" {
  const t = text.toLowerCase();
  if (/rocket|launch|tower|cliff|vertical|tall|ascend|upward|pillar|column|shuttle/i.test(t)) return "slide-up";
  if (/descend|fall|drop|landing|crater bottom|canyon/i.test(t)) return "slide-down";
  if (/panorama|horizon|landscape|surface|crater|expanse|wide|field|terrain|view across/i.test(t)) return "slide-right";
  if (/planet|nebula|galaxy|star|close-up|portrait|detail|black hole|sun|moon|sphere/i.test(t)) return "zoom-in";
  const options: ("zoom-in" | "zoom-out" | "slide-up" | "slide-down" | "slide-left" | "slide-right")[] = [
    "zoom-in", "zoom-out", "slide-up", "slide-down", "slide-left", "slide-right"
  ];
  return options[Math.floor(Math.random() * options.length)];
}

async function scoreRealImageCandidates(
  runId: string,
  scene: Scene,
  candidates: CandidateImage[]
): Promise<CandidateImage[]> {
  if (candidates.length <= 1) return candidates;
  const apiKey = getSetting("GOOGLE_API_KEY") || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return candidates;

  try {
    const listText = candidates
      .slice(0, 10)
      .map((c, idx) => `ID ${idx}: [${c.source}] Domain: ${c.domain || c.source} (Authority: ${c.authorityScore || 90}/100) | Title: "${c.title}" | URL: ${c.url}`)
      .join("\n");

    const runNotes = getRunDirectorNotes(runId);
    const notesText = runNotes ? `\nVideo-Specific Director Notes: "${runNotes}"\n` : "";

    const prompt = `You are a documentary visual researcher selecting the most authentic and contextually accurate real photograph for a video scene.

Scene Narration Spoken Audio: "${scene.text}"
Scene Visual Description: "${scene.visual_prompt}"${notesText}
Available Candidate Real Photographs found from NASA, Wikimedia, and Verified Web Sources:
${listText}

CRITICAL RULES:
1. Score each candidate from 0 to 100 based on exact semantic relevance, domain authority (prefer .gov, .edu, NASA, ESA, Nature, BBC over generic blogs), and physical accuracy.
2. For example: if the narration talks about the Perseverance rover sitting ON MARS in Jezero crater, rank photos of the rover actually on Mars (or Martian surface terrain) HIGH (90-100). If a candidate photo shows technicians building the rover in a clean room on Earth, rank it VERY LOW (0-20) UNLESS the narration specifically discusses assembling or building the rover on Earth!
3. If Director Notes specify a preferred style, focus, or subject preference, prioritize candidates matching those notes.
4. If a photo is irrelevant, low authority, or shows an out-of-context location/object, rank it 0-20.
5. Also suggest the ideal camera motion ("zoom-in", "zoom-out", "slide-up", "slide-down", "slide-left", or "slide-right") based on whether the image shows a vertical structure, wide panorama, close-up planet/galaxy, etc.

Return ONLY a valid JSON array of objects sorted from highest score to lowest, with keys:
- "id": number (the candidate ID 0 to ${Math.min(candidates.length, 10) - 1})
- "score": number (0 to 100)
- "motion": string ("zoom-in", "zoom-out", "slide-up", "slide-down", "slide-left", or "slide-right")
- "reason": brief 1-sentence explanation`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 2000,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!resp.ok) return candidates;
    const json = (await resp.json()) as any;
    const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    if (!text) return candidates;

    const cleanJson = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleanJson) as Array<{ id: number; score: number; motion?: string; reason?: string }>;
    if (!Array.isArray(parsed) || parsed.length === 0) return candidates;

    const scoredList: { cand: CandidateImage; score: number }[] = [];
    for (const item of parsed) {
      if (typeof item.id === "number" && candidates[item.id] && typeof item.score === "number") {
        const cand = { ...candidates[item.id] };
        if (item.motion && ["zoom-in", "zoom-out", "slide-up", "slide-down", "slide-left", "slide-right"].includes(item.motion)) {
          cand.motionType = item.motion as any;
        }
        scoredList.push({ cand, score: item.score });
      }
    }

    if (scoredList.length > 0) {
      scoredList.sort((a, b) => b.score - a.score);
      const topPick = scoredList[0];
      log(
        runId,
        "info",
        `🤖 Gemini Scored Real Image candidates for Scene #${scene.index}: Best match "${topPick.cand.title.slice(0, 55)}" (${topPick.cand.source}, Authority: ${topPick.cand.authorityScore || 90}, Score: ${topPick.score}/100, Motion: ${topPick.cand.motionType || "auto"})`,
        { stage: "real-image" }
      );
      // ONLY keep candidates that Gemini scores >= 45/100. Never attempt 0/100 or low-relevance junk candidates!
      const goodMatches = scoredList.filter(s => s.score >= 45).map(s => s.cand);
      if (goodMatches.length === 0) {
        log(
          runId,
          "warn",
          `⚠ All candidate images for Scene #${scene.index} scored below 45/100 (top match was ${topPick.score}/100). Rejecting candidates so pipeline searches next tier.`,
          { stage: "real-image" }
        );
      }
      return goodMatches;
    }
  } catch {
    // If Gemini candidate scoring encounters any network/parsing blip, fall back cleanly to original ordering
  }
  return candidates;
}

async function verifyRealImageWithGeminiVision(
  runId: string,
  scene: Scene,
  filePath: string,
  cand: CandidateImage
): Promise<boolean> {
  const apiKey = getSetting("GOOGLE_API_KEY") || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return true; // Trust authority and text scoring if API key not available

  try {
    const fileBuffer = fs.readFileSync(filePath);
    if (fileBuffer.length < 5000) return false;
    const base64Data = fileBuffer.toString("base64");
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : "image/jpeg";
    const runNotes = getRunDirectorNotes(runId);
    const notesText = runNotes ? `\nDirector Style/Focus Guidance: "${runNotes}"\n` : "";

    const prompt = `You are a documentary visual fact-checker and image forensics expert.
Examine the attached image and verify if it is a relevant, authentic real photograph for the video scene below.

Spoken Narration: "${scene.text}"
Subject Description: "${scene.visual_prompt}"${notesText}
Image Title/Caption: "${cand.title}"
Source Domain: "${cand.domain || cand.source}"

CRITICAL DIRECTING & FORENSIC RULES:
1. Note: The Subject Description may contain cinematic camera directions (e.g. "crane shot", "rotating mirrors", "zoom in", "tracking shot"). IGNORE all camera movement and animation directions! You are evaluating a STILL photograph.
2. Check if the image authentically depicts the real-world subject, telescope, spacecraft, planet, or entity discussed in the Spoken Narration or Subject Description (e.g., if the scene discusses the James Webb Space Telescope, ANY high-quality real photograph of the James Webb Space Telescope—whether in space, during assembly/testing in a clean room, or its mirrors/components—IS VALID and should be answered YES).
3. Only answer NO if:
   - The image shows a completely unrelated object/topic (e.g., showing Mars when the scene is strictly about Jupiter, or showing a random person when the scene is about the Hubble telescope).
   - The image is obvious low-quality spam, text chart with no image, or unrelated stock art.
4. If the photograph is an authentic representation of the subject discussed, answer YES ("verified": true).

Return ONLY a valid JSON object:
{
  "verified": true or false,
  "confidence": number (0 to 100),
  "reason": "brief 1-sentence explanation"
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 500,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!resp.ok) return true;
    const json = (await resp.json()) as any;
    const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    if (!text) return true;

    const cleanJson = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleanJson);
    if (typeof parsed.verified === "boolean") {
      if (!parsed.verified && (parsed.confidence ?? 100) >= 65) {
        log(
          runId,
          "warn",
          `⚠ [Gemini Vision Fact-Check Rejected] Image rejected for Scene #${scene.index} (${cand.source}): "${cand.title}" — Reason: ${parsed.reason}`,
          { stage: "real-image" }
        );
        return false;
      } else {
        log(
          runId,
          "info",
          `✓ [Gemini Vision Fact-Check Passed] Image verified for Scene #${scene.index} (${cand.source}): "${cand.title}" (Confidence: ${parsed.confidence || 95}%)`,
          { stage: "real-image" }
        );
        return true;
      }
    }
  } catch {
    // If vision check errors, trust text/domain scoring
  }
  return true;
}

/**
 * Fetches a verified real photograph using Tiered Cascade:
 * Tier 1: Try NASA / Wikimedia Commons APIs first.
 * Tier 2: If API candidates are unavailable or unverified, try verified Web Search.
 * Tier 3: If both fail, return null so pipeline generates an AI fallback image.
 */
export async function fetchRealImage(
  runId: string,
  scene: Scene,
  outPath: string
): Promise<{ filePath: string; title: string; source: string; motionType?: "zoom-in" | "zoom-out" | "slide-up" | "slide-down" | "slide-left" | "slide-right" } | null> {
  const providerSetting = getSetting("REAL_IMAGE_PROVIDER");
  if (providerSetting === "off") return null;

  const rawQuery = scene.search_keywords || scene.visual_prompt;
  const queries = visualPromptToRealImageQuery(rawQuery);

  log(
    runId,
    "info",
    `Searching Tier 1 (Official APIs: ${providerSetting}) for Scene #${scene.index}: "${queries[0] || rawQuery}"`,
    { stage: "real-image" }
  );

  // ── Tier 1: Official APIs (NASA & Wikimedia Commons) ──────────────────────────
  for (const q of queries) {
    let apiCandidates: CandidateImage[] = [];
    if (providerSetting === "nasa") {
      apiCandidates = await searchNasaImages(q);
    } else if (providerSetting === "wikimedia") {
      apiCandidates = await searchWikimediaImages(q);
    } else {
      const [nasaRes, wikiRes] = await Promise.all([searchNasaImages(q), searchWikimediaImages(q)]);
      apiCandidates = [...nasaRes, ...wikiRes];
    }

    if (apiCandidates.length >= 1) {
      apiCandidates = await scoreRealImageCandidates(runId, scene, apiCandidates);
    }

    for (const cand of apiCandidates.slice(0, 6)) {
      if (usedRealImageUrls.has(cand.url)) continue;

      const success = await downloadRealImageFile(cand.url, outPath);
      if (success) {
        const isVerified = await verifyRealImageWithGeminiVision(runId, scene, outPath, cand);
        if (!isVerified) {
          try { fs.unlinkSync(outPath); } catch {}
          continue; // Rejected by Vision AI! Try next API candidate!
        }

        usedRealImageUrls.add(cand.url);
        const cleanTitle = cleanRealImageTitle(cand.title, q || rawQuery);
        const motionType = cand.motionType || deriveMotionFromText(cleanTitle + " " + scene.visual_prompt);
        log(
          runId,
          "info",
          `✓ [Tier 1 API Match] Found real ${cand.source} photo for Scene #${scene.index}: "${cleanTitle}" (${motionType})`,
          { stage: "real-image" }
        );
        try {
          const metaPath = path.join(path.dirname(outPath), `scene_${String(scene.index).padStart(3, "0")}.real.json`);
          fs.writeFileSync(metaPath, JSON.stringify({
            title: cleanTitle,
            source: cand.source,
            motionType,
            realImageTag: `REAL IMAGE: ${cleanTitle.slice(0, 50)} (${cand.source})`,
          }, null, 2), "utf-8");
        } catch {}
        return { filePath: outPath, title: cleanTitle, source: cand.source, motionType };
      }
    }
  }

  // ── Tier 2: Verified Web Search Fallback ────────────────────────────────────
  log(
    runId,
    "info",
    `🌐 Tier 1 API candidates unavailable or unverified for Scene #${scene.index}. Attempting Tier 2 (Direct Web Search)...`,
    { stage: "real-image" }
  );

  for (const q of queries) {
    let webCandidates = await searchWebImages(q);
    if (webCandidates.length >= 1) {
      webCandidates = await scoreRealImageCandidates(runId, scene, webCandidates);
    }

    for (const cand of webCandidates.slice(0, 6)) {
      if (usedRealImageUrls.has(cand.url)) continue;

      const success = await downloadRealImageFile(cand.url, outPath);
      if (success) {
        const isVerified = await verifyRealImageWithGeminiVision(runId, scene, outPath, cand);
        if (!isVerified) {
          try { fs.unlinkSync(outPath); } catch {}
          continue; // Rejected by Vision AI! Try next web candidate!
        }

        usedRealImageUrls.add(cand.url);
        const cleanTitle = cleanRealImageTitle(cand.title, q || rawQuery);
        const motionType = cand.motionType || deriveMotionFromText(cleanTitle + " " + scene.visual_prompt);
        log(
          runId,
          "info",
          `✓ [Tier 2 Web Match] Found real ${cand.domain} photo for Scene #${scene.index}: "${cleanTitle}" (${motionType})`,
          { stage: "real-image" }
        );
        try {
          const metaPath = path.join(path.dirname(outPath), `scene_${String(scene.index).padStart(3, "0")}.real.json`);
          fs.writeFileSync(metaPath, JSON.stringify({
            title: cleanTitle,
            source: cand.source,
            motionType,
            realImageTag: `REAL IMAGE: ${cleanTitle.slice(0, 50)} (${cand.source})`,
          }, null, 2), "utf-8");
        } catch {}
        return { filePath: outPath, title: cleanTitle, source: cand.source, motionType };
      }
    }
  }

  // ── Tier 3: AI Image Generation Fallback ────────────────────────────────────
  log(
    runId,
    "warn",
    `⚠ No verified real photograph found in Tier 1 (APIs) or Tier 2 (Web Search) for Scene #${scene.index}, falling back to Tier 3 (AI Image Generation).`,
    { stage: "real-image" }
  );
  return null;
}

async function evaluateAndPickRealImageScenes(runId: string, scenes: Scene[]): Promise<Set<number> | null> {
  const apiKey = getSetting("GOOGLE_API_KEY") || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const scenesText = scenes
      .map((s) => `Scene #${s.index}:\n  Narration: "${s.text}"\n  Visual Prompt: "${s.visual_prompt}"`)
      .join("\n\n");

    const prompt = `You are an expert documentary director and archival researcher analyzing a video script scene-by-scene.
Your task is to determine EXACTLY which scenes MUST use real historical, factual, NASA, or Wikimedia photographs vs which scenes should NOT use real photos.

CRITICAL DIRECTING RULES:
1. ONLY use real images when ACTUALLY NEEDED by what is spoken in the script or described in the visual prompt!
2. When IS a real photograph needed?
   - When the scene narrates a specific real-world event, mission, launch, discovery, or historical moment (e.g. "In 2020, NASA launched the Perseverance rover...", "When Hubble captured the Pillars of Creation...").
   - When the scene specifically describes or showcases a real concrete celestial object, telescope, rover, astronaut, planet surface, or documented entity (e.g. "The surface of Jezero Crater on Mars shows layers of sedimentary rock", "Andromeda is a spiral galaxy 2.5 million light years away").
3. When is a real photograph NOT needed (and should NOT be selected)?
   - Conceptual introductions, rhetorical hooks, and general wonder (e.g. "Have you ever looked up at the night sky and wondered what lies beyond?").
   - Theoretical physics, sci-fi concepts, speculative futures, and abstract analogies (e.g. "What if advanced civilizations built Dyson spheres around their stars?", "Imagine traveling through a wormhole into another universe").
   - General transitions, metaphors, and summary/outro remarks (e.g. "As we continue to explore the cosmos, only time will tell what we discover next.").
4. DO NOT select every scene or 90% of the video just because the topic is space or science! Be selective and accurate: pick ONLY the specific scenes where a real factual archival photograph is required to illustrate the exact documented entity/event being discussed.

Return ONLY a JSON array of scene indices (numbers) for the scenes that ACTUALLY NEED real archival photographs. Example: [2, 4, 5, 8]`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
          maxOutputTokens: 1000,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });

    if (!resp.ok) return null;
    const json = (await resp.json()) as any;
    const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    if (!text) return null;

    const cleanJson = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleanJson);
    if (Array.isArray(parsed)) {
      const validSet = new Set<number>();
      for (const item of parsed) {
        if (typeof item === "number" && scenes.some((s) => s.index === item)) {
          validSet.add(item);
        }
      }
      return validSet;
    }
  } catch {
    // Fall through to strict heuristic if Gemini encounter network/parsing error
  }
  return null;
}

/**
 * Selects which scenes should attempt real photograph sourcing based on deep script & entity analysis.
 */
export async function pickScenesForRealImages(
  runId: string,
  scenes: Scene[],
  ratioPercent: number,
  excludeIndices = new Set<number>()
): Promise<Set<number>> {
  const selected = new Set<number>();
  if (scenes.length === 0 || getSetting("REAL_IMAGE_PROVIDER") === "off") return selected;

  const available = scenes.filter((s) => !excludeIndices.has(s.index));
  if (available.length === 0) return selected;

  // Attempt intelligent Gemini Archival Script Evaluation first so only truly necessary scenes are selected
  const geminiPicked = await evaluateAndPickRealImageScenes(runId, available);
  if (geminiPicked !== null) {
    log(
      runId,
      "info",
      `🤖 Gemini Archival Script Reader evaluated ${available.length} scenes: selected ${geminiPicked.size} scene(s) requiring real factual footage/photos (${Array.from(geminiPicked).join(", ") || "none"})`,
      { stage: "real-image" }
    );
    return geminiPicked;
  }

  // Strict intelligent heuristic fallback if Gemini is not configured / offline
  const SPECULATIVE_CONCEPTUAL_REGEX = /imagine|what if|hypothes|could be|alien|dyson sphere|time travel|wormhole|wonder|future of|conclusion|in summary|let's explore|have you ever/i;
  const CONCRETE_ENTITY_REGEX = /NASA|Hubble|Webb|JWST|Cassini|Apollo|Saturn|Mars|Jupiter|Galaxy|Nebula|Telescope|Planet|Orbit|Observatory|Astronaut|Spacecraft|Rover|Voyager|Black Hole|Supernova|Milky Way|Comet|Asteroid|Einstein|Newton|Galileo|Curiosity|Perseverance|\b(1[89]\d\d|20[0-2]\d)\b/i;

  for (const s of available) {
    const textCombined = `${s.text} ${s.visual_prompt} ${s.search_keywords || ""}`;
    if (SPECULATIVE_CONCEPTUAL_REGEX.test(textCombined)) {
      continue; // Conceptual/speculative scene — do not use real image!
    }
    if (CONCRETE_ENTITY_REGEX.test(textCombined)) {
      selected.add(s.index);
    }
  }

  // If user specified a manual ratio slider > 0 and no concrete historical/astronomical entities were found, pick based on slider ratio
  if (selected.size === 0 && ratioPercent > 0) {
    const count = Math.max(1, Math.round((available.length * Math.min(100, ratioPercent)) / 100));
    for (let i = 0; i < count && i < available.length; i++) {
      selected.add(available[i].index);
    }
  }

  log(
    runId,
    "info",
    `Script evaluation selected ${selected.size}/${available.length} scene(s) where real photographs are actually needed (${Array.from(selected).join(", ") || "none"})`,
    { stage: "real-image" }
  );
  return selected;
}

