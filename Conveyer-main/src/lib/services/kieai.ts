import fs from "node:fs";
import { getSetting } from "../settings";
import { log, type LogLevel } from "../logger";
import { checkCancelled } from "../cancellation";

/**
 * Kie AI API client (https://kie.ai).
 *
 * Unified AI gateway — single API key covers TTS, images, videos.
 * Pattern: submit task → poll for status → download result.
 */

const BASE = "https://api.kie.ai/api/v1";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 10 * 60 * 1000; // 10 min

const DEFAULT_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

// ── Auth ─────────────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = getSetting("KIEAI_API_KEY").trim();
  if (!key) throw new Error("KIEAI_API_KEY is not set (Settings → Keys & Settings)");
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getApiKey()}`,
    "Content-Type": "application/json",
  };
}

// ── Fetch with timeout ──────────────────────────────────────────────────────

async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...(init ?? {}), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Response helpers ────────────────────────────────────────────────────────

/**
 * Extract taskId from any Kie AI response shape. Tries multiple known formats:
 *   { data: { taskId } }
 *   { data: { task_id } }
 *   { taskId }
 *   { task_id }
 *   { id }
 *   { data: { id } }
 */
function extractTaskId(json: Record<string, unknown>, endpoint: string): string {
  // Try nested data.taskId / data.task_id / data.id
  const data = json.data as Record<string, unknown> | null | undefined;
  if (data) {
    if (typeof data.taskId === "string" && data.taskId) return data.taskId;
    if (typeof data.task_id === "string" && data.task_id) return data.task_id;
    if (typeof data.id === "string" && data.id) return data.id;
  }
  // Try top-level
  if (typeof json.taskId === "string" && json.taskId) return json.taskId;
  if (typeof json.task_id === "string" && json.task_id) return json.task_id;
  if (typeof json.id === "string" && json.id) return json.id;

  // Nothing found — throw with the raw response for debugging
  throw new Error(
    `KieAI ${endpoint}: no taskId in response: ${JSON.stringify(json).slice(0, 500)}`
  );
}

// ── Generic POST helper with retry ──────────────────────────────────────────

async function postJsonRaw(
  path: string,
  body: unknown,
  ctx?: { runId: string; stage: string }
): Promise<Record<string, unknown>> {
  const MAX_RETRIES = 10;
  let retry = 0;
  while (true) {
    const bodyStr = JSON.stringify(body);
    // Log request payload for debugging
    if (ctx) {
      log(ctx.runId, "debug", `KieAI request ${path}: ${bodyStr.slice(0, 500)}`, { stage: ctx.stage });
    }
    const r = await fetchWithTimeout(`${BASE}${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: bodyStr,
    });

    if (r.ok) {
      const json = (await r.json()) as Record<string, unknown>;
      // Log raw response for debugging (first 300 chars)
      if (ctx) {
        log(ctx.runId, "debug", `KieAI raw response ${path}: ${JSON.stringify(json).slice(0, 300)}`, {
          stage: ctx.stage,
        });
      }
      // Kie AI sometimes returns HTTP 200 but with an error code in the body
      const bodyCode = json.code as number | undefined;
      if (bodyCode && bodyCode >= 400) {
        const msg = (json.msg as string) || `error code ${bodyCode}`;
        throw new Error(`KieAI ${path}: ${msg}`);
      }
      return json;
    }

    if (r.status === 429 && retry < MAX_RETRIES) {
      retry++;
      const retryAfter = Number(r.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5 * 60_000)
          : Math.min(5 * 60_000, 15_000 * retry);
      if (ctx) {
        log(
          ctx.runId,
          "warn",
          `KieAI rate limit (429) — waiting ${Math.round(waitMs / 1000)}s then retrying (${retry}/${MAX_RETRIES})`,
          { stage: ctx.stage }
        );
      }
      await sleep(waitMs);
      continue;
    }

    const errText = await r.text().catch(() => "");
    throw new Error(`KieAI POST ${path} ${r.status}: ${errText.slice(0, 400)}`);
  }
}

