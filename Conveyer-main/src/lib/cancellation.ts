import db from "./db";
import { log } from "./logger";

/**
 * Cancellation registry with in-memory cache and SQLite database persistence.
 *
 * Why DB-backed: In Next.js dev server or multi-worker setups, module
 * evaluation can create isolated memory spaces. By checking the SQLite
 * `runs` table when a run is not in memory, we guarantee that clicking Stop
 * halts tasks in all processes and workers immediately.
 */
const cancelled = new Set<string>();

const getRunStatusStmt = db.prepare("SELECT status FROM runs WHERE id = ?");
const updateRunStatusStmt = db.prepare("UPDATE runs SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?");
const updateRunPausedStmt = db.prepare("UPDATE runs SET status = 'paused', updated_at = datetime('now') WHERE id = ?");

export function markCancelled(runId: string) {
  cancelled.add(runId);
  try {
    updateRunStatusStmt.run(runId);
  } catch {}
}

export function isCancelled(runId: string): boolean {
  if (cancelled.has(runId)) return true;
  try {
    const row = getRunStatusStmt.get(runId) as { status: string } | undefined;
    if (row && row.status === "cancelled") {
      cancelled.add(runId);
      return true;
    }
  } catch {}
  return false;
}

export function clearCancelled(runId: string) {
  cancelled.delete(runId);
}

/** Throws CancelledError if the run has been flagged for cancellation. */
export function checkCancelled(runId: string): void {
  if (isCancelled(runId)) {
    throw new CancelledError(`Run ${runId} cancelled by user`);
  }
}

/** Pauses the run in database and waits until user resumes or cancels. */
export async function pauseRun(runId: string, reason: string): Promise<void> {
  try {
    updateRunPausedStmt.run(runId);
  } catch {}
  log(runId, "warn", `⏸️ PIPELINE PAUSED: ${reason}`, { stage: "pipeline" });

  while (true) {
    await new Promise((r) => setTimeout(r, 3000));
    checkCancelled(runId);
    try {
      const row = getRunStatusStmt.get(runId) as { status: string } | undefined;
      if (row && row.status === "running") {
        log(runId, "info", "▶️ Pipeline resumed by user. Continuing...", { stage: "pipeline" });
        return;
      }
    } catch {}
  }
}

/** Checks if the run is paused and blocks until resumed or cancelled. */
export async function checkPausedOrCancelled(runId: string): Promise<void> {
  checkCancelled(runId);
  try {
    const row = getRunStatusStmt.get(runId) as { status: string } | undefined;
    if (row && row.status === "paused") {
      log(runId, "info", "⏸️ Pipeline is currently paused. Waiting for user to click Resume...", { stage: "pipeline" });
      while (true) {
        await new Promise((r) => setTimeout(r, 3000));
        checkCancelled(runId);
        const r2 = getRunStatusStmt.get(runId) as { status: string } | undefined;
        if (r2 && r2.status === "running") {
          log(runId, "info", "▶️ Pipeline resumed by user. Continuing...", { stage: "pipeline" });
          return;
        }
      }
    }
  } catch {}
}

export class CancelledError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CancelledError";
  }
}
