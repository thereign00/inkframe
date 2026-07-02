import path from "node:path";
import fs from "node:fs";
import db from "./db";
import { log } from "./logger";
import { getSetting } from "./settings";
import { getRunDir } from "./run-paths";
import { pLimit } from "./plimit";
import { splitScript, type Scene } from "./services/scene-split";
import { synthesizeScene, type TtsResult } from "./services/tts";
import { generateImage, type ImageResult } from "./services/image-gen";
import { animateScene, pickScenesToAnimate } from "./services/img2vid";
import { assembleVideo, type AssembleInput } from "./services/video-assemble";
import { getKeyCount, getKeyList, setBatchKey, withSceneKey } from "./services/labs69";
import { syncRunToDrive } from "./services/run-upload";
import { downloadReusedClip } from "./services/reuse";
import { syncActiveChannelToLive } from "./channels";
import { checkCancelled, clearCancelled, CancelledError } from "./cancellation";

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
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      checkCancelled(runId);
      return await fn();
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_MS * Math.pow(2, attempt - 1); // 3s, 6s, 12s, 24s
        log(
          runId, "warn",
          `${label} failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${(delay / 1000).toFixed(0)}s: ${msg.slice(0, 200)}`,
          { stage: "pipeline" }
        );
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${msg.slice(0, 300)}`);
      }
    }
  }
  throw new Error("unreachable");
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

  try {
    clearCancelled(runId);
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
    const limitTts = pLimit(ttsConcurrency);
    const limitImg = pLimit(imageConcurrency);
    const limitAnim = pLimit(animConcurrency);

    // Batch size — how many scenes process concurrently. Each scene runs
    // TTS + Image + Animation all at once, so the real concurrency is
    // bounded by the pLimit limiters above, not the batch size. The batch
    // just controls how many scenes are "in flight" before we checkpoint.
    const BATCH_SIZE = Math.max(5, Number(getSetting("BATCH_SIZE") || "10"));

    const animProvider = (getSetting("ANIMATION_PROVIDER") || "69labs").toLowerCase();
    const animRatio = Number(getSetting("ANIMATION_RATIO_PERCENT") || "50");
    const animDistRaw = (getSetting("ANIMATION_DISTRIBUTION") || "first-half").toLowerCase();
    const animDistribution =
      animDistRaw === "alternating" || animDistRaw === "random" || animDistRaw === "all"
        ? (animDistRaw as "alternating" | "random" | "all")
        : "first-half";
    const animTargets =
      animProvider !== "off"
        ? pickScenesToAnimate(scenes, animRatio, animDistribution)
        : new Set<number>();

    const totalBatches = Math.ceil(scenes.length / BATCH_SIZE);

    log(
      runId, "info",
      `Processing ${scenes.length} scenes in ${totalBatches} batch${totalBatches > 1 ? "es" : ""} of ${BATCH_SIZE}. ` +
      `Concurrency: TTS=${ttsConcurrency}, Image=${imageConcurrency}, Anim=${animConcurrency}. ` +
      `Animation: ${animTargets.size}/${scenes.length} scenes. Retries: ${MAX_RETRIES}/task.`,
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
      // Key 2 gets scenes 5-9, etc. Each scene runs inside withSceneKey()
      // so its key is isolated — concurrent scenes can't overwrite each other.
      const keys69 = getKeyList();
      const scenesPerKey = keys69.length > 0
        ? Math.ceil(batch.length / keys69.length)
        : batch.length;

      log(
        runId, "info",
        `▶ Batch ${batchNum}/${totalBatches}: scenes #${batchStart}–#${batchEnd - 1} (${batch.length} scenes)` +
        (keys69.length > 1
          ? ` · split across ${keys69.length} keys (${scenesPerKey} scenes/key)`
          : ""),
        { stage: "pipeline" }
      );

      // Process all scenes in this batch concurrently
      const batchPromises = batch.map((scene, batchIdx) => {
        // Block-based key: first N scenes → Key 1, next N → Key 2, etc.
        const keyIndex = keys69.length > 0
          ? Math.min(Math.floor(batchIdx / scenesPerKey), keys69.length - 1)
          : -1;
        const sceneKey = keyIndex >= 0 ? keys69[keyIndex] : null;

        if (sceneKey) {
          log(runId, "debug",
            `Scene #${scene.index} → key …${sceneKey.slice(-6)} (block ${keyIndex + 1}/${keys69.length})`,
            { stage: "pipeline" }
          );
        }

        // Wrap in withSceneKey so the key is isolated per async context
        const runScene = () => processScene(
          runId, scene,
          { audioDir, imgDir, animDir },
          { limitTts, limitImg, limitAnim },
          { animTargets, reuseMap },
        );

        return sceneKey
          ? withSceneKey(sceneKey, runScene)
          : runScene();
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

      // Check image file
      const imageOk = r.imagePath && fs.existsSync(r.imagePath) &&
        fs.statSync(r.imagePath).size > 512;
      if (!imageOk) issues.push("image");

      // Check video file (only if animation was expected for this scene)
      const videoExpected = animTargets.has(idx) && r.videoPath;
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
            log(runId, "info", `Repair #${idx}: re-generating animation (attempt ${attempt})`, { stage: "pipeline" });
            try {
              const curResult = allResults[i];
              const newVideo = await withRetry(runId, `Repair Anim #${idx}`, () =>
                animateScene(runId, r.scene, curResult.imagePath, animDir, {
                  providerJobId: curResult._imgProviderJobId,
                  imageProvider: curResult._imgProvider,
                  audioPath: curResult.audio?.filePath,
                })
              );
              allResults[i] = { ...allResults[i], videoPath: newVideo };
            } catch (animErr) {
              // Animation repair failure is non-fatal — Ken-Burns fallback
              const msg = animErr instanceof Error ? animErr.message : String(animErr);
              log(runId, "warn", `Repair anim #${idx} failed, will use Ken-Burns: ${msg.slice(0, 150)}`, { stage: "pipeline" });
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

    // Clear batch key so non-pipeline 69labs calls aren't affected
    setBatchKey(null);

    updateRun.run("done", finalPath, runId);
    log(runId, "success", "Pipeline complete", { stage: "pipeline", data: { finalPath } });
  } catch (e) {
    setBatchKey(null);
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
    limitTts: ReturnType<typeof pLimit>;
    limitImg: ReturnType<typeof pLimit>;
    limitAnim: ReturnType<typeof pLimit>;
  },
  opts: {
    animTargets: Set<number>;
    reuseMap: Record<string, string>;
  },
): Promise<SceneResult> {
  // TTS and Image run concurrently, each with their own retries
  const [audio, image] = await Promise.all([
    limits.limitTts(() =>
      withRetry(runId, `TTS #${scene.index}`, () =>
        synthesizeScene(runId, scene, dirs.audioDir)
      )
    ),
    limits.limitImg(() =>
      withRetry(runId, `Image #${scene.index}`, () =>
        generateImage(runId, scene, dirs.imgDir)
      )
    ),
  ]);

  // Animation — starts as soon as image is ready (which is now).
  // Non-fatal: falls back to Ken-Burns if all retries fail.
  let videoPath: string | null = null;
  const reuseFileId = opts.reuseMap[String(scene.index)];

  if (reuseFileId) {
    try {
      videoPath = await downloadReusedClip(runId, scene, reuseFileId, dirs.animDir);
    } catch (e) {
      log(runId, "warn", `reuse #${scene.index} failed, generating fresh: ${(e as Error).message}`, { stage: "reuse" });
    }
  }

  if (!videoPath && opts.animTargets.has(scene.index)) {
    try {
      videoPath = await limits.limitAnim(() =>
        withRetry(runId, `Anim #${scene.index}`, () =>
          animateScene(runId, scene, image.filePath, dirs.animDir, {
            providerJobId: image.providerJobId,
            imageProvider: image.provider,
            audioPath: audio.filePath,
          })
        )
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(runId, "warn", `Anim #${scene.index} failed after retries, using Ken-Burns: ${msg.slice(0, 200)}`, { stage: "animate" });
    }
  }

  return {
    scene,
    imagePath: image.filePath,
    videoPath,
    audio,
    _imgProviderJobId: image.providerJobId,
    _imgProvider: image.provider,
  };
}
