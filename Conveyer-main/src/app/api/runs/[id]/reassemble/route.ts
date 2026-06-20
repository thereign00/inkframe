import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { log } from "@/lib/logger";
import { assembleVideo, type AssembleInput } from "@/lib/services/video-assemble";
import { synthesizeScene } from "@/lib/services/tts";
import { generateImage, type ImageResult } from "@/lib/services/image-gen";
import { animateScene, pickScenesToAnimate } from "@/lib/services/img2vid";
import { splitScript, type Scene } from "@/lib/services/scene-split";
import { getRunDir } from "@/lib/run-paths";
import { pLimit } from "@/lib/plimit";
import { getSetting } from "@/lib/settings";

const getRun = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

/**
 * Smart reassemble:
 *  1. Load scenes.json if it exists. Otherwise re-split the script.
 *  2. For scenes missing an image or audio file, regenerate just that asset.
 *  3. For scenes missing a video (if animations were enabled), generate it.
 *  4. Re-run final assembly with the complete set (images + videos + audio).
 */
export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const row = getRun.get(id) as { id: string; script: string } | undefined;
  if (!row) return NextResponse.json({ error: "run not found" }, { status: 404 });

  const runDir = getRunDir(id);
  const audioDir = path.join(runDir, "audio");
  const imgDir = path.join(runDir, "images");
  const animDir = path.join(runDir, "animations");
  if (!fs.existsSync(audioDir) && !fs.existsSync(imgDir)) {
    return NextResponse.json({ error: "no assets on disk" }, { status: 400 });
  }
  for (const d of [audioDir, imgDir, animDir]) fs.mkdirSync(d, { recursive: true });

  (async () => {
    try {
      updateRun.run("running", null, id);
      log(id, "info", "Smart reassemble: checking assets", { stage: "pipeline" });

      // ── 1. Get scenes ─────────────────────────────────────────────────
      let scenes: Scene[];
      const scenesFile = path.join(runDir, "scenes.json");
      if (fs.existsSync(scenesFile)) {
        scenes = JSON.parse(fs.readFileSync(scenesFile, "utf-8"));
        log(id, "info", `Loaded ${scenes.length} scenes from scenes.json`, { stage: "pipeline" });
      } else {
        log(id, "info", "scenes.json missing — re-splitting script via Gemini", { stage: "pipeline" });
        scenes = await splitScript(id, row.script);
        fs.writeFileSync(scenesFile, JSON.stringify(scenes, null, 2), "utf-8");
      }

      // ── Helper paths ──────────────────────────────────────────────────
      function audioPath(idx: number) {
        return path.join(audioDir, `scene_${String(idx).padStart(3, "0")}.mp3`);
      }
      function imgPath(idx: number) {
        return path.join(imgDir, `scene_${String(idx).padStart(3, "0")}.png`);
      }
      function vidPath(idx: number) {
        return path.join(animDir, `scene_${String(idx).padStart(3, "0")}.mp4`);
      }
      function fileExists(p: string) {
        return fs.existsSync(p) && fs.statSync(p).size > 1024;
      }

      // ── 2. Fill missing images & audio ────────────────────────────────
      const missingAudio = scenes.filter((s) => !fileExists(audioPath(s.index)));
      const missingImage = scenes.filter((s) => !fileExists(imgPath(s.index)));

      if (missingAudio.length || missingImage.length) {
        log(
          id, "info",
          `Filling gaps: ${missingImage.length} images, ${missingAudio.length} audio files`,
          { stage: "pipeline" }
        );
        const limitImg = pLimit(Math.max(1, Number(getSetting("IMAGE_CONCURRENCY") || "5")));
        const limitTts = pLimit(Math.max(1, Number(getSetting("TTS_CONCURRENCY") || "3")));

        await Promise.all([
          ...missingAudio.map((s) =>
            limitTts(() =>
              synthesizeScene(id, s, audioDir).catch((e) => {
                log(id, "warn", `Failed to regenerate audio #${s.index}: ${(e as Error).message}`, {
                  stage: "tts",
                });
              })
            )
          ),
          ...missingImage.map((s) =>
            limitImg(() =>
              generateImage(id, s, imgDir).catch((e) => {
                log(id, "warn", `Failed to regenerate image #${s.index}: ${(e as Error).message}`, {
                  stage: "image",
                });
              })
            )
          ),
        ]);
      }

      // ── 3. Fill missing animations (if enabled in settings) ───────────
      const animProvider = (getSetting("ANIMATION_PROVIDER") || "off").toLowerCase();
      if (animProvider !== "off") {
        const animRatio = Number(getSetting("ANIMATION_RATIO_PERCENT") || "50");
        const animDistRaw = (getSetting("ANIMATION_DISTRIBUTION") || "first-half").toLowerCase();
        const animDistribution =
          animDistRaw === "alternating" || animDistRaw === "random" || animDistRaw === "all"
            ? (animDistRaw as "alternating" | "random" | "all")
            : "first-half";

        // Determine which scenes SHOULD have animations
        const animTargets = pickScenesToAnimate(scenes, animRatio, animDistribution);

        // Find scenes that should have animations but don't
        const missingVideo = scenes.filter(
          (s) => animTargets.has(s.index) && !fileExists(vidPath(s.index)) && fileExists(imgPath(s.index))
        );

        if (missingVideo.length > 0) {
          log(
            id, "info",
            `Filling ${missingVideo.length} missing animations (${animTargets.size} total targets, provider: ${animProvider})`,
            { stage: "animate" }
          );
          const limitAnim = pLimit(Math.max(1, Number(getSetting("ANIMATION_CONCURRENCY") || "3")));

          await Promise.all(
            missingVideo.map((s) =>
              limitAnim(() =>
                animateScene(id, s, imgPath(s.index), animDir).catch((e) => {
                  log(id, "warn",
                    `Failed to generate animation #${s.index}: ${(e as Error).message.slice(0, 200)}`,
                    { stage: "animate" }
                  );
                })
              )
            )
          );
        } else if (animTargets.size > 0) {
          log(id, "info", `All ${animTargets.size} animation targets already have videos`, { stage: "animate" });
        }
      }

      // ── 4. Assemble — include all available assets ────────────────────
      const inputs: AssembleInput[] = [];
      let videoCount = 0;
      for (const s of scenes) {
        const ap = audioPath(s.index);
        const ip = imgPath(s.index);
        if (!fs.existsSync(ap) || !fs.existsSync(ip)) {
          log(id, "warn", `Scene #${s.index} still incomplete — skipping`, { stage: "assemble" });
          continue;
        }
        const stat = fs.statSync(ap);

        // Include animation video if available
        const vp = vidPath(s.index);
        const hasVideo = fileExists(vp);
        if (hasVideo) videoCount++;

        inputs.push({
          scene: s,
          imagePath: ip,
          videoPath: hasVideo ? vp : null,
          audio: { filePath: ap, durationSec: Math.max(1, stat.size / 16000) },
        });
      }

      if (videoCount > 0) {
        log(id, "info", `Including ${videoCount}/${inputs.length} animation videos in assembly`, { stage: "assemble" });
      }
      if (inputs.length === 0) throw new Error("No complete scenes found");

      const finalPath = await assembleVideo(id, inputs, runDir);
      updateRun.run("done", finalPath, id);
      log(id, "success", `Reassemble complete (${inputs.length}/${scenes.length} scenes, ${videoCount} videos)`, {
        stage: "pipeline",
        data: { finalPath },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(id, "error", `Reassemble crashed: ${msg}`, { stage: "pipeline" });
      updateRun.run("error", null, id);
    }
  })().catch(() => {});

  return NextResponse.json({ ok: true });
}
