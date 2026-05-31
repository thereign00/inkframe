"use client";
import { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";

// Rough estimate: TTS narration averages ~150 words per minute
const WORDS_PER_MINUTE = 150;

// Per-job time estimates (in seconds), empirically tuned from production runs
const AVG_IMAGE_SEC = 90;      // nano-banana-pro at 1k averages ~60-120s
const AVG_VEO_VIDEO_SEC = 75;  // Veo 3.1 Fast averages ~60-90s
const AVG_TTS_SEC = 4;         // short scene narration through 69labs is ~2-6s
const AVG_CLIP_RENDER_SEC = 8; // x264 veryfast render per Ken-Burns / animated clip
const XFADE_FRAMES_PER_SEC = 1800; // approx encoding speed for xfade chain on one core

interface StatsResp {
  keyCount: number;
  perKey: { image: number; tts: number; anim: number };
  total: { image: number; tts: number; anim: number };
  assembleConcurrency: number;
  xfadeChunks: number;
  animationEnabled: boolean;
  animationRatio: number;
}

export default function NewRunPage() {
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const scriptStats = useMemo(() => {
    const text = script.trim();
    const words = text ? text.split(/\s+/).length : 0;
    const chars = text.length;
    const seconds = (words / WORDS_PER_MINUTE) * 60;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return {
      words,
      chars,
      duration: words === 0 ? "—" : (m > 0 ? `~${m} min ${s} s` : `~${s} s`),
      scenes: Math.max(1, Math.round(seconds / 5)), // ~5 sec per scene
      narrationSeconds: seconds,
    };
  }, [script]);

  /**
   * Rough generation-time estimate.
   *
   * Breaks down into three phases that overlap in the pipeline:
   *  • Parallel generation phase: bounded by the slowest of (image, anim, TTS)
   *  • Per-clip FFmpeg render: bounded by ASSEMBLE_CONCURRENCY
   *  • Final xfade pass: bounded by xfade chunk count and total video duration
   *
   * Numbers are intentionally pessimistic so a successful run is usually
   * faster than predicted.
   */
  const timeEstimate = useMemo(() => {
    if (!stats || scriptStats.scenes === 0) return null;
    const N = scriptStats.scenes;

    // Phase 1 — generation. All three streams run in parallel; bottleneck is the slowest.
    const imageMin = (Math.ceil(N / stats.total.image) * AVG_IMAGE_SEC) / 60;
    const animScenes = stats.animationEnabled ? Math.ceil(N * (stats.animationRatio / 100)) : 0;
    const animMin =
      animScenes > 0 ? (Math.ceil(animScenes / stats.total.anim) * AVG_VEO_VIDEO_SEC) / 60 : 0;
    const ttsMin = (Math.ceil(N / stats.total.tts) * AVG_TTS_SEC) / 60;
    const phase1 = Math.max(imageMin, animMin, ttsMin);

    // Phase 2 — per-clip FFmpeg render
    const phase2 = (Math.ceil(N / stats.assembleConcurrency) * AVG_CLIP_RENDER_SEC) / 60;

    // Phase 3 — final xfade. xfade speed limited by serial filter chain.
    // With chunked xfade, total frames divided across chunks running in parallel.
    const totalFrames = scriptStats.narrationSeconds * 30; // assume 30 fps
    const chunks = stats.xfadeChunks;
    const phase3 = (totalFrames / chunks / XFADE_FRAMES_PER_SEC) / 60;

    const total = phase1 + phase2 + phase3;
    return {
      total,
      phase1,
      phase2,
      phase3,
      imageMin,
      animMin,
      ttsMin,
      animScenes,
    };
  }, [stats, scriptStats]);

  async function start() {
    setBusy(true);
    try {
      const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, script }),
      });
      if (!r.ok) {
        alert(`Error: ${await r.text()}`);
        return;
      }
      const data = (await r.json()) as { id: string };
      router.push(`/runs/${data.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>New run</h1>
      <p style={{ color: "#8a8aa0", marginBottom: 16 }}>
        Paste a script — the system will split it into scenes, generate voiceover and imagery for
        each, then assemble the final video.
      </p>

      <div className="card" style={{ display: "grid", gap: 12 }}>
        <div>
          <label className="label">Title (optional)</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Solar Storm Test 1"
          />
        </div>
        <div>
          <label className="label">Script</label>
          <textarea
            className="textarea"
            rows={14}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Paste the full script here..."
          />
          <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 13, color: "#8a8aa0", flexWrap: "wrap" }}>
            <span><strong style={{ color: "#e8e8f0" }}>{scriptStats.words}</strong> words</span>
            <span><strong style={{ color: "#e8e8f0" }}>{scriptStats.chars}</strong> chars</span>
            <span>≈ <strong style={{ color: "#7c5cff" }}>{scriptStats.duration}</strong> of final video</span>
            <span>≈ <strong style={{ color: "#e8e8f0" }}>{scriptStats.scenes}</strong> scenes</span>
          </div>
        </div>
        <div>
          <button className="btn" onClick={start} disabled={busy || !script.trim()}>
            {busy ? "Starting..." : "Run pipeline"}
          </button>
        </div>
      </div>

      {timeEstimate && stats && scriptStats.words > 0 && (
        <div
          className="card"
          style={{
            marginTop: 16,
            background: "linear-gradient(90deg, #14141d, #1a1a28)",
            borderColor: stats.keyCount >= 2 ? "#3a5a3a" : undefined,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
            ⏱️ Estimated generation time
            <span style={{ color: "#7c5cff", fontSize: 18 }}>
              ~{timeEstimate.total < 1 ? "<1" : Math.round(timeEstimate.total)} min
            </span>
          </div>
          <div style={{ color: "#9090a8", fontSize: 13, lineHeight: 1.7 }}>
            <div>
              <strong style={{ color: "#e8e8f0" }}>Parallel generation</strong> (TTS + images
              {stats.animationEnabled ? ` + ${timeEstimate.animScenes} video clips` : ""}):
              ~{Math.round(timeEstimate.phase1)} min
              <span style={{ color: "#5a5a70", marginLeft: 8 }}>
                with {stats.keyCount} {stats.keyCount === 1 ? "key" : "keys"} ({stats.total.image} img / {stats.total.anim} vid / {stats.total.tts} TTS in parallel)
              </span>
            </div>
            <div>
              <strong style={{ color: "#e8e8f0" }}>FFmpeg clip render</strong>:
              ~{Math.round(timeEstimate.phase2 * 10) / 10} min
              <span style={{ color: "#5a5a70", marginLeft: 8 }}>
                {stats.assembleConcurrency} clips at once
              </span>
            </div>
            <div>
              <strong style={{ color: "#e8e8f0" }}>Final xfade assembly</strong>:
              ~{Math.round(timeEstimate.phase3 * 10) / 10} min
              <span style={{ color: "#5a5a70", marginLeft: 8 }}>
                {stats.xfadeChunks} parallel chunks
              </span>
            </div>
          </div>
          {stats.keyCount === 1 && scriptStats.scenes > 30 && (
            <div style={{ color: "#ffce4d", fontSize: 12, marginTop: 10, padding: 8, background: "#2a2010", borderRadius: 6 }}>
              💡 You're running on a single 69labs key. Adding a 2nd key would cut the generation
              phase roughly in half (estimated ~{Math.round(timeEstimate.total / 2)} min instead of ~{Math.round(timeEstimate.total)} min).
              Paste extra keys in <a href="/settings" style={{ color: "#7c5cff" }}>Keys &amp; Settings</a> → Required API Keys.
            </div>
          )}
          <div style={{ color: "#5a5a70", fontSize: 11, marginTop: 8 }}>
            Numbers are rough — real runs are usually 10–30% faster. Heavy CPU usage during the
            assembly phase; weak machines may want to lower ASSEMBLE_CONCURRENCY or
            ASSEMBLE_XFADE_CHUNKS in Settings.
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ fontWeight: 700, marginBottom: 8 }}>What happens next</h3>
        <ol style={{ paddingLeft: 20, lineHeight: 1.7 }}>
          <li>Gemini splits the script into scenes (with visual prompts per scene).</li>
          <li>For each scene, TTS narration and an image are generated in parallel.</li>
          <li>Selected scenes get a Veo img2vid clip on top of the still image.</li>
          <li>FFmpeg stitches all clips together with crossfade transitions.</li>
        </ol>
        <p style={{ color: "#8a8aa0", fontSize: 13, marginTop: 8 }}>
          Live logs for every stage stream into the run page in real time.
        </p>
      </div>
    </div>
  );
}
