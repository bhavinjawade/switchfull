export interface SettledValue<T> {
  readonly status: "fulfilled";
  readonly value: T;
}

export interface SettledFailure {
  readonly status: "rejected";
  readonly reason: unknown;
}

export type Settled<T> = SettledValue<T> | SettledFailure;

function rejectionError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Operation cancelled.");
}

export async function parallelMap<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<readonly Settled<R>[]> {
  if (items.length === 0) return [];
  const entries = items.map((item, index) => ({ index, item }));
  const output: (Settled<R> | undefined)[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < entries.length) {
      const index = next;
      next += 1;
      const entry = entries[index];
      if (!entry) throw new Error(`Missing parallel-map entry ${index}.`);
      try {
        output[index] = {
          status: "fulfilled",
          value: await operation(entry.item, entry.index),
        };
      } catch (reason) {
        output[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return output.map((result, index) => {
    if (!result) throw new Error(`Parallel-map worker did not produce result ${index}.`);
    return result;
  });
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(rejectionError(signal?.reason));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
