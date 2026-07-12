import fs from "node:fs";
import path from "node:path";
import { getSetting } from "../settings";
import { log } from "../logger";
import { checkCancelled } from "../cancellation";

/**
 * Service for interacting with local or remote ComfyUI server API (usually http://127.0.0.1:8188).
 * Handles txt2img (image generation) and img2vid (video animation).
 */

export interface ComfyTestResult {
  success: boolean;
  message: string;
  systemStats?: any;
}

function getComfyHeaders(contentTypeJson = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentTypeJson) {
    headers["Content-Type"] = "application/json";
  }
  const apiKey = getSetting("COMFYUI_API_KEY")?.trim();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
    headers["X-API-Key"] = apiKey;
  }
  return headers;
}

function resolveComfyTarget(customUrl?: string): { baseUrl: string; isCloud: boolean } {
  const rawUrl = customUrl || getSetting("COMFYUI_URL")?.trim() || "http://127.0.0.1:8188";
  const apiKey = getSetting("COMFYUI_API_KEY")?.trim() || "";
  let baseUrl = rawUrl.replace(/\/$/, "");
  // If user provided a Comfy Cloud API key but left URL as localhost, auto-switch to https://cloud.comfy.org
  if (apiKey && (baseUrl === "http://127.0.0.1:8188" || baseUrl === "http://localhost:8188")) {
    baseUrl = "https://cloud.comfy.org";
  }
  const isCloud = baseUrl.includes("cloud.comfy.org");
  return { baseUrl, isCloud };
}

/**
 * Test connection to ComfyUI server by fetching system stats or user profile.
 */
