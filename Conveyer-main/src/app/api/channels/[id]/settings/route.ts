import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getChannelById, updateChannelSettings } from "@/lib/channels";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const ch = getChannelById(id);
  if (!ch) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  try {
    return NextResponse.json(JSON.parse(ch.settings_json));
  } catch {
    return NextResponse.json({});
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  try {
    const settings = await req.json();
    updateChannelSettings(id, settings);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