// ── TTS ─────────────────────────────────────────────────────────────────────

export async function createKieTtsTask(opts: {
  text: string;
  voiceId: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
  runId?: string;
}): Promise<string> {
  const ctx = opts.runId ? { runId: opts.runId, stage: "tts" } : undefined;
  const input: Record<string, unknown> = {
    text: opts.text,
    voice: opts.voiceId,
  };
  if (opts.stability !== undefined) input.stability = opts.stability;
  if (opts.similarityBoost !== undefined) input.similarity_boost = opts.similarityBoost;

  const json = await postJsonRaw(
    "/jobs/createTask",
    {
      model: opts.model || "elevenlabs/text-to-speech-multilingual-v2",
      input,
    },
    ctx
  );
  return extractTaskId(json, "/jobs/createTask");
}

// ── Images ──────────────────────────────────────────────────────────────────

export async function createKieImageTask(opts: {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  runId?: string;
}): Promise<string> {
  const ctx = opts.runId ? { runId: opts.runId, stage: "image" } : undefined;
  const model = (opts.model || "flux-kontext-pro").trim().toLowerCase();

  let endpoint: string;
  let pollEndpoint: string;
  const body: Record<string, unknown> = { prompt: opts.prompt };

  if (model.startsWith("flux")) {
    // Flux models use the dedicated kontext endpoint
    endpoint = "/flux/kontext/generate";
    pollEndpoint = "/flux/kontext/record-info";
    body.model = model;
    if (opts.aspectRatio) body.aspectRatio = opts.aspectRatio;
    body.outputFormat = "png";
  } else {
    // All other models (nano-banana, seedream, grok-imagine, gpt-image, etc.)
    // use the generic jobs endpoint
    endpoint = "/jobs/createTask";
    pollEndpoint = "/jobs/recordInfo";
    body.model = model;
    const input: Record<string, unknown> = { prompt: opts.prompt };
    if (opts.aspectRatio) input.aspect_ratio = opts.aspectRatio;
    input.outputFormat = "png";
    body.input = input;
    // For /jobs/createTask, the prompt is inside input, not top-level
    delete body.prompt;
  }

  const json = await postJsonRaw(endpoint, body, ctx);
  return extractTaskId(json, endpoint);
}

// ── Videos (img2vid) ────────────────────────────────────────────────────────

export async function createKieVideoTask(opts: {
  prompt: string;
  imageUrl?: string;
  model?: string;
  aspectRatio?: string;
  duration?: number;
  quality?: string;
  runId?: string;
}): Promise<{ taskId: string; pollEndpoint: string }> {
  const ctx = opts.runId ? { runId: opts.runId, stage: "animate" } : undefined;
  const model = (opts.model || "veo3_fast").trim().toLowerCase();

  let endpoint: string;
  let pollEndpoint: string;
  const body: Record<string, unknown> = { prompt: opts.prompt };

  if (model.startsWith("veo")) {
    endpoint = "/veo/generate";
    pollEndpoint = "/veo/record-info";
    body.model = model;
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  } else if (model.startsWith("kling")) {
    endpoint = "/kling/generate";
    pollEndpoint = "/kling/record-info";
    body.model_name = model;
    if (opts.imageUrl) body.image = opts.imageUrl;
    if (opts.duration) body.duration = String(opts.duration);
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  } else if (model.startsWith("minimax")) {
    endpoint = "/minimax/generate";
    pollEndpoint = "/minimax/record-info";
    body.model = model;
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
    if (opts.duration) body.duration = opts.duration;
  } else if (model.startsWith("wan")) {
    endpoint = "/wan/generate";
    pollEndpoint = "/wan/record-info";
    body.model = model;
    if (opts.imageUrl) body.image = opts.imageUrl;
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
    if (opts.duration) body.duration = opts.duration;
  } else {
    // Runway / other models — generic fallback
    endpoint = "/runway/generate";
    pollEndpoint = "/runway/record-info";
    body.quality = opts.quality || "720p";
    if (opts.imageUrl && opts.imageUrl.startsWith("http")) {
      body.imageUrl = opts.imageUrl;
    }
    if (opts.aspectRatio) body.aspectRatio = opts.aspectRatio;
    if (opts.duration) body.duration = opts.duration;
  }

  const json = await postJsonRaw(endpoint, body, ctx);
  const taskId = extractTaskId(json, endpoint);
  return { taskId, pollEndpoint };
}

