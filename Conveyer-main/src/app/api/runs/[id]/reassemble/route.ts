import { NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { log } from "@/lib/logger";
import { assembleVideo, type AssembleInput } from "@/lib/services/video-assemble";
import { splitScript, type Scene } from "@/lib/services/scene-split";
import { getRunDir } from "@/lib/run-paths";

const getRun = db.prepare("SELECT id, script FROM runs WHERE id = ?");
const updateRun = db.prepare(
  "UPDATE runs SET status = ?, output_path = ?, updated_at = datetime('now') WHERE id = ?"
);

/**
 * Reassemble video from existing pipeline assets without generating anything afresh.
 *  1. Load scenes.json (or split script if missing).
 *  2. For each scene, find any existing audio (.mp3), image (.png/.jpg/.jpeg), or video (.mp4).
 *  3. Preserve real image badges & motion metadata if the scene has a factual real photograph.
 *  4. Run final assembly with the existing assets immediately.
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
      log(id, "info", "Reassembling existing pipeline assets (no new generation)...", { stage: "pipeline" });

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

      // ── Helper searchers ──────────────────────────────────────────────
      function audioPath(idx: number) {
        return path.join(audioDir, `scene_${String(idx).padStart(3, "0")}.mp3`);
      }
      function fileExists(p: string) {
        return fs.existsSync(p) && fs.statSync(p).size > 1024;
      }
      function findExistingImagePath(idx: number): string | null {
        const pad = String(idx).padStart(3, "0");
        const candidates = [
          path.join(imgDir, `scene_${pad}_clean.jpg`),
          path.join(imgDir, `scene_${pad}.jpg`),
          path.join(imgDir, `scene_${pad}.jpeg`),
          path.join(imgDir, `scene_${pad}.png`),
        ];
        for (const c of candidates) {
          if (fileExists(c)) return c;
        }
        return null;
      }
      function findExistingVideoPath(idx: number): string | null {
        const pad = String(idx).padStart(3, "0");
        const candidates = [
          path.join(animDir, `scene_${pad}.mp4`),
          path.join(animDir, `stock_scene_${pad}.mp4`),
        ];
        for (const c of candidates) {
          if (fileExists(c)) return c;
        }
        return null;
      }
      function getExistingRealImageMetadata(idx: number, imgPath: string): { realImageTag?: string; motionType?: "zoom-in" | "zoom-out" | "slide-up" | "slide-down" | "slide-left" | "slide-right" } {
        const pad = String(idx).padStart(3, "0");
        const metaPath = path.join(imgDir, `scene_${pad}.real.json`);
        if (fs.existsSync(metaPath)) {
          try {
            const data = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
            return { realImageTag: data.realImageTag, motionType: data.motionType };
          } catch {}
        }
        const lower = imgPath.toLowerCase();
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
          try {
            const logRow = db.prepare("SELECT message FROM run_logs WHERE run_id = ? AND stage = 'real-image' AND message LIKE ? ORDER BY id DESC LIMIT 1")
              .get(id, `%Scene #${idx}:%`) as { message: string } | undefined;
            if (logRow?.message) {
              const titleMatch = /["“]([^"”]+)["”]\s*\(([^)]+)\)/.exec(logRow.message) || /["“]([^"”]+)["”]/.exec(logRow.message);
              if (titleMatch) {
                const title = titleMatch[1];
                const source = titleMatch[2] || "NASA/Wikimedia";
                const motionMatch = /\((zoom-in|zoom-out|slide-up|slide-down|slide-left|slide-right)\)/.exec(logRow.message);
                return {
                  realImageTag: `REAL IMAGE: ${title.slice(0, 50)} (${source})`,
                  motionType: (motionMatch?.[1] as any) || "zoom-in",
                };
              }
            }
          } catch {}
        }
        return {};
      }

      // ── 2. Assemble — strictly use all available existing assets ──────
      const inputs: AssembleInput[] = [];
      let videoCount = 0;
      let realImgCount = 0;

      for (const s of scenes) {
        const ap = audioPath(s.index);
        const ip = findExistingImagePath(s.index);
        const vp = findExistingVideoPath(s.index);

        if (!fileExists(ap) || (!ip && !vp)) {
          log(id, "warn", `Scene #${s.index} missing audio or image/video on disk — skipping from assembly`, { stage: "assemble" });
          continue;
        }
        const stat = fs.statSync(ap);
        if (vp) videoCount++;

        const { realImageTag, motionType } = ip ? getExistingRealImageMetadata(s.index, ip) : {};
        if (realImageTag) realImgCount++;

        inputs.push({
          scene: s,
          imagePath: ip || "",
          videoPath: vp || null,
          audio: { filePath: ap, durationSec: Math.max(1, stat.size / 16000) },
          realImageTag,
          motionType,
        });
      }

      log(id, "info", `Assembling ${inputs.length}/${scenes.length} existing scenes (${videoCount} animation videos, ${realImgCount} real images)...`, { stage: "assemble" });
      if (inputs.length === 0) throw new Error("No complete scenes found on disk");

      const finalPath = await assembleVideo(id, inputs, runDir);
      updateRun.run("done", finalPath, id);
      log(id, "success", `Reassemble complete (${inputs.length}/${scenes.length} scenes assembled, ${videoCount} videos, ${realImgCount} real photos)`, {
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

