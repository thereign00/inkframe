import { NextResponse } from "next/server";
import db from "@/lib/db";
import { log } from "@/lib/logger";

const updateRunStatus = db.prepare("UPDATE runs SET status = 'paused', updated_at = datetime('now') WHERE id = ?");

export async function POST(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  updateRunStatus.run(id);
  log(id, "warn", "⏸️ Pipeline paused by user.", { stage: "pipeline" });
  return NextResponse.json({ success: true });
}
