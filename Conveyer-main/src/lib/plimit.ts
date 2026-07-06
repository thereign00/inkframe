export interface LimitFunction {
  <T>(fn: () => Promise<T>): Promise<T>;
  clearQueue: (reason?: unknown) => void;
}

/**
 * Tiny in-memory concurrency limiter with zero dependencies.
 *
 * Usage:
 *   const limit = pLimit(5);
 *   await Promise.all(items.map(item => limit(() => processItem(item))));
 *   limit.clearQueue(new Error("Cancelled"));
 */
export function pLimit(concurrency: number): LimitFunction {
  if (concurrency < 1) concurrency = 1;
  let active = 0;
  const queue: Array<{ run: () => void; reject: (err: unknown) => void }> = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const task = queue.shift()!;
    task.run();
  };

  const limiter = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        run: () => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active--;
              next();
            });
        },
        reject,
      });
      next();
    });

  const result = limiter as LimitFunction;
  result.clearQueue = (reason?: unknown) => {
    while (queue.length > 0) {
      const task = queue.shift()!;
      task.reject(reason ?? new Error("Queue cleared"));
    }
  };

  return result;
}
