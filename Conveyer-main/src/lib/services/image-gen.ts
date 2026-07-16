import fs from "node:fs";
import path from "node:path";
import { getSetting, getRunDirectorNotes } from "../settings";
import { getPrompt } from "../prompts";
import { log } from "../logger";
import { checkCancelled, CancelledError } from "../cancellation";
import type { Scene } from "./scene-split";
import { createImageJob, pollJob, downloadJob, cancelJob, releaseJob, setBatchKey, tryNextKey, getKeyList } from "./labs69";
import { createKieImageTask, pollKieTask, downloadKieTask, getKieKeyList, tryNextKieKey, releaseKieTask } from "./kieai";
import { comfyuiImage } from "./comfyui";

export interface ImageResult {
  /** Path to the png file. */
  filePath: string;
  /** Provider's job id (if supported) — used to chain into img2vid without re-uploading. */
  providerJobId?: string;
  /** Which provider made the image. */
  provider: string;
}

/**
 * Generates one illustration for a scene.
 * Supports 69labs (default), Replicate (Flux), OpenAI Images, fal.ai.
 *
 * Key failover: if 69labs is the primary provider and has multiple keys,
 * tries each key before falling back to the fallback provider.
 *
 * Provider fallback: if IMAGE_FALLBACK_PROVIDER is set, retries with
 * the fallback provider when primary (all keys) fails.
 */
export async function generateImage(
  runId: string,
  scene: Scene,
  outDir: string,
  options: { partNum?: number; promptOverride?: string } = {}
): Promise<ImageResult> {
  checkCancelled(runId);
  const provider = (getSetting("IMAGE_PROVIDER") || "69labs").toLowerCase().trim();
  const fallback = (getSetting("IMAGE_FALLBACK_PROVIDER") || "").toLowerCase().trim();
  const styleSuffix = getPrompt("image_prompt");
  const basePrompt = options.promptOverride || scene.visual_prompt;
  const runNotes = getRunDirectorNotes(runId);
  const finalPrompt = runNotes
    ? `${basePrompt}, ${styleSuffix}, [Director Style Instructions: ${runNotes}]`
    : `${basePrompt}, ${styleSuffix}`;
  const fileName = options.partNum
    ? `scene_${String(scene.index).padStart(3, "0")}_part${options.partNum}.png`
    : `scene_${String(scene.index).padStart(3, "0")}.png`;
  const filePath = path.join(outDir, fileName);

  // Try primary provider first (with key failover for 69labs/kieai)
  try {
    const result = await generateWithKeyFailover(runId, provider, finalPrompt, filePath, scene.index);
    return result;
  } catch (primaryErr) {
    if (primaryErr instanceof CancelledError) throw primaryErr;
    // If no fallback configured, or fallback is same as primary, just throw
    if (!fallback || fallback === "off" || fallback === provider) {
      throw primaryErr;
    }

    // Try fallback provider
    const msg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    log(runId, "warn",
      `Image #${scene.index} primary provider (${provider}) failed all keys: ${msg.slice(0, 150)} → switching to fallback (${fallback})`,
      { stage: "image" }
    );

    try {
      const result = await generateWithKeyFailover(runId, fallback, finalPrompt, filePath, scene.index);
      log(runId, "success", `Image #${scene.index} recovered via fallback provider (${fallback})`, { stage: "image" });
      return result;
    } catch (fallbackErr) {
      if (fallbackErr instanceof CancelledError) throw fallbackErr;
      const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      log(runId, "error",
        `Image #${scene.index} fallback (${fallback}) also failed: ${fbMsg.slice(0, 150)}`,
        { stage: "image" }
      );
      throw primaryErr;
    }
  }
}

/**
 * Wraps generateWithProvider with key-failover logic for 69labs and KieAI.
 * If the provider is 69labs/kieai and there are multiple keys, tries each key
 * in sequence until one works or all are exhausted.
 */
