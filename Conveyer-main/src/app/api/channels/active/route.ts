import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { getActiveChannel, switchChannel, saveActiveChannel } from "@/lib/channels";

export async function GET() {
  ensureInit();
  return NextResponse.json(getActiveChannel());
}

export async function POST(req: Request) {
  ensureInit();
  try {
    const { id } = await req.json();
    switchChannel(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}

export async function PUT() {
  ensureInit();
  try {
    saveActiveChannel();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
