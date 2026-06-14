import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import { listChannels, createChannel } from "@/lib/channels";

export async function GET() {
  ensureInit();
  return NextResponse.json(listChannels());
}

export async function POST(req: Request) {
  ensureInit();
  try {
    const { name, fromActive } = await req.json();
    const channel = createChannel(name, fromActive);
    return NextResponse.json(channel);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
