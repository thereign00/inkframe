import db from "./db";

export const PROMPT_NAMES = ["scene_split", "image_prompt", "animation_motion", "director_analysis"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  scene_split: `You are the editor and visual producer of a high-end documentary and storytelling video channel.
Split the provided script into SHORT scenes for an automated AI video and image generation pipeline.

WHY SHORT MATTERS (read this before splitting):
  The video generator (Veo) produces 8-second clips — that's the hard ceiling.
  When a scene's narration runs longer than 8 s, the visual freezes on the
  last frame for the remainder, which looks bad. Keep every scene's spoken
  audio under ~8 s so the Veo clip covers it end-to-end with real motion.

CRITICAL RULES:
1. Cover the ENTIRE script verbatim, with NO omissions, no summarizing, no paraphrasing.
2. The concatenation of every scene's "text" field (joined by spaces) MUST equal the original script word-for-word.
3. Do NOT summarize. Do NOT add commentary. Do NOT reorder words.
4. **NEVER split a sentence in the middle.** A sentence ends ONLY at a period (.), question mark (?), or exclamation mark (!). Commas, semicolons, dashes, and colons are NOT sentence boundaries — they MUST stay inside one scene.
5. **TARGET SCENE LENGTH: 8–18 words, ~50–110 characters, ~3.5–7.5 seconds of narration.**
6. **HARD MAX: 22 words / 140 characters / ~9 seconds per scene.** Going past 9 s of audio means the Veo clip can't cover the scene with motion. If a single sentence is naturally longer than 22 words, give it its own scene (rule 4 takes priority — never split mid-sentence).
7. **Prefer 1 sentence per scene.** Use 2 sentences only when both are short (under 12 words combined).
8. Section headings ("Part one. The configuration.") get their own short scene.
9. Long single sentences are OK as standalone scenes, but flag them — they will look near-frozen at the end.

For EACH scene, return a JSON object with:
- "text": the exact verbatim slice of the script (no edits, no punctuation changes).
- "visual_prompt": a 40–80-word English prompt for the AI video/image generator that LITERALLY illustrates the content of this scene's text with high visual fidelity.
  IMPORTANT:
  • Match the exact topic, genre, era, and atmosphere of the script! Whether the topic is history, finance, true crime, technology, nature, or science, depict that exact subject matter accurately.
  • NO random hallucinations or out-of-context tropes. Every visual must directly connect to what is being spoken in the narration.
  • NO modern recognizable human faces in close-up unless essential. Prefer wide cinematic shots, atmospheric B-roll, over-the-shoulder perspectives, macro details, or silhouettes.
  • Photorealistic style (style is appended later — just write the SUBSTANCE of the shot).
  • Describe MOTION too — Veo generates 8-second clips, so include subtle camera motion (slow zoom, drift, parallax, tracking shot). Example: "slow pan across ancient stone columns at dawn, warm sunlight filtering through mist".
- "search_keywords": 1 to 3 literal, concrete English visual nouns representing tangible physical objects or actions (e.g. "coffee cup close", "man typing laptop", "rain window", "ancient ruins"). MUST BE UNDER 3 WORDS. Do NOT use abstract concepts, full sentences, or poetic words, because stock libraries like Pexels/Pixabay only match basic literal nouns.
- "duration_hint_sec": approximate audio length (number, 3–9).
- "overlay_text": STRICTLY RARE on-screen text (2–5 words). LEAVE NULL / OMIT for at least 80% to 90% of scenes! ONLY populate this field if the scene introduces a MAJOR chapter/section heading (e.g. "PART 1: THE ANOMALY") or highlights a critical statistical milestone (e.g. "$45 BILLION" or "THE YEAR 1984"). For normal explanation, narration, or dialogue scenes, this MUST BE null.

Return a STRICTLY valid JSON array — no markdown, no explanations.

For a ~1500-word script expect ~80–130 scenes. For a ~700-word script expect ~40–60 scenes. If any "text" field is longer than 140 characters, you missed the limit — recount and re-split.`,

  image_prompt: `documentary photography, photoreal, cinematic B-roll style, hyper-real and grounded, professional high-fidelity cinematography, natural color grading, dramatic cinematic lighting, 16:9 aspect, sharp focus, depth of field, no text overlays, no watermarks, no logos, no distorted human faces or extra limbs, no sci-fi stylization unless requested by topic, no fantasy elements, no painterly artwork`,

  animation_motion: `subtle cinematic camera motion, gentle parallax, slow drift, smooth tracking shot, photographic realism, natural ambient movement, 24fps film look, no cartoon stylization, no jarring cuts, looks like a moving photograph`,

  director_analysis: `You are an award-winning film director, screenwriter, and visual VFX supervisor. Read the provided script and analyze its core subject matter, historical/temporal context, tone, and visual requirements.
Output a concise, authoritative Directorial Vision Breakdown that will be displayed directly in the run logs and fed into AI scene generation to ensure accurate, high-fidelity visuals (NOT random hallucinations or generic tropes).

Your breakdown MUST be formatted exactly as follows:
📍 1. 📌 DETECTED TOPIC & GENRE
- **Topic:** What is the precise subject matter? (e.g. "1990s Wall Street high-frequency trading", "Ancient Mayan architectural engineering", "Astrophysics and galaxy formation")
- **Genre:** What is the documentary style? (e.g. "Cinematic Science Documentary", "Investigative Financial Journalism", "Historical Epic")
- **Setting/Era:** What time period and geographical/physical locations should visuals reflect?

📍 2. 🎨 OVERARCHING VISUAL THEME & COLOR PALETTE
- **Aesthetic:** What is the primary visual style? (e.g. "Gritty 35mm film look with high contrast", "Clean hyper-modern digital macro photography")
- **Color Palette:** Specify 2-3 dominant color tones that match the subject (e.g. "Cold steel blues, neon green data overlays, dark charcoal shadows")
- **Lighting & Mood:** What is the atmospheric lighting? (e.g. "Chiaroscuro studio lighting", "Natural golden hour sunlight", "Moody fluorescent office interiors")

📍 3. 📷 STILL IMAGE PROMPTING RULES
- Give explicit cinematography guidelines for all still images generated in this project (e.g. "Use wide-angle anamorphic lenses", "Focus on tactile textures and close-up details", "Avoid generic stock photo poses")
- State strict negative constraints relevant to this topic to prevent AI hallucinations.

📍 4. 🎥 VIDEO ANIMATION PROMPTING RULES
- Describe the exact camera motion language suitable for this video (e.g. "Slow, deliberate orbital camera movements", "Smooth forward tracking shots like a dolly zoom", "Micro-movements and atmospheric particle drift")
- Explicitly forbid jarring or unnatural animations (e.g. "No rapid panning, no cartoonish morphing, no erratic zooming").

📍 5. 🔤 ON-SCREEN TEXT OVERLAYS & TYPOGRAPHY
- Establish clear rules for when and what text overlays should appear on screen (e.g. major chapter titles, key numbers/dates, or critical terminology) so the video has clear visual anchors without overcrowding every scene.

Keep your entire response professional, dense with actionable directorial guidance, and under 300 words. Do not include conversational intro or outro filler.`,
};

