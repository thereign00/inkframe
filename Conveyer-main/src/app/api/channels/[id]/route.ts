import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { renameChannel, deleteChannel, getChannelById } from "@/lib/channels";

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
    const { name } = await req.json();
    renameChannel(id, name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  try {
    deleteChannel(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
