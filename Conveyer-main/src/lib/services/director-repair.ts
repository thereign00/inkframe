import { getSetting } from "../settings";
import { log } from "../logger";

/**
 * Autonomous AI Director Problem-Solving & Repair Service.
 *
 * When a visual prompt or scene encounters an error during image generation
 * or animation (e.g., content policy rejection, prompt syntax error, or
 * generation failure), the AI Director analyzes the failure and the channel's
 * custom DIRECTOR_PROMPT to autonomously rewrite and solve the issue.
 */
export async function directorRepairVisualPrompt(
  runId: string,
  sceneIndex: number,
  originalPrompt: string,
  errorMsg: string,
  sceneText?: string
): Promise<string> {
  const directorInstructions = getSetting("DIRECTOR_PROMPT");
  log(
    runId,
    "info",
    `🎬 AI Director intervening to solve error on Scene #${sceneIndex}: "${errorMsg.slice(0, 100)}..."`,
    { stage: "pipeline" }
  );

  const prompt = `You are the Autonomous AI Film Director and VFX Supervisor.
A visual scene prompt failed during image/video generation with the following error:
ERROR: ${errorMsg}

ORIGINAL FAILED PROMPT:
${originalPrompt}

${sceneText ? `SCENE NARRATION TEXT:\n"${sceneText}"\n` : ""}
${directorInstructions ? `CHANNEL DIRECTOR INSTRUCTIONS & RULES:\n"${directorInstructions}"\n` : ""}

YOUR TASK:
Rewrite the visual prompt so that it COMPLETELY SOLVES and avoids the error (e.g., sanitize potential sensitive terms, replace problematic tropes with cinematic B-roll or wide architectural/natural shots, simplify complex multi-subject instructions) while maintaining high photographic fidelity and relevance to the scene.

Return ONLY the rewritten visual prompt as plain text. Do NOT include quotes, prefixes, or explanations.`;

  try {
    const provider = getSetting("SCENE_SPLIT_PROVIDER") || "google";
    const apiKey = getSetting("GOOGLE_API_KEY") || process.env.GOOGLE_API_KEY || "";
    if (provider === "google" && apiKey) {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
          }),
        }
      );
      if (resp.ok) {
        const data = await resp.json() as any;
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text && text.length > 10) {
          log(
            runId,
            "success",
            `🎬 AI Director successfully repaired Scene #${sceneIndex} prompt: "${text.slice(0, 80)}..."`,
            { stage: "pipeline" }
          );
          return text;
        }
      }
    }
  } catch (err) {
    log(runId, "warn", `AI Director repair request encountered issue: ${(err as Error).message}`, { stage: "pipeline" });
  }

  // Safe heuristic fallback if API call unavailable: remove sensitive/problematic phrases
  const fallbackPrompt = originalPrompt
    .replace(/blood|violent|weapon|dead|killing|nude|naked|injury/gi, "dramatic documentary atmosphere")
    .replace(/\s+/g, " ")
    .trim();
  return fallbackPrompt || "cinematic wide documentary establishing shot, high contrast lighting, photographic detail";
}
