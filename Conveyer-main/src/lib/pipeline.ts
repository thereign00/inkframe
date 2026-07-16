import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit, type LimitFunction } from "./plimit";
import { splitScript, type Scene } from "./services/scene-split";
import { synthesizeScene, type TtsResult } from "./services/tts";
import { generateImage, type ImageResult } from "./services/image-gen";
import { animateScene, pickScenesToAnimate } from "./services/img2vid";
import { pickScenesForStock, fetchStockVideo, clearUsedStockIds } from "./services/stock-video";
import { pickScenesForRealImages, fetchRealImage, clearUsedRealImages } from "./services/real-image";
import { assembleVideo, type AssembleInput } from "./services/video-assemble";
import { getKeyCount, getKeyList, setBatchKey, withSceneKey } from "./services/labs69";
import { getKieKeyList, setBatchKieKey, withSceneKieKey } from "./services/kieai";
import { syncRunToDrive } from "./services/run-upload";
import { downloadReusedClip } from "./services/reuse";
import { syncActiveChannelToLive } from "./channels";
import { checkCancelled, clearCancelled, CancelledError, checkPausedOrCancelled, pauseRun } from "./cancellation";
import { directorRepairVisualPrompt } from "./services/director-repair";

const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);
const getReuseMapStmt = db.prepare("SELECT reuse_map_json FROM runs WHERE id = ?");

// ── Retry helper ────────────────────────────────────────────────────────────
const MAX_RETRIES = 5;
const INITIAL_RETRY_MS = 3_000;

async function withRetry<T>(
  runId: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  let attempt = 1;
  while (true) {
    try {
      await checkPausedOrCancelled(runId);
      return await fn();
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);

      // 1. Network disconnection auto-wait loop
      const isNetworkErr = /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(msg);
      if (isNetworkErr) {
        log(
          runId, "warn",
          `🌐 ${label} encountered network error (${msg.slice(0, 120)}). Auto-waiting 15s for internet connection...`,
          { stage: "pipeline" }
        );
        await new Promise((r) => setTimeout(r, 15_000));
        await checkPausedOrCancelled(runId);
        continue;
      }

      // 2. Concurrency / Rate limit (single API key backoff)
      const isConcurrencyOrRateLimit = /Concurrent image|limit reached|403|429|Too Many Requests/i.test(msg);
      const maxAttempts = isConcurrencyOrRateLimit ? 25 : MAX_RETRIES;

      if (attempt < maxAttempts) {
        const delay = isConcurrencyOrRateLimit
          ? 12_000
          : INITIAL_RETRY_MS * Math.pow(2, attempt - 1);
        log(
          runId, "warn",
          `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${(delay / 1000).toFixed(0)}s: ${msg.slice(0, 200)}`,
          { stage: "pipeline" }
        );
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        await checkPausedOrCancelled(runId);
      } else {
        // Instead of crashing the pipeline, pause and wait for user to fund credits or fix settings and click Resume!
        await pauseRun(
          runId,
          `${label} failed after ${attempt} attempts: ${msg.slice(0, 180)}. Please check API credits or network, then click Resume.`
        );
        attempt = 1; // Reset attempt counter upon Resume
      }
    }
  }
}

// ── Scene result type ───────────────────────────────────────────────────────
type SceneResult = AssembleInput & {
  _imgProviderJobId?: string;
  _imgProvider?: string;
};

// ── Main pipeline ───────────────────────────────────────────────────────────

