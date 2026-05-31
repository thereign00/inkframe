import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import db from "@/lib/db";
import { ensureInit } from "@/lib/init";
import { runPipeline } from "@/lib/pipeline";
import { sanitizeFolderName, pickAvailableFolderName } from "@/lib/run-paths";

const insertRun = db.prepare(
  "INSERT INTO runs (id, title, folder_name, status, script, config_json) VALUES (?, ?, ?, 'pending', ?, ?)"
);
const listRuns = db.prepare(
  "SELECT id, title, folder_name, status, created_at, updated_at, output_path FROM runs ORDER BY created_at DESC LIMIT 50"
);

export async function GET() {
  ensureInit();
  return NextResponse.json(listRuns.all());
}

export async function POST(req: Request) {
  ensureInit();
  const body = (await req.json()) as { title?: string; script?: string };
  const script = (body.script ?? "").trim();
  if (!script) {
    return NextResponse.json({ error: "script is empty" }, { status: 400 });
  }

  const id = randomUUID();
  const baseFolderName = sanitizeFolderName(body.title ?? "", id.slice(0, 8));
  const folderName = pickAvailableFolderName(baseFolderName);

  insertRun.run(id, body.title ?? null, folderName, script, JSON.stringify({}));

  // Запускаємо пайплайн у фоні. На локалі цього досить.
  runPipeline(id, script).catch((e) => {
    // eslint-disable-next-line no-console
    console.error("pipeline crash", e);
  });

  return NextResponse.json({ id, folderName });
}