async function generateWithKeyFailover(
  runId: string,
  provider: string,
  prompt: string,
  filePath: string,
  sceneIndex: number,
): Promise<ImageResult> {
  if (provider === "69labs" && getKeyList().length > 1) {
    const failedKeys = new Set<string>();
    let lastErr: Error | undefined;

    while (true) {
      try {
        return await generateWithProvider(runId, provider, prompt, filePath, sceneIndex);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));

        const currentKey = getKeyList().find((k) => !failedKeys.has(k));
        if (currentKey) failedKeys.add(currentKey);

        const nextKey = tryNextKey(failedKeys);
        if (!nextKey) {
          log(runId, "warn",
            `Image #${sceneIndex} exhausted all ${failedKeys.size} 69labs keys`,
            { stage: "image" }
          );
          throw lastErr;
        }

        log(runId, "info",
          `Image #${sceneIndex} key …${currentKey?.slice(-6) || "?"} failed → trying key …${nextKey.slice(-6)}`,
          { stage: "image" }
        );
      }
    }
  }

  if (provider === "kieai" && getKieKeyList().length > 1) {
    const failedKeys = new Set<string>();
    let lastErr: Error | undefined;

    while (true) {
      try {
        return await generateWithProvider(runId, provider, prompt, filePath, sceneIndex);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));

        const currentKey = getKieKeyList().find((k) => !failedKeys.has(k));
        if (currentKey) failedKeys.add(currentKey);

        const nextKey = tryNextKieKey(failedKeys);
        if (!nextKey) {
          log(runId, "warn",
            `Image #${sceneIndex} exhausted all ${failedKeys.size} KieAI keys`,
            { stage: "image" }
          );
          throw lastErr;
        }

        log(runId, "info",
          `Image #${sceneIndex} KieAI key …${currentKey?.slice(-6) || "?"} failed → trying key …${nextKey.slice(-6)}`,
          { stage: "image" }
        );
      }
    }
  }

  return generateWithProvider(runId, provider, prompt, filePath, sceneIndex);
}

/** Run image generation with a specific provider. */
async function generateWithProvider(
  runId: string,
  provider: string,
  prompt: string,
  filePath: string,
  sceneIndex: number,
): Promise<ImageResult> {
  const fileName = path.basename(filePath);

  log(runId, "info", `Image scene #${sceneIndex} (${provider})`, {
    stage: "image",
    data: { provider, prompt: prompt.slice(0, 120) },
  });

  if (provider === "69labs") {
    const jobId = await labs69Image(runId, prompt, filePath);
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, providerJobId: jobId, provider };
  }
  if (provider === "kieai") {
    await kieaiImage(runId, prompt, filePath);
    log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
    return { filePath, provider };
  }
  if (provider === "replicate") {
    await replicateImage(prompt, filePath);
  } else if (provider === "openai") {
    await openaiImage(prompt, filePath);
  } else if (provider === "fal") {
    await falImage(prompt, filePath);
  } else if (provider === "comfyui") {
    await comfyuiImage(runId, prompt, filePath);
  } else {
    throw new Error(`Unknown image provider: ${provider}`);
  }
  log(runId, "success", `Image saved: ${fileName}`, { stage: "image" });
  return { filePath, provider };
}