export async function runPipeline(runId: string, script: string) {
  const runDir = getRunDir(runId);
  const audioDir = path.join(runDir, "audio");
  const imgDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  for (const d of [runDir, audioDir, imgDir, animDir]) fs.mkdirSync(d, { recursive: true });

  let limitTts!: LimitFunction;
  let limitImg!: LimitFunction;
  let limitAnim!: LimitFunction;

  try {
    clearCancelled(runId);
    clearUsedStockIds();
    clearUsedRealImages();
    updateRun.run("running", null, runId);

    // Force-sync the active channel's saved settings into the live table
    // so the pipeline always uses what the user configured, not stale defaults.
    syncActiveChannelToLive();

    log(runId, "info", `Pipeline started · folder: ${path.basename(runDir)}`, { stage: "pipeline" });

    // ── 1. Split script into scenes ──────────────────────────────────────
    const scenes = await splitScript(runId, script);
    checkCancelled(runId);
    fs.writeFileSync(path.join(runDir, "scenes.json"), JSON.stringify(scenes, null, 2), "utf-8");

    // Reuse map
    const reuseRow = getReuseMapStmt.get(runId) as { reuse_map_json: string | null } | undefined;
    const reuseMap: Record<string, string> = reuseRow?.reuse_map_json
      ? (JSON.parse(reuseRow.reuse_map_json) as Record<string, string>)
      : {};
    const reuseCount = Object.keys(reuseMap).length;
    if (reuseCount > 0) {
      log(runId, "info", `Reusing ${reuseCount} clip${reuseCount === 1 ? "" : "s"} from Drive library`, { stage: "reuse", data: { reuseMap } });
    }

    // ── Concurrency setup ────────────────────────────────────────────────
    const keyCount = Math.max(1, getKeyCount());
    const ttsConcurrency = Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3")) * keyCount;
    const imageConcurrency = Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5")) * keyCount;
    const animConcurrency = Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3")) * keyCount;
    limitTts = pLimit(ttsConcurrency);
    limitImg = pLimit(imageConcurrency);
    limitAnim = pLimit(animConcurrency);

    // Batch size — how many scenes process concurrently. Each scene runs
    // TTS + Image + Animation all at once, so the real concurrency is
    // bounded by the pLimit limiters above, not the batch size. The batch
    // just controls how many scenes are "in flight" before we checkpoint.
    const BATCH_SIZE = Math.max(5, Number(getSetting("BATCH_SIZE") || "10"));

    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    const rawAnimRatio = Number(getSetting("ANIMATION_RATIO_PERCENT") || "100");
    const animRatio = rawAnimRatio <= 0 ? 100 : rawAnimRatio;
    const animDistRaw = (getSetting("ANIMATION_DISTRIBUTION") || "all").toLowerCase();
    const animDistribution =
      animDistRaw === "alternating" || animDistRaw === "random" || animDistRaw === "first-half"
        ? (animDistRaw as "alternating" | "random" | "first-half")
        : "all";
    const animTargets =
      animProvider !== "off"
        ? pickScenesToAnimate(scenes, animRatio, animDistribution)
        : new Set<number>();

    const realImageProvider = (getSetting("REAL_IMAGE_PROVIDER") || "all").toLowerCase();
    const realImageRatio = realImageProvider !== "off" ? Number(getSetting("REAL_IMAGE_RATIO_PERCENT") || "0") : 0;
    const realImageTargets =
      realImageRatio > 0 && realImageProvider !== "off"
        ? await pickScenesForRealImages(runId, scenes, realImageRatio)
        : new Set<number>();

    const stockProvider = (getSetting("STOCK_FOOTAGE_PROVIDER") || "all").toLowerCase();
    const stockRatio = stockProvider !== "off" ? Number(getSetting("STOCK_FOOTAGE_RATIO_PERCENT") || "0") : 0;
    const stockTargets =
      stockRatio > 0 && stockProvider !== "off"
        ? pickScenesForStock(scenes, stockRatio, realImageTargets)
        : new Set<number>();

    const totalBatches = Math.ceil(scenes.length / BATCH_SIZE);

    log(
      runId, "info",
      `Processing ${scenes.length} scenes in ${totalBatches} batch${totalBatches > 1 ? "es" : ""} of ${BATCH_SIZE}. ` +
      `Concurrency: TTS=${ttsConcurrency}, Image=${imageConcurrency}, Anim=${animConcurrency}. ` +
      `Animation: ${animTargets.size}/${scenes.length} scenes, Stock: ${stockTargets.size}/${scenes.length} scenes, Real Images: ${realImageTargets.size}/${scenes.length} scenes. Retries: ${MAX_RETRIES}/task.`,
      { stage: "pipeline" }
    );

    // ── Process scenes in batches ────────────────────────────────────────
    // Within each batch, every scene runs TTS + Image concurrently.
    // As soon as an image is ready, its animation starts immediately.
    // The batch completes only when ALL scenes in it have finished
    // (TTS + Image + Animation). No scene is ever skipped.
    const allResults: SceneResult[] = [];

    for (let batchStart = 0; batchStart < scenes.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, scenes.length);
      const batch = scenes.slice(batchStart, batchEnd);
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;

      checkCancelled(runId);

      // ── Per-scene key assignment (block split) ────────────────────────
      // Split scenes across keys in blocks: Key 1 gets scenes 0-4,
      // Key 2 gets scenes 5-9, etc. Each scene runs inside withSceneKey/withSceneKieKey()
      // so its keys are isolated — concurrent scenes can't overwrite each other.
      const keys69 = getKeyList();
      const keysKie = getKieKeyList();

      const scenesPerKey69 = keys69.length > 0
        ? Math.ceil(batch.length / keys69.length)
        : batch.length;
      const scenesPerKeyKie = keysKie.length > 0
        ? Math.ceil(batch.length / keysKie.length)
        : batch.length;

      const splitInfo = [
        keys69.length > 1 ? `${keys69.length} 69labs keys (${scenesPerKey69} scenes/key)` : null,
        keysKie.length > 1 ? `${keysKie.length} KieAI keys (${scenesPerKeyKie} scenes/key)` : null,
      ].filter(Boolean).join(" · ");

      log(
        runId, "info",
        `▶ Batch ${batchNum}/${totalBatches}: scenes #${batchStart}–#${batchEnd - 1} (${batch.length} scenes)` +
        (splitInfo ? ` · split across ${splitInfo}` : ""),
        { stage: "pipeline" }
      );

      // Process all scenes in this batch concurrently
      const batchPromises = batch.map((scene, batchIdx) => {
        // Block-based key: first N scenes → Key 1, next N → Key 2, etc.
        const keyIndex69 = keys69.length > 0
          ? Math.min(Math.floor(batchIdx / scenesPerKey69), keys69.length - 1)
          : -1;
        const sceneKey69 = keyIndex69 >= 0 ? keys69[keyIndex69] : null;

        const keyIndexKie = keysKie.length > 0
          ? Math.min(Math.floor(batchIdx / scenesPerKeyKie), keysKie.length - 1)
          : -1;
        const sceneKeyKie = keyIndexKie >= 0 ? keysKie[keyIndexKie] : null;

        if (sceneKey69) {
          log(runId, "debug",
            `Scene #${scene.index} → 69labs key …${sceneKey69.slice(-6)} (block ${keyIndex69 + 1}/${keys69.length})`,
            { stage: "pipeline" }
          );
        }
        if (sceneKeyKie) {
          log(runId, "debug",
            `Scene #${scene.index} → KieAI key …${sceneKeyKie.slice(-6)} (block ${keyIndexKie + 1}/${keysKie.length})`,
            { stage: "pipeline" }
          );
        }

        // Wrap in withSceneKey / withSceneKieKey so keys are isolated per async context
        const runScene = () => processScene(
          runId, scene,
          { audioDir, imgDir, animDir },
          { limitTts, limitImg, limitAnim },
          { animTargets, stockTargets, realImageTargets, reuseMap },
        );

        let wrapped = runScene;
        if (sceneKey69) {
          const prev = wrapped;
          wrapped = () => withSceneKey(sceneKey69!, prev);
        }
        if (sceneKeyKie) {
          const prev = wrapped;
          wrapped = () => withSceneKieKey(sceneKeyKie!, prev);
        }
        return wrapped();
      });

      // Wait for EVERY scene in the batch to complete
      const batchResults = await Promise.all(batchPromises);
      allResults.push(...batchResults);

      const batchDone = allResults.length;
      log(
        runId, "success",
        `✓ Batch ${batchNum}/${totalBatches} complete · ${batchDone}/${scenes.length} scenes done`,
        { stage: "pipeline" }
      );
    }

    // ── Pre-assembly validation & auto-repair ──────────────────────────
    // Verify every scene has its required files on disk. If anything is
    // missing or corrupt (e.g. 0-byte file from a network glitch), retry
    // generating just the missing piece before assembling.
    log(runId, "info", `▶ Validating ${allResults.length} scenes before assembly…`, { stage: "pipeline" });
    checkCancelled(runId);

    const REPAIR_MAX_ATTEMPTS = 3;
    let repairCount = 0;

    for (let i = 0; i < allResults.length; i++) {
      const r = allResults[i];
      const idx = r.scene.index;
      const issues: string[] = [];

      // Check audio file
      const audioOk = r.audio?.filePath && fs.existsSync(r.audio.filePath) &&
        fs.statSync(r.audio.filePath).size > 512;
      if (!audioOk) issues.push("audio");

      // Check image file (only required if we don't have a valid video clip from stock/reuse)
      const hasValidVideo = r.videoPath && fs.existsSync(r.videoPath) && fs.statSync(r.videoPath).size > 512;
      const imageOk = hasValidVideo || (r.imagePath && fs.existsSync(r.imagePath) && fs.statSync(r.imagePath).size > 512);
      if (!imageOk) issues.push("image");

      // Check video file (only if animation or stock was expected for this scene)
      const videoExpected = (animTargets.has(idx) || stockTargets.has(idx)) && r.videoPath;
      const videoOk = !videoExpected || (r.videoPath && fs.existsSync(r.videoPath) &&
        fs.statSync(r.videoPath).size > 512);
      if (!videoOk) issues.push("video");

      if (issues.length === 0) continue;

      // ── Repair missing pieces ─────────────────────────────────────────
      log(runId, "warn",
        `Scene #${idx} missing: ${issues.join(", ")} — attempting repair`,
        { stage: "pipeline" }
      );

      for (let attempt = 1; attempt <= REPAIR_MAX_ATTEMPTS; attempt++) {
        try {
          checkCancelled(runId);

          // Re-generate audio if missing
          if (issues.includes("audio")) {
            log(runId, "info", `Repair #${idx}: re-generating audio (attempt ${attempt})`, { stage: "pipeline" });
            const newAudio = await withRetry(runId, `Repair TTS #${idx}`, () =>
              synthesizeScene(runId, r.scene, audioDir)
            );
            allResults[i] = { ...allResults[i], audio: newAudio };
          }

          // Re-generate image if missing
          if (issues.includes("image")) {
            log(runId, "info", `Repair #${idx}: re-generating image (attempt ${attempt})`, { stage: "pipeline" });
            const newImage = await withRetry(runId, `Repair Image #${idx}`, () =>
              generateImage(runId, r.scene, imgDir)
            );
            allResults[i] = { ...allResults[i], imagePath: newImage.filePath, _imgProviderJobId: newImage.providerJobId, _imgProvider: newImage.provider };
          }

          // Re-generate video if missing and was expected
          if (issues.includes("video")) {
            log(runId, "info", `Repair #${idx}: re-generating video (attempt ${attempt})`, { stage: "pipeline" });
            try {
              const curResult = allResults[i];
              let newVideo: string | null = null;
              if (stockTargets.has(idx)) {
                const stockPath = path.join(animDir, `stock_scene_${String(idx).padStart(3, "0")}.mp4`);
                newVideo = await withRetry(runId, `Repair Stock #${idx}`, () =>
                  fetchStockVideo(runId, r.scene, stockPath)
                );
              }
              if (!newVideo && animTargets.has(idx)) {
                newVideo = await withRetry(runId, `Repair Anim #${idx}`, () =>
                  animateScene(runId, r.scene, curResult.imagePath, animDir, {
                    providerJobId: curResult._imgProviderJobId,
                    imageProvider: curResult._imgProvider,
                    audioPath: curResult.audio?.filePath,
                  })
                );
              }
              allResults[i] = { ...allResults[i], videoPath: newVideo };
            } catch (animErr) {
              if (animErr instanceof CancelledError) throw animErr;
              // Animation repair failure is non-fatal — Ken-Burns fallback
              const msg = animErr instanceof Error ? animErr.message : String(animErr);
              log(runId, "warn", `Repair video #${idx} failed, will use Ken-Burns: ${msg.slice(0, 150)}`, { stage: "pipeline" });
              allResults[i] = { ...allResults[i], videoPath: null };
            }
          }

          repairCount++;
          log(runId, "success", `✓ Repaired scene #${idx}`, { stage: "pipeline" });
          break; // repair succeeded, move to next scene
        } catch (repairErr) {
          if (repairErr instanceof CancelledError) throw repairErr;
          const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
          if (attempt < REPAIR_MAX_ATTEMPTS) {
            log(runId, "warn", `Repair #${idx} attempt ${attempt}/${REPAIR_MAX_ATTEMPTS} failed: ${msg.slice(0, 150)} — retrying`, { stage: "pipeline" });
            await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
          } else {
            // Can't repair this scene — throw and stop pipeline
            throw new Error(`Scene #${idx} could not be repaired after ${REPAIR_MAX_ATTEMPTS} attempts: ${msg.slice(0, 200)}`);
          }
        }
      }
    }

    if (repairCount > 0) {
      log(runId, "success", `✓ Validation complete: repaired ${repairCount} scene(s)`, { stage: "pipeline" });
    } else {
      log(runId, "success", `✓ Validation complete: all ${allResults.length} scenes verified`, { stage: "pipeline" });
    }

    // ── Assembly ─────────────────────────────────────────────────────────
    log(runId, "info", `▶ Assembling ${allResults.length} scenes into final video...`, { stage: "pipeline" });
    checkCancelled(runId);

    const finalPath = await assembleVideo(runId, allResults, runDir);

    // ── Drive sync (optional, non-fatal) ─────────────────────────────────
    try {
      await syncRunToDrive(runId, allResults, runDir, finalPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Drive sync failed (local files preserved): ${msg}`, { stage: "gdrive" });
    }

    // Clear batch key so non-pipeline 69labs/kieai calls aren't affected
    setBatchKey(null);
    setBatchKieKey(null);

    updateRun.run("done", finalPath, runId);
    log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
  } catch (e) {
    setBatchKey(null);
    setBatchKieKey(null);
    const cancelErr = e instanceof CancelledError ? e : new CancelledError("Pipeline stopped");
    limitTts?.clearQueue(cancelErr);
    limitImg?.clearQueue(cancelErr);
    limitAnim?.clearQueue(cancelErr);
    if (e instanceof CancelledError) {
      log(runId, "warn", "Pipeline cancelled by user", { stage: "pipeline" });
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "error", `Pipeline crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, runId);
    }
  }
}

