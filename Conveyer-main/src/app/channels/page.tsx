"use client";
import { useEffect, useState } from "react";
import { appPrompt, appAlert, appConfirm } from "@/lib/dialogs";

interface ChannelSummary {
  id: string;
  name: string;
  is_active: number;
}

interface ChannelFull {
  id: string;
  name: string;
  prompts_json: string;
  settings_json: string;
  is_active: number;
}

// ── Known models (for autocomplete) ──────────────────────────────────────────

const IMAGE_MODELS = [
  // KieAI models
  { value: "flux-kontext-pro", label: "Flux Kontext Pro", provider: "kieai" },
  { value: "flux-kontext", label: "Flux Kontext", provider: "kieai" },
  { value: "flux-pro", label: "Flux Pro", provider: "kieai" },
  { value: "flux-realism", label: "Flux Realism", provider: "kieai" },
  { value: "flux-schnell", label: "Flux Schnell", provider: "kieai" },
  { value: "flux-dev", label: "Flux Dev", provider: "kieai" },
  { value: "recraft-v3", label: "Recraft V3", provider: "kieai" },
  { value: "ideogram-v3", label: "Ideogram V3", provider: "kieai" },
  { value: "qwen-image", label: "Qwen Image", provider: "kieai" },
  // 69labs models
  { value: "nano-banana-pro", label: "Nano Banana Pro", provider: "69labs" },
  { value: "nano-banana", label: "Nano Banana", provider: "69labs" },
  { value: "qwen-image", label: "Qwen Image (Wanx)", provider: "69labs" },
  { value: "imagen-4", label: "Imagen 4", provider: "69labs" },
  { value: "seedream-4.5", label: "Seedream 4.5", provider: "69labs" },
  { value: "flux-2-pro", label: "Flux 2 Pro", provider: "69labs" },
  { value: "black-forest-labs/flux-schnell", label: "Flux Schnell (69labs)", provider: "69labs" },
  // ComfyUI models
  { value: "sdxl-flux", label: "ComfyUI Workflow (SDXL / Flux)", provider: "comfyui" },
];

const VIDEO_MODELS = [
  // KieAI models
  { value: "veo3_fast", label: "Veo 3 Fast", provider: "kieai" },
  { value: "veo3", label: "Veo 3", provider: "kieai" },
  { value: "veo2", label: "Veo 2", provider: "kieai" },
  { value: "kling-v2.1-pro", label: "Kling V2.1 Pro", provider: "kieai" },
  { value: "kling-v2.1-standard", label: "Kling V2.1 Standard", provider: "kieai" },
  { value: "kling-v1.6-pro", label: "Kling V1.6 Pro", provider: "kieai" },
  { value: "minimax-video-01", label: "Minimax Video 01", provider: "kieai" },
  { value: "wan-2.1", label: "Wan 2.1", provider: "kieai" },
  // 69labs models
  { value: "veo3lite", label: "Veo 3 Lite", provider: "69labs" },
  { value: "veo-video", label: "Veo Video", provider: "69labs" },
  { value: "grok-imagine-video", label: "Grok Imagine Video", provider: "69labs" },
  { value: "kwaivgi/kling-v1.6-standard", label: "Kling V1.6 Standard (69labs)", provider: "69labs" },
  // ComfyUI models
  { value: "svd-xt", label: "ComfyUI Workflow (SVD Video)", provider: "comfyui" },
];

const PROMPT_META: { name: string; label: string; hint: string; rows: number }[] = [
  {
    name: "scene_split",
    label: "Scene Split — system prompt",
    hint: "Instructs the LLM how to slice scripts into scenes. Defines the visual world of the channel.",
    rows: 14,
  },
  {
    name: "image_prompt",
    label: "Image Style — suffix for every image",
    hint: "Pure style instructions appended to every scene's visual_prompt. Defines the look of the channel.",
    rows: 4,
  },
  {
    name: "animation_motion",
    label: "Animation Motion — motion style for img2vid",
    hint: "Appended when img2vid is enabled. Tells the video model what kind of motion you want.",
    rows: 3,
  },
];

// ── Autocomplete input ──────────────────────────────────────────────────────

