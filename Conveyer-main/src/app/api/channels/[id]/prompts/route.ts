import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getChannelById, updateChannelPrompts } from "@/lib/channels";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  const ch = getChannelById(id);
  if (!ch) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  return NextResponse.json(ch);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  try {
    const prompts = await req.json();
    updateChannelPrompts(id, prompts);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