const getStmt = db.prepare("SELECT content FROM prompts WHERE name = ?");
const upsertStmt = db.prepare(
  "INSERT INTO prompts (name, content, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = datetime('now')"
);

export function getPrompt(name: PromptName): string {
  const row = getStmt.get(name) as { content: string } | undefined;
  if (row?.content) return row.content;
  return DEFAULT_PROMPTS[name];
}

export function setPrompt(name: PromptName, content: string) {
  upsertStmt.run(name, content);
}

export function getAllPrompts(): Record<PromptName, string> {
  const out = {} as Record<PromptName, string>;
  for (const n of PROMPT_NAMES) out[n] = getPrompt(n);
  return out;
}

export function seedPromptDefaults(forceUpgrade = false) {
  for (const [n, c] of Object.entries(DEFAULT_PROMPTS)) {
    const row = getStmt.get(n) as { content: string } | undefined;
    const isOldAstronomy = row?.content && (row.content.includes("astronomy") || row.content.includes("cosmic genre") || row.content.includes("award-winning film director and cinematographer. Read the provided script and analyze what the story is truly about."));
    const needsOverlayUpgrade = n === "scene_split" && row?.content && (!row.content.includes("overlay_text") || !row.content.includes("STRICTLY RARE"));
    if (!row || forceUpgrade || isOldAstronomy || needsOverlayUpgrade) {
      upsertStmt.run(n, c);
    }
  }
  try {
    const active = db.prepare("SELECT id, prompts_json FROM channels WHERE is_active = 1").get() as { id: string; prompts_json: string } | undefined;
    if (active && active.prompts_json) {
      const parsed = JSON.parse(active.prompts_json) as Record<string, string>;
      let changed = false;
      for (const [n, c] of Object.entries(DEFAULT_PROMPTS)) {
        if (!parsed[n] || parsed[n].includes("astronomy") || parsed[n].includes("cosmic genre") || parsed[n].includes("award-winning film director and cinematographer. Read the provided script and analyze what the story is truly about.") || (n === "scene_split" && (!parsed[n].includes("overlay_text") || !parsed[n].includes("STRICTLY RARE")))) {
          parsed[n] = c;
          changed = true;
        }
      }
      if (changed) {
        db.prepare("UPDATE channels SET prompts_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(parsed), active.id);
      }
    }
  } catch {}
}