// ── Polling ─────────────────────────────────────────────────────────────────

export async function pollKieTask(
  taskId: string,
  runId: string,
  stage: string,
  level: LogLevel = "debug",
  /** Override the poll endpoint path (without query string). 
   *  Each KieAI service has its own record-info endpoint:
   *    TTS:       /jobs/recordInfo   (default)
   *    Images:    /flux/kontext/record-info
   *    Veo:       /veo/record-info
   *    Kling:     /kling/record-info
   *    Runway:    /runway/record-info
   */
  pollEndpoint?: string
): Promise<Record<string, unknown>> {
  const start = Date.now();
  // Determine the correct poll path
  let basePollPath: string;
  if (pollEndpoint) {
    basePollPath = pollEndpoint;
  } else if (taskId.startsWith("fluxkontext_")) {
    basePollPath = "/flux/kontext/record-info";
  } else {
    basePollPath = "/jobs/recordInfo";
  }
  let pollPath = `${basePollPath}?taskId=${encodeURIComponent(taskId)}`;

  while (true) {
    if (runId) checkCancelled(runId);
    const r = await fetchWithTimeout(`${BASE}${pollPath}`, {
      headers: authHeaders(),
    });
    if (!r.ok) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const errBody = (await r.text()).slice(0, 200);
      // 422 "recordInfo is null" is common right after task creation — task
      // isn't registered yet. Treat as "still processing" for first 60s.
      if (r.status === 422 && elapsed < 60) {
        log(runId, "debug", `KieAI ${taskId.slice(0, 8)} poll got 422, task not ready yet (${elapsed}s)`, { stage });
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      // 404 — the specific poll endpoint doesn't exist for this model.
      // Fall back to the generic /jobs/recordInfo endpoint.
      if (r.status === 404 && basePollPath !== "/jobs/recordInfo") {
        log(runId, "debug", `KieAI ${taskId.slice(0, 8)} poll 404 on ${basePollPath}, falling back to /jobs/recordInfo`, { stage });
        basePollPath = "/jobs/recordInfo";
        pollPath = `${basePollPath}?taskId=${encodeURIComponent(taskId)}`;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      throw new Error(
        `KieAI status ${taskId} ${r.status}: ${errBody}`
      );
    }
    const json = (await r.json()) as Record<string, unknown>;

    // Extract status — Kie AI uses different field names:
    //   /jobs/recordInfo:          data.state  ("in_progress" | "success" | "failed")
    //   /flux/kontext/record-info: data.successFlag (0=processing, 1=success, 2=create_failed, 3=gen_failed)
    const data = json.data as Record<string, unknown> | null | undefined;
    const stateStr = (data?.state as string) || (data?.status as string) || (json.status as string) || "";
    const successFlag = data?.successFlag as number | undefined;

    // Normalize to a unified status string
    let status: string;
    if (successFlag !== undefined) {
      status = successFlag === 0 ? "processing" : successFlag === 1 ? "success" : "failed";
    } else {
      status = stateStr || "unknown";
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (level !== "debug") {
      log(runId, level, `KieAI ${taskId.slice(0, 8)} → ${status}`, { stage });
    } else if (elapsed % 30 < POLL_INTERVAL_MS / 1000 + 1) {
      const extra = elapsed < 5 ? ` raw=${JSON.stringify(json).slice(0, 400)}` : "";
      log(runId, "debug", `KieAI ${taskId.slice(0, 8)} polling… status=${status} (${elapsed}s)${extra}`, { stage });
    }

    if (status === "success" || status === "completed" || status === "complete") {
      log(runId, "debug", `KieAI poll success: ${JSON.stringify(json).slice(0, 500)}`, { stage });
      // For /jobs/recordInfo, URLs may be in data.resultJson (a JSON string)
      if (data?.resultJson && typeof data.resultJson === "string") {
        try {
          const parsed = JSON.parse(data.resultJson as string) as Record<string, unknown>;
          return { ...data, _parsedResult: parsed };
        } catch { /* ignore parse errors */ }
      }
      return data || json;
    }
    if (status === "fail" || status === "failed" || status === "error") {
      const msg = (data?.failMsg as string) || (data?.message as string) || (json.msg as string) || "unknown error";
      throw new Error(`KieAI task ${taskId} failed: ${msg}`);
    }

    if (Date.now() - start > POLL_MAX_MS) {
      throw new Error(
        `KieAI task ${taskId} exceeded ${POLL_MAX_MS / 1000}s polling timeout (last status: ${status})`
      );
    }
    await sleep(POLL_INTERVAL_MS);
    if (runId) checkCancelled(runId);
  }
}

// ── Download ────────────────────────────────────────────────────────────────

/**
 * Extract the download URL from a completed task's response.
 * Searches recursively through known field names.
 */
function extractUrl(data: Record<string, unknown>): string | null {
  // Check parsed resultJson first (TTS tasks store URLs here)
  const parsed = data._parsedResult as Record<string, unknown> | undefined;
  if (parsed) {
    // resultUrls is an array of URLs
    if (Array.isArray(parsed.resultUrls)) {
      const first = parsed.resultUrls[0];
      if (typeof first === "string" && first.startsWith("http")) return first;
    }
    const url = findUrlInObject(parsed);
    if (url) return url;
  }
  // Check nested response object
  const resp = data.response as Record<string, unknown> | undefined;
  if (resp) {
    const url = findUrlInObject(resp);
    if (url) return url;
  }
  // Check top-level
  return findUrlInObject(data);
}

function findUrlInObject(obj: Record<string, unknown>): string | null {
  const urlKeys = [
    "audio_url", "audioUrl", "audio",
    "video_url", "videoUrl", "video",
    "image_url", "imageUrl", "image",
    "url", "output", "download_url", "downloadUrl", "file_url", "fileUrl",
    "result_url", "resultUrl", "result",
  ];
  for (const key of urlKeys) {
    const val = obj[key];
    if (typeof val === "string" && val.startsWith("http")) return val;
  }
  // Check arrays of images/videos
  if (Array.isArray(obj.images)) {
    const first = obj.images[0] as Record<string, unknown> | string | undefined;
    if (typeof first === "string" && first.startsWith("http")) return first;
    if (first && typeof first === "object" && typeof first.url === "string") return first.url;
  }
  if (Array.isArray(obj.videos)) {
    const first = obj.videos[0] as Record<string, unknown> | string | undefined;
    if (typeof first === "string" && first.startsWith("http")) return first;
    if (first && typeof first === "object" && typeof first.url === "string") return first.url;
  }
  return null;
}

/**
 * Download a completed task's output to a file.
 */
export async function downloadKieTask(
  taskData: Record<string, unknown>,
  outPath: string
): Promise<void> {
  let url = extractUrl(taskData);

  // Last resort: find any URL-like string in the entire response
  if (!url) {
    const respStr = JSON.stringify(taskData);
    const urlMatch = respStr.match(/https?:\/\/[^\s"\\}]+/);
    if (urlMatch) {
      url = urlMatch[0];
    } else {
      throw new Error(
        `KieAI: no download URL in response: ${respStr.slice(0, 500)}`
      );
    }
  }

  const r = await fetchWithTimeout(
    url,
    { redirect: "follow" },
    DOWNLOAD_TIMEOUT_MS
  );
  if (!r.ok) {
    throw new Error(`KieAI download ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 512) {
    throw new Error(
      `KieAI download too small (${buf.length} bytes) — likely empty or error response`
    );
  }
  fs.writeFileSync(outPath, buf);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
