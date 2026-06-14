import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { duplicateChannel } from "@/lib/channels";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await params;
  try {
    const { name } = await req.json();
    const channel = duplicateChannel(id, name);
    return NextResponse.json(channel);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