export async function testComfyConnection(customUrl?: string): Promise<ComfyTestResult> {
  const { baseUrl, isCloud } = resolveComfyTarget(customUrl);
  try {
    const testEndpoint = isCloud ? `${baseUrl}/api/user` : `${baseUrl}/system_stats`;
    const res = await fetch(testEndpoint, { headers: getComfyHeaders(false), signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      return { success: false, message: `Server responded with status ${res.status} ${res.statusText}` };
    }
    const data = await res.json() as any;
    const deviceName = isCloud ? "Comfy Cloud Infrastructure" : (data?.devices?.[0]?.name || "CPU / System Memory");
    return {
      success: true,
      message: `Connected to ${isCloud ? "Comfy Cloud API" : "ComfyUI"}! (${deviceName})`,
      systemStats: data,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Could not connect to ComfyUI at ${baseUrl}. (${msg})`,
    };
  }
}

/**
 * Default basic txt2img workflow JSON for ComfyUI if user hasn't specified a custom workflow.
 * Uses standard SD 1.5 / SDXL compatible nodes: CheckpointLoaderSimple, CLIPTextEncode, KSampler, VAEDecode, SaveImage.
 */
function getDefaultImageWorkflow(prompt: string): Record<string, any> {
  return {
    "3": {
      "class_type": "KSampler",
      "inputs": {
        "cfg": 7,
        "denoise": 1,
        "latent_image": [ "5", 0 ],
        "model": [ "4", 0 ],
        "negative": [ "7", 0 ],
        "positive": [ "6", 0 ],
        "sampler_name": "euler",
        "scheduler": "normal",
        "seed": Math.floor(Math.random() * 1000000000),
        "steps": 20
      }
    },
    "4": {
      "class_type": "CheckpointLoaderSimple",
      "inputs": {
        "ckpt_name": "v1-5-pruned-emaonly.safetensors"
      }
    },
    "5": {
      "class_type": "EmptyLatentImage",
      "inputs": {
        "batch_size": 1,
        "height": 576,
        "width": 1024
      }
    },
    "6": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "clip": [ "4", 1 ],
        "text": prompt
      }
    },
    "7": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "clip": [ "4", 1 ],
        "text": "blurry, low quality, distorted, bad proportions, watermark"
      }
    },
    "8": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": [ "3", 0 ],
        "vae": [ "4", 2 ]
      }
    },
    "9": {
      "class_type": "SaveImage",
      "inputs": {
        "filename_prefix": "inkframe_txt2img",
        "images": [ "8", 0 ]
      }
    }
  };
}

/**
 * Replace prompt text inside a custom workflow JSON exported from ComfyUI API.
 */
function injectPromptIntoWorkflow(workflow: Record<string, any>, prompt: string): Record<string, any> {
  for (const node of Object.values(workflow)) {
    if (
      node &&
      node.class_type === "CLIPTextEncode" &&
      typeof node.inputs?.text === "string" &&
      !node.inputs.text.toLowerCase().includes("blurry") &&
      !node.inputs.text.toLowerCase().includes("negative")
    ) {
      node.inputs.text = prompt;
      break;
    }
  }
  return workflow;
}

/**
 * Automatically inspect server's available models and replace invalid ckpt_name values.
 */
async function autoFixCheckpoints(
  workflow: Record<string, any>,
  baseUrl: string,
  isCloud: boolean,
  runId: string
): Promise<Record<string, any>> {
  const ckptNodes = Object.values(workflow).filter(
    (n) => n && (n.class_type === "CheckpointLoaderSimple" || n.class_type === "ImageOnlyCheckpointLoader")
  );
  if (ckptNodes.length === 0) return workflow;

  try {
    for (const node of ckptNodes) {
      const classType = node.class_type;
      const currentCkpt = String(node.inputs?.ckpt_name || "");

      let availableList: string[] = [];
      const infoUrlSpecific = isCloud ? `${baseUrl}/api/object_info/${classType}` : `${baseUrl}/object_info/${classType}`;
      let res = await fetch(infoUrlSpecific, { headers: getComfyHeaders(false), signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (res && res.ok) {
        const data = await res.json() as any;
        availableList = data?.[classType]?.input?.required?.ckpt_name?.[0] || [];
      }

      if (!availableList || availableList.length === 0) {
        const infoUrlAll = isCloud ? `${baseUrl}/api/object_info` : `${baseUrl}/object_info`;
        res = await fetch(infoUrlAll, { headers: getComfyHeaders(false), signal: AbortSignal.timeout(10000) }).catch(() => null);
        if (res && res.ok) {
          const data = await res.json() as any;
          availableList = data?.[classType]?.input?.required?.ckpt_name?.[0] || [];
        }
      }

      if (Array.isArray(availableList) && availableList.length > 0 && !availableList.includes(currentCkpt)) {
        let best = availableList[0];
        if (classType === "CheckpointLoaderSimple") {
          best =
            availableList.find((c) => c.toLowerCase().includes("xl") || c.toLowerCase().includes("flux") || c.toLowerCase().includes("v1-5")) ||
            availableList[0];
        } else if (classType === "ImageOnlyCheckpointLoader") {
          best = availableList.find((c) => c.toLowerCase().includes("svd")) || availableList[0];
        }
        log(runId, "info", `Auto-adjusting ComfyUI checkpoint from '${currentCkpt}' to available server model '${best}'`, { stage: "image" });
        node.inputs.ckpt_name = best;
      }
    }
  } catch (err) {
    // Non-fatal if object_info check fails
  }
  return workflow;
}

/**
 * Universal execution helper for both Local ComfyUI and Comfy Cloud API (https://cloud.comfy.org).
 */
async function executeComfyJobAndDownload(
  runId: string,
  workflow: Record<string, any>,
  outPath: string,
  stage: "image" | "animate"
): Promise<void> {
  const { baseUrl, isCloud } = resolveComfyTarget();
  const submitUrl = isCloud ? `${baseUrl}/api/prompt` : `${baseUrl}/prompt`;

  workflow = await autoFixCheckpoints(workflow, baseUrl, isCloud, runId);

  log(runId, "info", `Sending ${stage} generation job to ${isCloud ? "Comfy Cloud API" : "ComfyUI"} (${baseUrl})...`, { stage });
  const promptRes = await fetch(submitUrl, {
    method: "POST",
    headers: getComfyHeaders(true),
    body: JSON.stringify({ prompt: workflow, client_id: `inkframe-${stage}-${runId}` }),
  });

  if (!promptRes.ok) {
    const errText = await promptRes.text().catch(() => "");
    throw new Error(`ComfyUI prompt request failed (${promptRes.status}): ${errText || promptRes.statusText}`);
  }

  const promptData = await promptRes.json() as { prompt_id: string; number?: number; node_errors?: any };
  if (promptData.node_errors && Object.keys(promptData.node_errors).length > 0) {
    throw new Error(`ComfyUI Node Error: ${JSON.stringify(promptData.node_errors)}`);
  }

  const promptId = promptData.prompt_id;
  log(runId, "info", `Job queued (${promptId}). Waiting for ${isCloud ? "Comfy Cloud GPU" : "local"} rendering to complete...`, { stage });

  const startTime = Date.now();
  const timeoutMs = (stage === "animate" ? 20 : 10) * 60 * 1000;
  let outputs: any = null;

  while (Date.now() - startTime < timeoutMs) {
    checkCancelled(runId);
    await new Promise((r) => setTimeout(r, 3000));

    if (isCloud) {
      // Query Comfy Cloud job status endpoints
      let jobData: any = null;

      // Try /api/job/{id}
      const jobRes = await fetch(`${baseUrl}/api/job/${promptId}`, { headers: getComfyHeaders(false) }).catch(() => null);
      if (jobRes && jobRes.ok) {
        jobData = await jobRes.json().catch(() => null);
      }

      // Try /api/job/{id}/status
      if (!jobData || !jobData.status) {
        const statusRes = await fetch(`${baseUrl}/api/job/${promptId}/status`, { headers: getComfyHeaders(false) }).catch(() => null);
        if (statusRes && statusRes.ok) {
          jobData = await statusRes.json().catch(() => null);
        }
      }

      // Try /history/{id} compatibility endpoint
      if (!jobData || !jobData.status) {
        const histRes = await fetch(`${baseUrl}/history/${promptId}`, { headers: getComfyHeaders(false) }).catch(() => null);
        if (histRes && histRes.ok) {
          const hData = await histRes.json().catch(() => null);
          if (hData && hData[promptId] && hData[promptId].outputs) {
            outputs = hData[promptId].outputs;
            break;
          }
        }
      }

      if (jobData) {
        const st = String(jobData.status || jobData.state || "").toLowerCase();
        if (st === "completed" || st === "success" || st === "succeeded" || st === "done" || st === "finished") {
          // 1. Official endpoint for full job outputs: GET /api/jobs/{job_id} (PLURAL jobs)
          const fullJobRes = await fetch(`${baseUrl}/api/jobs/${promptId}`, { headers: getComfyHeaders(false) }).catch(() => null);
          if (fullJobRes && fullJobRes.ok) {
            const fullJobData = await fullJobRes.json().catch(() => null);
            if (findMediaInObject(fullJobData)) {
              outputs = fullJobData;
              break;
            }
          }

          // 2. Official history v2 endpoint: GET /api/history_v2/{job_id}
          const histV2Res = await fetch(`${baseUrl}/api/history_v2/${promptId}`, { headers: getComfyHeaders(false) }).catch(() => null);
          if (histV2Res && histV2Res.ok) {
            const histV2Data = await histV2Res.json().catch(() => null);
            if (findMediaInObject(histV2Data)) {
              outputs = histV2Data;
              break;
            }
          }

          // 3. Official history v2 recent list: GET /api/history_v2
          const histListRes = await fetch(`${baseUrl}/api/history_v2?max_items=10`, { headers: getComfyHeaders(false) }).catch(() => null);
          if (histListRes && histListRes.ok) {
            const histListData = await histListRes.json().catch(() => null);
            if (findMediaInObject(histListData)) {
              outputs = histListData;
              break;
            }
          }

          // 4. Fallback to jobData
          outputs = jobData;
          break;
        } else if (st === "failed" || st === "error" || st === "cancelled") {
          throw new Error(`Comfy Cloud job ${promptId} ended with status: ${st}`);
        }
      }
    } else {
      // Check Local ComfyUI history
      const histRes = await fetch(`${baseUrl}/history/${promptId}`, { headers: getComfyHeaders(false) }).catch(() => null);
      if (!histRes || !histRes.ok) continue;
      const histData = await histRes.json() as Record<string, any>;
      if (histData && histData[promptId]) {
        const status = histData[promptId].status;
        if (status?.status_str === "error") {
          throw new Error(`ComfyUI generation failed: ${JSON.stringify(status.messages || "Unknown error")}`);
        }
        if (histData[promptId].outputs) {
          outputs = histData[promptId].outputs;
          break;
        }
      }
    }
  }

interface FoundMedia {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
}

function findMediaInObject(obj: any): FoundMedia | null {
  if (!obj) return null;

  if (typeof obj === "string") {
    if (obj.startsWith("http://") || obj.startsWith("https://") || obj.startsWith("data:")) {
      return { filename: "output.png", subfolder: "", type: "output", url: obj };
    }
    return null;
  }

  if (typeof obj !== "object") return null;

  if (typeof obj.url === "string" && (obj.url.startsWith("http://") || obj.url.startsWith("https://") || obj.url.startsWith("data:"))) {
    return {
      filename: obj.filename || obj.name || "output.png",
      subfolder: obj.subfolder || "",
      type: obj.type || "output",
      url: obj.url,
    };
  }
  if (typeof obj.filename === "string" && obj.filename.length > 0) {
    return {
      filename: obj.filename,
      subfolder: obj.subfolder || "",
      type: obj.type || "output",
      url: typeof obj.url === "string" ? obj.url : "",
    };
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findMediaInObject(item);
      if (found) return found;
    }
    return null;
  }

  const priorityKeys = ["outputs", "output", "images", "gifs", "video", "result", "results", "files", "data", "history"];
  for (const key of priorityKeys) {
    if (key in obj) {
      const found = findMediaInObject(obj[key]);
      if (found) return found;
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (!priorityKeys.includes(key)) {
      const found = findMediaInObject(val);
      if (found) return found;
    }
  }

  return null;
}

  if (!outputs) {
    throw new Error(`ComfyUI ${stage} generation timed out after ${timeoutMs / 60000} minutes (Job ${promptId})`);
  }

  const foundMedia = findMediaInObject(outputs);
  if (!foundMedia) {
    log(runId, "warn", `Comfy Cloud job ${promptId} finished without recognizable media. Raw payload: ${JSON.stringify(outputs).slice(0, 400)}`, { stage });
    throw new Error(`ComfyUI job ${promptId} finished but produced no output media`);
  }

  log(runId, "info", `Downloading rendered ${stage} from ComfyUI...`, { stage });
  let dlUrl = foundMedia.url;
  if (!dlUrl) {
    const params = new URLSearchParams({ filename: foundMedia.filename, subfolder: foundMedia.subfolder, type: foundMedia.type });
    dlUrl = isCloud ? `${baseUrl}/api/view?${params}` : `${baseUrl}/view?${params}`;
  }

  const dlRes = await fetch(dlUrl, { headers: getComfyHeaders(false), redirect: "follow" });
  if (!dlRes.ok) {
    throw new Error(`Failed to download file from ${dlUrl} (${dlRes.status})`);
  }

  const buffer = Buffer.from(await dlRes.arrayBuffer());
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  log(runId, "success", `ComfyUI ${stage} saved: ${path.basename(outPath)}`, { stage });
}

/**
 * Generate a still image using ComfyUI or Comfy Cloud API.
 */
export async function comfyuiImage(runId: string, prompt: string, outPath: string): Promise<void> {
  checkCancelled(runId);
  const customWorkflowStr = getSetting("COMFYUI_IMAGE_WORKFLOW")?.trim();

  let workflow: Record<string, any>;
  if (customWorkflowStr) {
    try {
      workflow = injectPromptIntoWorkflow(JSON.parse(customWorkflowStr), prompt);
    } catch (e) {
      log(runId, "warn", `Custom ComfyUI Image Workflow JSON is invalid — falling back to default txt2img workflow`, { stage: "image" });
      workflow = getDefaultImageWorkflow(prompt);
    }
  } else {
    workflow = getDefaultImageWorkflow(prompt);
  }

  // If user selected a specific checkpoint name in IMAGE_MODEL setting, apply it
  const selectedModel = getSetting("IMAGE_MODEL")?.trim();
  if (selectedModel && selectedModel !== "sdxl-flux" && (selectedModel.endsWith(".safetensors") || selectedModel.endsWith(".ckpt"))) {
    for (const node of Object.values(workflow)) {
      if (node && (node.class_type === "CheckpointLoaderSimple" || node.class_type === "ImageOnlyCheckpointLoader")) {
        node.inputs = node.inputs || {};
        node.inputs.ckpt_name = selectedModel;
      }
    }
  }

  await executeComfyJobAndDownload(runId, workflow, outPath, "image");
}

/**
 * Upload an image file to ComfyUI input directory or Comfy Cloud API.
 */
async function uploadImageToComfy(imagePath: string): Promise<string> {
  const { baseUrl, isCloud } = resolveComfyTarget();
  const fileData = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);

  const blob = new Blob([fileData], { type: "image/png" });
  const formData = new FormData();
  formData.append("image", blob, fileName);
  formData.append("overwrite", "true");

  const uploadUrl = isCloud ? `${baseUrl}/api/upload/image` : `${baseUrl}/upload/image`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: getComfyHeaders(false),
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Failed to upload image to ComfyUI (${res.status}): ${errText}`);
  }

  const data = await res.json() as { name: string; subfolder: string; type: string };
  return data.name;
}

/**
 * Default basic SVD (Stable Video Diffusion) img2vid workflow JSON if user hasn't specified a custom workflow.
 */
function getDefaultVideoWorkflow(imageFilename: string): Record<string, any> {
  return {
    "1": {
      "class_type": "LoadImage",
      "inputs": {
        "image": imageFilename
      }
    },
    "2": {
      "class_type": "ImageOnlyCheckpointLoader",
      "inputs": {
        "ckpt_name": "svd_xt.safetensors"
      }
    },
    "3": {
      "class_type": "SVD_img2vid_Conditioning",
      "inputs": {
        "width": 1024,
        "height": 576,
        "augmentation_level": 0.0,
        "clip_vision": [ "2", 1 ],
        "fps": 6,
        "init_image": [ "1", 0 ],
        "motion_bucket_id": 127,
        "video_frames": 14,
        "vae": [ "2", 2 ]
      }
    },
    "4": {
      "class_type": "KSampler",
      "inputs": {
        "cfg": 2.5,
        "denoise": 1,
        "latent_image": [ "3", 2 ],
        "model": [ "2", 0 ],
        "negative": [ "3", 1 ],
        "positive": [ "3", 0 ],
        "sampler_name": "euler",
        "scheduler": "karras",
        "seed": Math.floor(Math.random() * 1000000000),
        "steps": 20
      }
    },
    "5": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": [ "4", 0 ],
        "vae": [ "2", 2 ]
      }
    },
    "6": {
      "class_type": "VHS_VideoCombine",
      "inputs": {
        "filename_prefix": "inkframe_svd",
        "format": "video/h264-mp4",
        "frame_rate": 6,
        "images": [ "5", 0 ],
        "loop_count": 0,
        "save_output": true
      }
    }
  };
}

