import { NextResponse } from "next/server";
import { ensureInit } from "@/lib/init";
import db from "@/lib/db";

/**
 * Fallback polling endpoint for logs when SSE fails.
 * Returns logs with id > `after` query param.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ensureInit();
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const after = parseInt(url.searchParams.get("after") || "0", 10) || 0;

  const rows = db
    .prepare(
      "SELECT id, ts, level, stage, message, data_json FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 200"
    )
    .all(id, after) as {
    id: number;
    ts: string;
    level: string;
    stage: string | null;
    message: string;
    data_json: string | null;
  }[];

  const entries = rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    runId: id,
    level: r.level,
    stage: r.stage ?? undefined,
    message: r.message,
    data: r.data_json ? JSON.parse(r.data_json) : undefined,
  }));

  return NextResponse.json(entries);
}