// ── Process a single scene ──────────────────────────────────────────────────
// Runs TTS + Image concurrently. As soon as the image is ready, starts
// animation (if needed). ALL tasks retry up to MAX_RETRIES times.
// This function NEVER returns null — it either succeeds or throws.

async function processScene(
  runId: string,
  scene: Scene,
  dirs: { audioDir: string; imgDir: string; animDir: string },
  limits: {
    limitTts: LimitFunction;
    limitImg: LimitFunction;
    limitAnim: LimitFunction;
  },
  opts: {
    animTargets: Set<number>;
    stockTargets: Set<number>;
    realImageTargets?: Set<number>;
    reuseMap: Record<string, string>;
  },
): Promise<SceneResult> {
  checkCancelled(runId);
  // For stock target scenes, we attempt to source a real stock video first.
  // This avoids wasting image generation credits if a valid stock clip is found!
  const isStockTarget = opts.stockTargets && opts.stockTargets.has(scene.index);
  const isRealImageTarget = opts.realImageTargets && opts.realImageTargets.has(scene.index);

  let audio: TtsResult;
  let image: { filePath: string; providerJobId?: string; provider?: string; realImageTag?: string; motionType?: "zoom-in" | "zoom-out" | "slide-up" | "slide-down" | "slide-left" | "slide-right" } | null = null;
  let videoPath: string | null = null;
  const reuseFileId = opts.reuseMap[String(scene.index)];

  if (isStockTarget) {
    // Run TTS and Stock Video fetch concurrently! Skip AI image generation!
    const [audioRes, stockRes] = await Promise.all([
      limits.limitTts(() =>
        withRetry(runId, `TTS #${scene.index}`, () =>
          synthesizeScene(runId, scene, dirs.audioDir)
        )
      ),
      (async () => {
        if (reuseFileId) {
          try {
            return await downloadReusedClip(runId, scene, reuseFileId, dirs.animDir);
          } catch (e) {
            if (e instanceof CancelledError) throw e;
            log(runId, "warn", `reuse #${scene.index} failed, fetching stock: ${(e as Error).message}`, { stage: "reuse" });
          }
        }
        try {
          const stockPath = path.join(dirs.animDir, `stock_scene_${String(scene.index).padStart(3, "0")}.mp4`);
          return await limits.limitAnim(() =>
            withRetry(runId, `Stock #${scene.index}`, () =>
              fetchStockVideo(runId, scene, stockPath)
            )
          );
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          log(runId, "warn", `Stock #${scene.index} failed, will fallback to AI image: ${msg.slice(0, 150)}`, { stage: "animate" });
          return null;
        }
      })(),
    ]);

    audio = audioRes;
    videoPath = stockRes;

    if (!videoPath) {
      checkCancelled(runId);
      log(runId, "info", `Scene #${scene.index} stock footage unavailable, generating fallback AI image...`, { stage: "animate" });
      image = await limits.limitImg(() =>
        withRetry(runId, `Image #${scene.index}`, async () => {
          try {
            return await generateImage(runId, scene, dirs.imgDir);
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            const repairedPrompt = await directorRepairVisualPrompt(runId, scene.index, scene.visual_prompt, (err as Error).message, scene.text);
            return await generateImage(runId, { ...scene, visual_prompt: repairedPrompt }, dirs.imgDir);
          }
        })
      );
    } else {
      image = { filePath: "" };
    }
  } else {
    const [audioRes, imageRes] = await Promise.all([
      limits.limitTts(() =>
        withRetry(runId, `TTS #${scene.index}`, () =>
          synthesizeScene(runId, scene, dirs.audioDir)
        )
      ),
      limits.limitImg(async () => {
        if (isRealImageTarget) {
          const outPath = path.join(dirs.imgDir, `scene_${String(scene.index).padStart(3, "0")}.jpg`);
          const realImgRes = await fetchRealImage(runId, scene, outPath);
          if (realImgRes) {
            const realImageTag = `REAL IMAGE: ${realImgRes.title.slice(0, 50)} (${realImgRes.source})`;
            log(
              runId,
              "info",
              `📷 [REAL IMAGE] Scene #${scene.index}: "${realImgRes.title}" (${realImgRes.source})`,
              { stage: "real-image" }
            );
            return { filePath: realImgRes.filePath, provider: "NASA/Wikimedia", realImageTag, motionType: realImgRes.motionType };
          }
        }
        return await withRetry(runId, `Image #${scene.index}`, async () => {
          try {
            return await generateImage(runId, scene, dirs.imgDir);
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            const repairedPrompt = await directorRepairVisualPrompt(runId, scene.index, scene.visual_prompt, (err as Error).message, scene.text);
            return await generateImage(runId, { ...scene, visual_prompt: repairedPrompt }, dirs.imgDir);
          }
        });
      }),
    ]);
    audio = audioRes;
    image = imageRes;

    if (reuseFileId) {
      try {
        videoPath = await downloadReusedClip(runId, scene, reuseFileId, dirs.animDir);
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        log(runId, "warn", `reuse #${scene.index} failed, generating fresh: ${(e as Error).message}`, { stage: "reuse" });
      }
    }
  }

  // CRITICAL: If image provider is "NASA/Wikimedia", do NOT animate it with Veo/Runway!
  // This ensures the pipeline does not remove/replace our real photograph with synthetic AI footage.
  // Instead, the real photograph is preserved with Ken-Burns pan/zoom and displays the "REAL IMAGE" badge.
  if (!videoPath && opts.animTargets.has(scene.index) && image && image.filePath && image.provider !== "NASA/Wikimedia") {
    checkCancelled(runId);
    try {
      videoPath = await limits.limitAnim(() =>
        withRetry(runId, `Anim #${scene.index}`, () =>
          animateScene(runId, scene, image!.filePath, dirs.animDir, {
            providerJobId: image!.providerJobId,
            imageProvider: image!.provider,
            audioPath: audio.filePath,
          })
        )
      );
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Anim #${scene.index} failed after retries, using Ken-Burns: ${msg.slice(0, 200)}`, { stage: "animate" });
    }
  }

  return {
    scene,
    imagePath: image?.filePath || "",
    videoPath,
    audio,
    _imgProviderJobId: image?.providerJobId,
    _imgProvider: image?.provider,
    realImageTag: image?.realImageTag,
    motionType: image?.motionType,
  };
}