function ModelAutocomplete({
  value,
  onChange,
  onCommit,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const query = search || value;
  const filtered = options.filter(
    (o) =>
      o.value.toLowerCase().includes(query.toLowerCase()) ||
      o.label.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 320 }}>
      <input
        type="text"
        className="input"
        value={search || value}
        placeholder={placeholder}
        onFocus={() => { setOpen(true); setSearch(""); }}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          // Delay to allow click on dropdown
          setTimeout(() => {
            setOpen(false);
            if (search && search !== value) {
              onChange(search);
              onCommit(search);
            }
            setSearch("");
          }, 200);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setOpen(false);
            const v = search || value;
            onChange(v);
            onCommit(v);
            setSearch("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        style={{
          width: "100%",
          padding: "6px 12px",
          fontSize: 13,
          background: "#0e0e18",
          border: "1px solid #3a3a50",
          borderRadius: 8,
          color: "#e8e8f0",
        }}
      />
      {open && filtered.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            background: "#14141f",
            border: "1px solid #3a3a50",
            borderRadius: 8,
            maxHeight: 200,
            overflowY: "auto",
            zIndex: 100,
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          }}
        >
          {filtered.map((o) => (
            <div
              key={o.value}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur
                onChange(o.value);
                onCommit(o.value);
                setOpen(false);
                setSearch("");
              }}
              style={{
                padding: "8px 14px",
                cursor: "pointer",
                fontSize: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: o.value === value ? "#2a1f5e" : "transparent",
                borderBottom: "1px solid #1a1a2a",
              }}
              onMouseEnter={(e) => ((e.target as HTMLElement).style.background = "#22223a")}
              onMouseLeave={(e) => ((e.target as HTMLElement).style.background = o.value === value ? "#2a1f5e" : "transparent")}
            >
              <span style={{ color: "#e0e0f0", fontWeight: o.value === value ? 700 : 400 }}>{o.label}</span>
              <span style={{ color: "#5a5a70", fontSize: 10, fontFamily: "monospace" }}>{o.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");

  // Expanded channel editing
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editPrompts, setEditPrompts] = useState<Record<string, string>>({});
  const [promptsDirty, setPromptsDirty] = useState(false);

  // Per-channel settings (provider selection)
  const [editSettings, setEditSettings] = useState<Record<string, string>>({});

  async function load() {
    const r = await fetch("/api/channels");
    const list: ChannelSummary[] = await r.json();
    setChannels(list);
  }

  useEffect(() => { load(); }, []);

  function showFlash(msg: string) {
    setFlash(msg);
    setTimeout(() => setFlash(""), 2000);
  }

  // ── Expand / collapse a channel to edit its prompts ──────────────────

  async function toggleExpand(ch: ChannelSummary) {
    if (expandedId === ch.id) {
      setExpandedId(null);
      setEditPrompts({});
      setEditSettings({});
      setPromptsDirty(false);
      return;
    }

    // If this channel is active, load from live prompts table
    // Otherwise load from the channel's stored snapshot
    if (ch.is_active) {
      const r = await fetch("/api/prompts");
      const prompts = await r.json();
      setEditPrompts(prompts);
    } else {
      const fullR = await fetch(`/api/channels/${ch.id}`);
      if (fullR.ok) {
        const full: ChannelFull = await fullR.json();
        try {
          setEditPrompts(JSON.parse(full.prompts_json));
        } catch {
          setEditPrompts({});
        }
      }
    }

    // Load channel settings
    const settingsR = await fetch(`/api/channels/${ch.id}/settings`);
    if (settingsR.ok) {
      setEditSettings(await settingsR.json());
    } else {
      setEditSettings({});
    }

    setExpandedId(ch.id);
    setPromptsDirty(false);
  }

  async function updateChannelProvider(ch: ChannelSummary, provider: string) {
    const isKie = provider === "kieai";
    const newSettings: Record<string, string> = {
      TTS_PROVIDER: provider,
      IMAGE_PROVIDER: provider,
      ANIMATION_PROVIDER: provider,
      // Auto-set smart defaults for each provider
      IMAGE_MODEL: isKie ? "flux-kontext-pro" : "img-flux",
      ANIMATION_MODEL: isKie ? "veo3_fast" : "veo-video",
      TTS_VOICE_ID: isKie ? "DTKMou8ccj1ZaWGBiotd" : "Rachel",
    };
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSettings),
      });
      if (r.ok) {
        setEditSettings((prev) => ({ ...prev, ...newSettings }));
        showFlash("Provider updated ✓");
      }
    } finally {
      setBusy(false);
    }
  }

  async function updateChannelVoice(ch: ChannelSummary, voiceId: string) {
    const trimmed = voiceId.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ TTS_VOICE_ID: trimmed }),
      });
      if (r.ok) {
        setEditSettings((prev) => ({ ...prev, TTS_VOICE_ID: trimmed }));
        showFlash("Voice updated ✓");
      }
    } finally {
      setBusy(false);
    }
  }

  async function updateChannelAnimation(ch: ChannelSummary, updates: Record<string, string>) {
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (r.ok) {
        setEditSettings((prev) => ({ ...prev, ...updates }));
        showFlash("Animation settings updated ✓");
      }
    } finally {
      setBusy(false);
    }
  }

  async function updateChannelSetting(ch: ChannelSummary, key: string, value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: trimmed }),
      });
      if (r.ok) {
        setEditSettings((prev) => ({ ...prev, [key]: trimmed }));
        showFlash(`${key === "IMAGE_MODEL" ? "Image model" : "Video model"} updated ✓`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveExpandedPrompts(ch: ChannelSummary) {
    setBusy(true);
    try {
      if (ch.is_active) {
        // Save to live prompts table + snapshot into channel
        await fetch("/api/prompts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editPrompts),
        });
        await fetch("/api/channels/active", { method: "PUT" });
      } else {
        // Save directly to the channel's stored snapshot
        await fetch(`/api/channels/${ch.id}/prompts`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editPrompts),
        });
      }
      setPromptsDirty(false);
      showFlash("Prompts saved ✓");
    } finally {
      setBusy(false);
    }
  }

  // ── Channel CRUD actions ─────────────────────────────────────────────

  async function switchTo(id: string) {
    setBusy(true);
    try {
      await fetch("/api/channels/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      showFlash("Switched ✓");

      // If we have that channel expanded, reload its prompts from live tables
      if (expandedId === id) {
        const r = await fetch("/api/prompts");
        setEditPrompts(await r.json());
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function createChannel() {
    const name = await appPrompt("New channel name:");
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), fromActive: true }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        await appAlert(j.error || "Failed to create channel.");
        return;
      }
      showFlash("Created ✓");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function duplicateChannel(ch: ChannelSummary) {
    const name = await appPrompt("Name for the copy:", `${ch.name} (copy)`);
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        await appAlert(j.error || "Failed to duplicate.");
        return;
      }
      showFlash("Duplicated ✓");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function renameChannel(ch: ChannelSummary) {
    const name = await appPrompt("Rename channel:", ch.name);
    if (!name?.trim() || name.trim() === ch.name) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        await appAlert(j.error || "Failed to rename.");
        return;
      }
      showFlash("Renamed ✓");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function deleteChannel(ch: ChannelSummary) {
    if (!(await appConfirm(`Delete channel "${ch.name}"? This cannot be undone.`))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/channels/${ch.id}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as { error?: string }));
        await appAlert(j.error || "Failed to delete.");
        return;
      }
      if (expandedId === ch.id) {
        setExpandedId(null);
        setEditPrompts({});
      }
      showFlash("Deleted");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveSnapshot(ch: ChannelSummary) {
    setBusy(true);
    try {
      // Save prompts if they were edited
      if (promptsDirty) {
        if (ch.is_active) {
          // Active channel: save to live prompts table
          await fetch("/api/prompts", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(editPrompts),
          });
        }
        // Save to channel's snapshot
        await fetch(`/api/channels/${ch.id}/prompts`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editPrompts),
        });
        setPromptsDirty(false);
      }

      // Refresh settings from backend (source of truth) so the UI is
      // guaranteed to show exactly what's stored — no stale closure data.
      const latestR = await fetch(`/api/channels/${ch.id}/settings`);
      if (latestR.ok) {
        setEditSettings(await latestR.json());
      }

      showFlash("Channel saved ✓");
    } catch {
      showFlash("Save failed — try again");
    } finally {
      setBusy(false);
    }
  }


  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 4 }}>Channels</h1>
      <p style={{ color: "#8a8aa0", marginBottom: 20, lineHeight: 1.6 }}>
        Each channel is a niche preset — its own prompts + voice/image/animation settings.
        Click a channel to expand and edit its prompts. Global keys (API keys, output dir,
        video settings) are shared across all channels.
      </p>

      {/* Action bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <button className="btn" onClick={createChannel} disabled={busy}>
          + New channel
        </button>
        {flash && (
          <span
            style={{
              color: "#6dd66d",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {flash}
          </span>
        )}
      </div>

      {/* Channel list */}
      <div style={{ display: "grid", gap: 14 }}>
        {channels.map((ch) => {
          const isActive = ch.is_active === 1;
          const isExpanded = expandedId === ch.id;
          return (
            <div
              key={ch.id}
              className="card"
              style={{
                borderColor: isActive ? "#7c5cff" : "var(--border)",
                borderWidth: isActive ? 2 : 1,
                transition: "border-color 0.2s, box-shadow 0.2s",
                boxShadow: isActive ? "0 0 20px rgba(124,92,255,0.15)" : "none",
              }}
            >
              {/* Header row */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                {/* Channel name — clickable to expand */}
                <button
                  onClick={() => toggleExpand(ch)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--fg)",
                    fontSize: 18,
                    fontWeight: 700,
                    cursor: "pointer",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      transition: "transform 0.2s",
                      transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                      fontSize: 14,
                      color: "#8a8aa0",
                    }}
                  >
                    ▶
                  </span>
                  {ch.name}
                </button>

                {isActive && (
                  <span
                    style={{
                      background: "linear-gradient(135deg, #7c5cff, #a78bfa)",
                      color: "white",
                      padding: "2px 10px",
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 0.5,
                      textTransform: "uppercase",
                    }}
                  >
                    Active
                  </span>
                )}

                <div style={{ flex: 1 }} />

                {/* Action buttons */}
                {!isActive && (
                  <button
                    className="btn"
                    onClick={() => switchTo(ch.id)}
                    disabled={busy}
                    style={{ fontSize: 12, padding: "4px 12px" }}
                  >
                    Switch to
                  </button>
                )}
                {isActive && (
                  <span style={{ fontSize: 10, color: "#5ccc5c", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
                    ● Active
                  </span>
                )}
                <button
                  className="btn"
                  onClick={() => saveSnapshot(ch)}
                  disabled={busy}
                  style={{
                    fontSize: 12,
                    padding: "4px 12px",
                    background: "linear-gradient(135deg, #3a6a3a, #2a5a2a)",
                  }}
                >
                  💾 Save
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => duplicateChannel(ch)}
                  disabled={busy}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  Duplicate
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => renameChannel(ch)}
                  disabled={busy}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  Rename
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => deleteChannel(ch)}
                  disabled={busy || channels.length <= 1}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    color: channels.length <= 1 ? "#5a5a70" : "#ff8888",
                    borderColor: channels.length <= 1 ? "var(--border)" : "#5a3a3a",
                  }}
                >
                  Delete
                </button>
              </div>

              {/* Expanded: settings + prompt editors */}
              {isExpanded && (
                <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>

                  {/* Provider selectors — per task */}
                  {(() => {
                    const ttsProv = editSettings.TTS_PROVIDER || "kieai";
                    const imgProv = editSettings.IMAGE_PROVIDER || "kieai";
                    const animProv = editSettings.ANIMATION_PROVIDER || "kieai";

                    const PROVIDER_LABELS: Record<string, string> = {
                      kieai: "⚡ KieAI",
                      "69labs": "🔬 69labs",
                      comfyui: "🎨 ComfyUI",
                      elevenlabs: "🎤 ElevenLabs",
                      off: "🚫 Off",
                    };

                    const provBtn = (
                      label: string,
                      current: string,
                      onPick: (p: string) => void,
                      choices: string[] = ["kieai", "69labs"],
                    ) => (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#9090a8", minWidth: 64 }}>{label}</span>
                        {choices.map((p) => {
                          const sel = current === p;
                          return (
                            <button
                              key={p}
                              onClick={() => onPick(p)}
                              disabled={busy}
                              style={{
                                padding: "4px 14px",
                                borderRadius: 7,
                                border: sel ? "1.5px solid #7c5cff" : "1px solid #2a2a3a",
                                background: sel ? "linear-gradient(135deg, #2a1f5e, #3a2f7e)" : "transparent",
                                color: sel ? "#c8b8ff" : "#6a6a80",
                                fontWeight: sel ? 700 : 400,
                                fontSize: 12,
                                cursor: "pointer",
                                transition: "all 0.2s",
                              }}
                            >
                              {PROVIDER_LABELS[p] || p}
                            </button>
                          );
                        })}
                      </div>
                    );

                    const updateSingle = async (key: string, provider: string, extras?: Record<string, string>) => {
                      const updates: Record<string, string> = { [key]: provider, ...(extras || {}) };
                      setBusy(true);
                      try {
                        const r = await fetch(`/api/channels/${ch.id}/settings`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(updates),
                        });
                        if (r.ok) {
                          setEditSettings((prev) => ({ ...prev, ...updates }));
                          showFlash("Provider updated ✓");
                        }
                      } finally {
                        setBusy(false);
                      }
                    };

                    return (
                      <div
                        style={{
                          marginBottom: 20,
                          padding: "14px 16px",
                          background: "linear-gradient(135deg, #14141d, #1a1a28)",
                          borderRadius: 10,
                          border: "1px solid #2a2a3a",
                        }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", marginBottom: 12, display: "block" }}>
                          API Providers
                        </span>

                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {provBtn("🎙️ TTS", ttsProv, (p) =>
                            updateSingle("TTS_PROVIDER", p, p !== "off" ? {
                              TTS_VOICE_ID: p === "kieai" ? "DTKMou8ccj1ZaWGBiotd" : p === "elevenlabs" ? "" : "Rachel",
                            } : {}),
                            ["kieai", "69labs", "elevenlabs", "off"]
                          )}
                          {provBtn("🖼️ Images", imgProv, (p) =>
                            updateSingle("IMAGE_PROVIDER", p, {
                              IMAGE_MODEL: p === "kieai" ? "flux-kontext-pro" : p === "comfyui" ? "sdxl-flux" : "img-flux",
                            }),
                            ["kieai", "69labs", "comfyui"]
                          )}
                          {provBtn("🎬 Video", animProv, (p) =>
                            updateSingle("ANIMATION_PROVIDER", p, {
                              ANIMATION_MODEL: p === "kieai" ? "veo3_fast" : p === "comfyui" ? "svd-xt" : "veo-video",
                            }),
                            ["kieai", "69labs", "comfyui", "off"]
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Fallback providers — auto-switch when primary fails */}
                  {(() => {
                    const imgFb = editSettings.IMAGE_FALLBACK_PROVIDER || "";
                    const animFb = editSettings.ANIMATION_FALLBACK_PROVIDER || "";
                    const FALLBACK_OPTIONS = [
                      { value: "", label: "Off" },
                      { value: "kieai", label: "⚡ KieAI" },
                      { value: "69labs", label: "🔬 69labs" },
                      { value: "comfyui", label: "🎨 ComfyUI" },
                    ];

                    const fbBtn = (label: string, key: string, current: string) => (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 11, color: "#8a8a9a", minWidth: 60 }}>{label}</span>
                        {FALLBACK_OPTIONS.map((o) => {
                          const sel = current === o.value;
                          return (
                            <button
                              key={o.value}
                              onClick={() => updateChannelAnimation(ch, { [key]: o.value })}
                              disabled={busy}
                              style={{
                                padding: "3px 10px",
                                borderRadius: 6,
                                border: sel ? "1.5px solid #e8a838" : "1px solid #2a2a3a",
                                background: sel ? "linear-gradient(135deg, #3a2a10, #4a3a18)" : "transparent",
                                color: sel ? "#f0c860" : "#5a5a70",
                                fontWeight: sel ? 700 : 400,
                                fontSize: 10,
                                cursor: "pointer",
                                transition: "all 0.2s",
                              }}
                            >
                              {o.label}
                            </button>
                          );
                        })}
                      </div>
                    );

                    return (
                      <div
                        style={{
                          marginBottom: 20,
                          padding: "14px 16px",
                          background: "linear-gradient(135deg, #14141d, #1a1a28)",
                          borderRadius: 10,
                          border: "1px solid #2a2a3a",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8" }}>
                            🔄 Fallback Providers
                          </span>
                          <span style={{ fontSize: 10, color: "#5a5a70" }}>
                            Auto-switch when primary is stuck or failing
                          </span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {fbBtn("🖼️ Images", "IMAGE_FALLBACK_PROVIDER", imgFb)}
                          {fbBtn("🎬 Video", "ANIMATION_FALLBACK_PROVIDER", animFb)}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Voice ID selector — hidden when TTS is off */}
                  {(editSettings.TTS_PROVIDER || "kieai") !== "off" && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 20,
                      padding: "12px 16px",
                      background: "linear-gradient(135deg, #14141d, #1a1a28)",
                      borderRadius: 10,
                      border: "1px solid #2a2a3a",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                      🎙️ Voice
                    </span>
                    <input
                      type="text"
                      className="input"
                      value={editSettings.TTS_VOICE_ID ?? ((editSettings.TTS_PROVIDER || "kieai") === "kieai" ? "DTKMou8ccj1ZaWGBiotd" : "Rachel")}
                      onChange={(e) => setEditSettings((prev) => ({ ...prev, TTS_VOICE_ID: e.target.value }))}
                      onBlur={(e) => updateChannelVoice(ch, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          updateChannelVoice(ch, (e.target as HTMLInputElement).value);
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      placeholder={
                        (editSettings.TTS_PROVIDER || "kieai") === "elevenlabs"
                          ? "ElevenLabs voice ID from Settings"
                          : (editSettings.TTS_PROVIDER || "kieai") === "kieai"
                            ? "Rachel"
                            : "Rachel"
                      }
                      style={{
                        flex: "1 1 180px",
                        maxWidth: 280,
                        padding: "6px 12px",
                        fontSize: 13,
                        background: "#0e0e18",
                        border: "1px solid #3a3a50",
                        borderRadius: 8,
                        color: "#e8e8f0",
                      }}
                    />
                    <span style={{ fontSize: 11, color: "#5a5a70" }}>
                      {(editSettings.TTS_PROVIDER || "kieai") === "elevenlabs"
                        ? "Uses your ElevenLabs API key + Voice ID from Settings → ElevenLabs Direct"
                        : (editSettings.TTS_PROVIDER || "kieai") === "kieai"
                          ? "Use voice names: Rachel, Adam, Antoni, Bella, Josh, Sam, etc."
                          : "Use ElevenLabs voice IDs or names"}
                    </span>
                  </div>
                  )}

                  {/* Model selectors */}
                  {(() => {
                    const provider = editSettings.IMAGE_PROVIDER || editSettings.TTS_PROVIDER || "kieai";
                    const imageModel = editSettings.IMAGE_MODEL || (provider === "kieai" ? "flux-kontext-pro" : "flux-schnell");
                    const videoModel = editSettings.ANIMATION_MODEL || (provider === "kieai" ? "veo3_fast" : "veo-video");

                    return (
                      <div
                        style={{
                          display: "flex",
                          gap: 14,
                          marginBottom: 20,
                          flexWrap: "wrap",
                        }}
                      >
                        {/* Image model */}
                        <div
                          style={{
                            flex: "1 1 280px",
                            padding: "12px 16px",
                            background: "linear-gradient(135deg, #14141d, #1a1a28)",
                            borderRadius: 10,
                            border: "1px solid #2a2a3a",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                              🖼️ Image Model
                            </span>
                          </div>
                          <ModelAutocomplete
                            value={imageModel}
                            onChange={(v) => setEditSettings((prev) => ({ ...prev, IMAGE_MODEL: v }))}
                            onCommit={(v) => updateChannelSetting(ch, "IMAGE_MODEL", v)}
                            options={IMAGE_MODELS}
                            placeholder="flux-kontext-pro"
                          />
                          <div style={{ fontSize: 10, color: "#5a5a70", marginTop: 6 }}>
                            Type to search or pick from the list
                          </div>
                        </div>

                        {/* Video model */}
                        <div
                          style={{
                            flex: "1 1 280px",
                            padding: "12px 16px",
                            background: "linear-gradient(135deg, #14141d, #1a1a28)",
                            borderRadius: 10,
                            border: "1px solid #2a2a3a",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                              🎥 Video Model
                            </span>
                          </div>
                          <ModelAutocomplete
                            value={videoModel}
                            onChange={(v) => setEditSettings((prev) => ({ ...prev, ANIMATION_MODEL: v }))}
                            onCommit={(v) => updateChannelSetting(ch, "ANIMATION_MODEL", v)}
                            options={VIDEO_MODELS}
                            placeholder="veo3_fast"
                          />
                          <div style={{ fontSize: 10, color: "#5a5a70", marginTop: 6 }}>
                            Type to search or pick from the list
                          </div>
                        </div>
                      </div>
                    );
                  {/* Model selectors end */}
                  })()}

                  {/* KieAI Fallback Defaults */}
                  {(() => {
                    const kieImageModel = editSettings.KIEAI_DEFAULT_IMAGE_MODEL || "flux-kontext-pro";
                    const kieVideoModel = editSettings.KIEAI_DEFAULT_VIDEO_MODEL || "veo3_fast";
                    const kieImageModels = IMAGE_MODELS.filter((m) => m.provider === "kieai");
                    const kieVideoModels = VIDEO_MODELS.filter((m) => m.provider === "kieai");

                    return (
                      <div
                        style={{
                          marginBottom: 20,
                          padding: "14px 16px",
                          background: "linear-gradient(135deg, #14141d 0%, #1a1528 100%)",
                          borderRadius: 10,
                          border: "1px solid #2a2a3a",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8" }}>
                            🔄 KieAI Fallback Defaults
                          </span>
                          <span style={{ fontSize: 10, color: "#5a5a70" }}>
                            Used when the primary provider fails and falls back to KieAI
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                          {/* KieAI Image Model */}
                          <div style={{ flex: "1 1 280px" }}>
                            <div style={{ fontSize: 11, color: "#7a7a90", marginBottom: 4, fontWeight: 600 }}>🖼️ Fallback Image Model</div>
                            <ModelAutocomplete
                              value={kieImageModel}
                              onChange={(v) => setEditSettings((prev) => ({ ...prev, KIEAI_DEFAULT_IMAGE_MODEL: v }))}
                              onCommit={(v) => updateChannelAnimation(ch, { KIEAI_DEFAULT_IMAGE_MODEL: v })}
                              options={kieImageModels}
                              placeholder="flux-kontext-pro"
                            />
                            <div style={{ fontSize: 10, color: "#5a5a70", marginTop: 4 }}>
                              Type or pick a KieAI image model
                            </div>
                          </div>
                          {/* KieAI Video Model */}
                          <div style={{ flex: "1 1 280px" }}>
                            <div style={{ fontSize: 11, color: "#7a7a90", marginBottom: 4, fontWeight: 600 }}>🎥 Fallback Video Model</div>
                            <ModelAutocomplete
                              value={kieVideoModel}
                              onChange={(v) => setEditSettings((prev) => ({ ...prev, KIEAI_DEFAULT_VIDEO_MODEL: v }))}
                              onCommit={(v) => updateChannelAnimation(ch, { KIEAI_DEFAULT_VIDEO_MODEL: v })}
                              options={kieVideoModels}
                              placeholder="veo3_fast"
                            />
                            <div style={{ fontSize: 10, color: "#5a5a70", marginTop: 4 }}>
                              Type or pick a KieAI video model
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Video quality selector */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 20,
                      padding: "12px 16px",
                      background: "linear-gradient(135deg, #14141d, #1a1a28)",
                      borderRadius: 10,
                      border: "1px solid #2a2a3a",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                      📐 Video Quality
                    </span>
                    {(["480p", "720p", "1080p"] as const).map((q) => {
                      const current = editSettings.VIDEO_QUALITY || "720p";
                      const isSelected = current === q;
                      return (
                        <button
                          key={q}
                          onClick={() => updateChannelAnimation(ch, { VIDEO_QUALITY: q })}
                          disabled={busy}
                          style={{
                            padding: "5px 14px",
                            borderRadius: 7,
                            border: isSelected ? "1.5px solid #7c5cff" : "1px solid #2a2a3a",
                            background: isSelected ? "linear-gradient(135deg, #2a1f5e, #3a2f7e)" : "transparent",
                            color: isSelected ? "#c8b8ff" : "#6a6a80",
                            fontWeight: isSelected ? 700 : 400,
                            fontSize: 12,
                            cursor: "pointer",
                            transition: "all 0.2s",
                          }}
                        >
                          {q}
                        </button>
                      );
                    })}
                    <span style={{ fontSize: 10, color: "#5a5a70" }}>
                      Required for Runway/Minimax/Wan models
                    </span>
                  </div>

                  {/* Animation ratio + distribution */}
                  {(() => {
                    const ratio = Number(editSettings.ANIMATION_RATIO_PERCENT ?? 50);
                    const dist = editSettings.ANIMATION_DISTRIBUTION || "first-half";
                    const isAllScenes = dist === "all" || ratio === 100;
                    const isOff = ratio === 0;

                    return (
                      <div
                        style={{
                          marginBottom: 20,
                          padding: "12px 16px",
                          background: "linear-gradient(135deg, #14141d, #1a1a28)",
                          borderRadius: 10,
                          border: "1px solid #2a2a3a",
                        }}
                      >
                        {/* Header + mode buttons */}
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: isAllScenes || isOff ? 0 : 12 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                            🎬 Animation
                          </span>

                          {/* Mode buttons */}
                          {([
                            { value: "off", label: "Off", desc: "Static images only" },
                            { value: "first-half", label: "First half", desc: "Animate first N scenes" },
                            { value: "alternating", label: "Alternating", desc: "Every other scene" },
                            { value: "random", label: "Random", desc: "Random selection" },
                            { value: "all", label: "All scenes", desc: "100% animated" },
                          ] as const).map((opt) => {
                            const isSelected =
                              opt.value === "off" ? isOff
                              : opt.value === "all" ? (isAllScenes && !isOff)
                              : (!isAllScenes && !isOff && dist === opt.value);
                            return (
                              <button
                                key={opt.value}
                                onClick={() => {
                                  if (opt.value === "off") {
                                    updateChannelAnimation(ch, {
                                      ANIMATION_RATIO_PERCENT: "0",
                                      ANIMATION_DISTRIBUTION: dist === "all" ? "first-half" : dist,
                                    });
                                  } else if (opt.value === "all") {
                                    updateChannelAnimation(ch, {
                                      ANIMATION_RATIO_PERCENT: "100",
                                      ANIMATION_DISTRIBUTION: "all",
                                    });
                                  } else {
                                    // Partial mode — if currently 100% or 0%, drop to 50%
                                    const newRatio = (ratio >= 100 || ratio === 0) ? "50" : String(ratio);
                                    updateChannelAnimation(ch, {
                                      ANIMATION_RATIO_PERCENT: newRatio,
                                      ANIMATION_DISTRIBUTION: opt.value,
                                    });
                                  }
                                }}
                                disabled={busy}
                                style={{
                                  padding: "5px 12px",
                                  borderRadius: 7,
                                  border: isSelected ? "1.5px solid #7c5cff" : "1px solid #2a2a3a",
                                  background: isSelected ? "linear-gradient(135deg, #2a1f5e, #3a2f7e)" : "transparent",
                                  color: isSelected ? "#c8b8ff" : "#6a6a80",
                                  fontWeight: isSelected ? 700 : 400,
                                  fontSize: 12,
                                  cursor: "pointer",
                                  transition: "all 0.2s",
                                }}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>

                        {/* Ratio slider — only shown in partial modes (not All scenes / Off) */}
                        {!isAllScenes && !isOff && (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                            <span style={{ fontSize: 11, color: "#6a6a80", whiteSpace: "nowrap" }}>Ratio</span>
                            <input
                              type="range"
                              min="10"
                              max="90"
                              step="10"
                              value={ratio}
                              onChange={(e) => setEditSettings((prev) => ({ ...prev, ANIMATION_RATIO_PERCENT: e.target.value }))}
                              onMouseUp={(e) => updateChannelAnimation(ch, { ANIMATION_RATIO_PERCENT: (e.target as HTMLInputElement).value })}
                              onTouchEnd={(e) => updateChannelAnimation(ch, { ANIMATION_RATIO_PERCENT: (e.target as HTMLInputElement).value })}
                              style={{
                                flex: 1,
                                accentColor: "#7c5cff",
                                cursor: "pointer",
                              }}
                            />
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: "#c8b8ff",
                                minWidth: 38,
                                textAlign: "center",
                                background: "#1a1a28",
                                border: "1px solid #3a3a50",
                                borderRadius: 6,
                                padding: "2px 6px",
                              }}
                            >
                              {ratio}%
                            </span>
                          </div>
                        )}

                        {/* Hint text */}
                        <div style={{ fontSize: 11, color: "#5a5a70", marginTop: 8 }}>
                          {isOff
                            ? "All scenes use static images with Ken Burns pan effect"
                            : isAllScenes
                            ? "Every image gets converted to a video clip"
                            : `${ratio}% of scenes get animated (${dist === "first-half" ? "starting from scene 1" : dist}), rest use Ken Burns`}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Director Mode toggle */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 20,
                      padding: "12px 16px",
                      background: "linear-gradient(135deg, #14141d, #1a1a28)",
                      borderRadius: 10,
                      border: "1px solid #2a2a3a",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                      🎬 Director Mode
                    </span>
                    {([
                      { value: "0", label: "Off — Standard Split", icon: "⏩" },
                      { value: "1", label: "On — AI Director Vision", icon: "🎩" },
                    ] as const).map((opt) => {
                      const current = editSettings.DIRECTOR_MODE === "1" ? "1" : "0";
                      const isSelected = current === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => updateChannelAnimation(ch, { DIRECTOR_MODE: opt.value === "1" ? "1" : "" })}
                          disabled={busy}
                          style={{
                            padding: "5px 14px",
                            borderRadius: 7,
                            border: isSelected ? "1.5px solid #7c5cff" : "1px solid #2a2a3a",
                            background: isSelected ? "linear-gradient(135deg, #2a1f5e, #3a2f7e)" : "transparent",
                            color: isSelected ? "#c8b8ff" : "#6a6a80",
                            fontWeight: isSelected ? 700 : 400,
                            fontSize: 12,
                            cursor: "pointer",
                            transition: "all 0.2s",
                          }}
                        >
                          {opt.icon} {opt.label}
                        </button>
                      );
                    })}
                    <span style={{ fontSize: 10, color: "#5a5a70" }}>
                      {editSettings.DIRECTOR_MODE === "1"
                        ? "AI Director analyzes full script first for 100% visual cohesion across scenes"
                        : "Standard scene splitting without overarching directorial theme"}
                    </span>
                  </div>

                  {/* Stock Footage Integration */}
                  {(() => {
                    const stockRatio = Number(editSettings.STOCK_FOOTAGE_RATIO_PERCENT ?? 0);
                    const stockProvider = editSettings.STOCK_FOOTAGE_PROVIDER || "all";
                    const isOff = stockRatio === 0 || stockProvider === "off";

                    return (
                      <div
                        style={{
                          marginBottom: 20,
                          padding: "12px 16px",
                          background: "linear-gradient(135deg, #14141d, #1a1a28)",
                          borderRadius: 10,
                          border: "1px solid #2a2a3a",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: isOff ? 0 : 12 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                            🎞️ Stock Footage
                          </span>

                          {/* Provider buttons */}
                          {([
                            { value: "off", label: "Off" },
                            { value: "all", label: "All (Round-Robin)" },
                            { value: "pexels", label: "Pexels" },
                            { value: "pixabay", label: "Pixabay" },
                          ] as const).map((opt) => {
                            const isSelected = opt.value === "off" ? isOff : (!isOff && stockProvider === opt.value);
                            return (
                              <button
                                key={opt.value}
                                onClick={() => {
                                  if (opt.value === "off") {
                                    updateChannelAnimation(ch, { STOCK_FOOTAGE_RATIO_PERCENT: "0", STOCK_FOOTAGE_PROVIDER: "off" });
                                  } else {
                                    const newRatio = stockRatio === 0 ? "30" : String(stockRatio);
                                    updateChannelAnimation(ch, { STOCK_FOOTAGE_RATIO_PERCENT: newRatio, STOCK_FOOTAGE_PROVIDER: opt.value });
                                  }
                                }}
                                disabled={busy}
                                style={{
                                  padding: "5px 12px",
                                  borderRadius: 7,
                                  border: isSelected ? "1.5px solid #7c5cff" : "1px solid #2a2a3a",
                                  background: isSelected ? "linear-gradient(135deg, #2a1f5e, #3a2f7e)" : "transparent",
                                  color: isSelected ? "#c8b8ff" : "#6a6a80",
                                  fontWeight: isSelected ? 700 : 400,
                                  fontSize: 12,
                                  cursor: "pointer",
                                  transition: "all 0.2s",
                                }}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>

                        {!isOff && (
                          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
                            <span style={{ fontSize: 11, color: "#6a6a80", whiteSpace: "nowrap" }}>Ratio</span>
                            <input
                              type="range"
                              min="10"
                              max="100"
                              step="10"
                              value={stockRatio}
                              onChange={(e) => setEditSettings((prev) => ({ ...prev, STOCK_FOOTAGE_RATIO_PERCENT: e.target.value }))}
                              onMouseUp={(e) => updateChannelAnimation(ch, { STOCK_FOOTAGE_RATIO_PERCENT: (e.target as HTMLInputElement).value })}
                              onTouchEnd={(e) => updateChannelAnimation(ch, { STOCK_FOOTAGE_RATIO_PERCENT: (e.target as HTMLInputElement).value })}
                              style={{
                                flex: 1,
                                accentColor: "#7c5cff",
                                cursor: "pointer",
                              }}
                            />
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 700,
                                color: "#c8b8ff",
                                minWidth: 38,
                                textAlign: "center",
                                background: "#1a1a28",
                                border: "1px solid #3a3a50",
                                borderRadius: 6,
                                padding: "2px 6px",
                              }}
                            >
                              {stockRatio}%
                            </span>
                          </div>
                        )}

                        <div style={{ fontSize: 11, color: "#5a5a70", marginTop: 8 }}>
                          {isOff
                            ? "100% AI generated clips and photos"
                            : `${stockRatio}% of scenes use real stock video from ${stockProvider === "all" ? "Pexels & Pixabay" : stockProvider}`}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Keep video audio toggle */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 20,
                      padding: "12px 16px",
                      background: "linear-gradient(135deg, #14141d, #1a1a28)",
                      borderRadius: 10,
                      border: "1px solid #2a2a3a",
                      flexWrap: "wrap",
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#b8b8c8", whiteSpace: "nowrap" }}>
                      🔊 Video Audio
                    </span>
                    {([
                      { value: "0", label: "Off — TTS only", icon: "🔇" },
                      { value: "1", label: "On — Mix with TTS", icon: "🔊" },
                    ] as const).map((opt) => {
                      const current = editSettings.ANIMATION_KEEP_VEO_AUDIO || "0";
                      const isSelected = current === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => updateChannelAnimation(ch, { ANIMATION_KEEP_VEO_AUDIO: opt.value })}
                          disabled={busy}
                          style={{
                            padding: "5px 14px",
                            borderRadius: 7,
                            border: isSelected ? "1.5px solid #7c5cff" : "1px solid #2a2a3a",
                            background: isSelected ? "linear-gradient(135deg, #2a1f5e, #3a2f7e)" : "transparent",
                            color: isSelected ? "#c8b8ff" : "#6a6a80",
                            fontWeight: isSelected ? 700 : 400,
                            fontSize: 12,
                            cursor: "pointer",
                            transition: "all 0.2s",
                          }}
                        >
                          {opt.icon} {opt.label}
                        </button>
                      );
                    })}
                    <span style={{ fontSize: 10, color: "#5a5a70" }}>
                      {editSettings.ANIMATION_KEEP_VEO_AUDIO === "1"
                        ? "Video's generated audio (ambient, SFX) mixed at 30% volume under TTS narration"
                        : "Only TTS narration is used — video audio is stripped"}
                    </span>
                  </div>

                  {/* Prompts header */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 12,
                      flexWrap: "wrap",
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 700, color: "#b8b8c8" }}>
                      Prompts for &ldquo;{ch.name}&rdquo;
                    </span>
                    <button
                      className="btn"
                      onClick={() => saveExpandedPrompts(ch)}
                      disabled={busy || !promptsDirty}
                      style={{
                        fontSize: 12,
                        padding: "4px 14px",
                        opacity: promptsDirty ? 1 : 0.5,
                      }}
                    >
                      Save prompts
                    </button>
                  </div>

                  {PROMPT_META.map((m) => (
                    <div key={m.name} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                        <label style={{ fontWeight: 600, fontSize: 13, color: "#b8b8c8" }}>
                          {m.label}
                        </label>
                      </div>
                      <p style={{ color: "#6a6a80", fontSize: 12, marginBottom: 6, lineHeight: 1.4 }}>
                        {m.hint}
                      </p>
                      <textarea
                        className="textarea"
                        rows={m.rows}
                        value={editPrompts[m.name] ?? ""}
                        onChange={(e) => {
                          setEditPrompts({ ...editPrompts, [m.name]: e.target.value });
                          setPromptsDirty(true);
                        }}
                      />
                    </div>
                  ))}

                  {!ch.is_active && (
                    <p style={{ color: "#6a6a80", fontSize: 11, fontStyle: "italic", marginTop: 4 }}>
                      This channel is not active. Prompts are saved directly to its stored snapshot.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Help text */}
      <div
        className="card"
        style={{
          marginTop: 20,
          background: "linear-gradient(90deg, #14141d, #1a1a28)",
          borderColor: "#2a2a3a",
        }}
      >
        <h3 style={{ fontWeight: 700, marginBottom: 8, fontSize: 14 }}>How channels work</h3>
        <ol style={{ paddingLeft: 20, lineHeight: 1.8, color: "#9090a8", fontSize: 13 }}>
          <li>
            <strong style={{ color: "#e8e8f0" }}>Create</strong> a channel for each niche
            (e.g. Space, Pirates, Cooking).
          </li>
          <li>
            <strong style={{ color: "#e8e8f0" }}>Click</strong> a channel name to expand and edit
            its prompts right here.
          </li>
          <li>
            <strong style={{ color: "#e8e8f0" }}>Switch to</strong> a channel — its prompts
            and niche settings load into the pipeline.
          </li>
          <li>
            <strong style={{ color: "#e8e8f0" }}>Pick a niche</strong> on the{" "}
            <a href="/" style={{ color: "#7c5cff" }}>New run</a> page before starting a run.
          </li>
        </ol>
      </div>
    </div>
  );
}