async function labs69Image(runId: string, prompt: string, outPath: string): Promise<string> {
  const rawModel = (getSetting("IMAGE_MODEL") || "").trim();
  const LABS69_IMAGE_MODEL_MAP: Record<string, string> = {
    "flux-kontext-pro": "img-flux",
    "flux-schnell": "img-flux",
    "nano-banana-pro": "nano-banana-pro",
  };
  const model = LABS69_IMAGE_MODEL_MAP[rawModel] || (rawModel.startsWith("flux-") ? "img-flux" : rawModel) || "img-flux";
  let aspectRatio = getSetting("IMAGE_RATIO") || undefined;

  // Imagen 4 only accepts 'square|portrait|landscape', not numeric ratios like '16:9'.
  // Safely map for the Imagen family.
  const isImagen = /^imagen/i.test(model);
  if (isImagen && aspectRatio) {
    const map: Record<string, string> = {
      "16:9": "landscape", "21:9": "landscape", "4:3": "landscape", "3:2": "landscape",
      "1:1": "square",
      "9:16": "portrait", "9:21": "portrait", "3:4": "portrait", "2:3": "portrait",
    };
    aspectRatio = map[aspectRatio] ?? aspectRatio;
  }

  // Flux models (img-flux, flux-schnell, etc.) don't support resolution selection
  const isFlux = /flux/i.test(model);
  const resolution = isFlux ? undefined : (getSetting("IMAGE_RESOLUTION") || undefined);

  // Retry: on timeout we cancel the stuck job first to free the concurrent slot.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  let lastJobId: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const jobId = await createImageJob({ prompt, model, aspectRatio, resolution, runId });
      lastJobId = jobId;
      log(
        runId,
        "debug",
        `69labs image job ${jobId.slice(0, 8)}… (model=${model ?? "default"}, aspect=${aspectRatio}, res=${resolution ?? "default"}, attempt=${attempt})`,
        { stage: "image" }
      );
      await pollJob("images", jobId, runId, "image");
      await downloadJob("images", jobId, outPath);
      return jobId;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);

      // On polling timeout — cancel the orphaned job to free its concurrency slot.
      // cancelJob() releases the key slot internally. For other error types
      // (poll itself failed, download failed) we still need to release the key
      // since the job is dead to us.
      if (lastJobId) {
        if (/polling timeout/i.test(msg)) {
          const cancelled = await cancelJob("images", lastJobId);
          log(runId, "debug", `Cancelled ${lastJobId.slice(0, 8)} → ${cancelled ? "ok" : "skipped"}`, {
            stage: "image",
          });
        } else {
          // Free the key slot even on non-timeout errors so retries don't pile up
          releaseJob(lastJobId);
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        // If this was a rate/credit limit, clear the batch key so the retry
        // picks a different API key instead of hammering the same one
        if (/429|rate limit|credit limit/i.test(msg)) {
          setBatchKey(null);
        }
        // Exponential backoff to let slots thaw
        const delay = 5000 * attempt;
        log(runId, "warn", `image attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "image",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function kieaiImage(runId: string, prompt: string, outPath: string) {
  const aspectRatio = getSetting("IMAGE_RATIO") || "16:9";

  const primaryProvider = (getSetting("IMAGE_PROVIDER") || "kieai").toLowerCase();
  const rawModel = (getSetting("IMAGE_MODEL") || "").trim();
  const kieDefault = (getSetting("KIEAI_DEFAULT_IMAGE_MODEL") || "flux-kontext-pro").trim();

  const KIE_IMAGE_MODEL_MAP: Record<string, string> = {
    "nano-banana-pro": "flux-kontext-pro",
    "nano-banana": "flux-kontext-pro",
    "img-flux": "flux-kontext-pro",
    "imagen-4": "flux-kontext-pro",
    "seedream-4.5": "flux-kontext-pro",
    "flux-2-pro": "flux-kontext-pro",
  };

  let model: string;
  const is69labsSpecificImageModel = ["nano-banana-pro", "nano-banana", "img-flux", "imagen-4", "seedream-4.5", "flux-2-pro"].includes(rawModel);
  if (primaryProvider === "kieai") {
    if (rawModel && !is69labsSpecificImageModel) {
      model = KIE_IMAGE_MODEL_MAP[rawModel] || rawModel;
    } else {
      model = kieDefault || KIE_IMAGE_MODEL_MAP[rawModel] || rawModel || "flux-kontext-pro";
    }
  } else {
    model = kieDefault || KIE_IMAGE_MODEL_MAP[rawModel] || rawModel || "flux-kontext-pro";
  }

  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  let lastTaskId: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const taskId = await createKieImageTask({
        prompt,
        model,
        aspectRatio,
        runId,
      });
      lastTaskId = taskId;
      log(
        runId,
        "debug",
        `KieAI image task ${taskId.slice(0, 8)}… (model=${model}, aspect=${aspectRatio}, attempt=${attempt})`,
        { stage: "image" }
      );
      const data = await pollKieTask(taskId, runId, "image");
      await downloadKieTask(data, outPath, taskId);
      return;
    } catch (e) {
      if (lastTaskId) releaseKieTask(lastTaskId);
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_ATTEMPTS) {
        const delay = 5000 * attempt;
        log(runId, "warn", `KieAI image attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg.slice(0, 200)} — retry in ${delay}ms`, {
          stage: "image",
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function replicateImage(prompt: string, outPath: string) {
  const token = getSetting("REPLICATE_API_TOKEN");
  if (!token) throw new Error("REPLICATE_API_TOKEN is not set");
  const model = getSetting("IMAGE_MODEL") || "black-forest-labs/flux-schnell";
  const aspect = getSetting("IMAGE_RATIO") || "16:9";

  const create = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",
    },
    body: JSON.stringify({ input: { prompt, aspect_ratio: aspect, output_format: "png" } }),
  });

  if (!create.ok) {
    throw new Error(`Replicate ${create.status}: ${(await create.text()).slice(0, 300)}`);
  }
  const json = (await create.json()) as { output?: string | string[] };
  const urlOrUrls = json.output;
  let imageUrl: string | undefined;
  if (typeof urlOrUrls === "string") imageUrl = urlOrUrls;
  else if (Array.isArray(urlOrUrls) && urlOrUrls.length > 0) imageUrl = urlOrUrls[0];
  if (!imageUrl) throw new Error(`Replicate returned no output: ${JSON.stringify(json).slice(0, 300)}`);

  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Failed to download image: ${img.status}`);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}

async function openaiImage(prompt: string, outPath: string) {
  const key = getSetting("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "gpt-image-1";

  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: "1792x1024", n: 1 }),
  });
  if (!resp.ok) throw new Error(`OpenAI image ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { data: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) {
    fs.writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
  } else if (item?.url) {
    const r = await fetch(item.url);
    fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
  } else {
    throw new Error("OpenAI image: empty output");
  }
}

async function falImage(prompt: string, outPath: string) {
  const key = getSetting("FAL_API_KEY");
  if (!key) throw new Error("FAL_API_KEY is not set");
  const model = getSetting("IMAGE_MODEL") || "fal-ai/flux/schnell";
  const aspect = getSetting("IMAGE_RATIO") || "16:9";

  const resp = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, aspect_ratio: aspect, output_format: "png" }),
  });
  if (!resp.ok) throw new Error(`fal ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const json = (await resp.json()) as { images?: { url: string }[] };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error("fal: empty output");
  const img = await fetch(url);
  fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
}