/**
 * Replace image filename inside a custom video workflow JSON exported from ComfyUI API.
 */
function injectImageIntoWorkflow(workflow: Record<string, any>, imageFilename: string): Record<string, any> {
  for (const node of Object.values(workflow)) {
    if (node && node.class_type === "LoadImage" && "image" in (node.inputs || {})) {
      node.inputs.image = imageFilename;
      break;
    }
  }
  return workflow;
}

/**
 * Animate a still image into a short video using ComfyUI or Comfy Cloud API.
 */
export async function comfyuiImg2Vid(runId: string, imagePath: string, outPath: string, prompt?: string): Promise<void> {
  checkCancelled(runId);
  log(runId, "info", `Uploading base image to ComfyUI input directory...`, { stage: "animate" });
  const uploadedFilename = await uploadImageToComfy(imagePath);

  const customWorkflowStr = getSetting("COMFYUI_VIDEO_WORKFLOW")?.trim();
  let workflow: Record<string, any>;
  if (customWorkflowStr) {
    try {
      workflow = injectImageIntoWorkflow(JSON.parse(customWorkflowStr), uploadedFilename);
      if (prompt) workflow = injectPromptIntoWorkflow(workflow, prompt);
    } catch (e) {
      log(runId, "warn", `Custom ComfyUI Video Workflow JSON is invalid — falling back to default SVD workflow`, { stage: "animate" });
      workflow = getDefaultVideoWorkflow(uploadedFilename);
    }
  } else {
    workflow = getDefaultVideoWorkflow(uploadedFilename);
  }

  for (const node of Object.values(workflow)) {
    if (node && node.class_type === "SVD_img2vid_Conditioning") {
      node.inputs = node.inputs || {};
      if (!("width" in node.inputs)) node.inputs.width = 1024;
      if (!("height" in node.inputs)) node.inputs.height = 576;
    }
  }

  await executeComfyJobAndDownload(runId, workflow, outPath, "animate");
}
