import db from "./db";

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

export class CancelledError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CancelledError";
  }
}
