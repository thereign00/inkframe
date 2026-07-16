import { NextResponse } from "next/server";
import db from "@/lib/db";
import { log } from "@/lib/logger";

const updateRunStatus = db.prepare("UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?");

export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  updateRunStatus.run(id);
  log(id, "info", "▶️ User clicked Resume. Pipeline continuing...", { stage: "pipeline" });
  return NextResponse.json({ success: true });
}
