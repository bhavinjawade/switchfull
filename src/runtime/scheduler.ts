import { asSwitchError, SwitchError } from "../domain/errors.js";

function rejectionError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Operation cancelled.");
}

interface QueuedWork<T> {
  readonly connectorId: string;
  readonly priority: number;
  readonly sequence: number;
  readonly signal?: AbortSignal;
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  readonly removeAbortListener?: () => void;
}

interface CircuitState {
  failures: number;
  openedAt?: number;
  lastError?: string;
}

export interface SchedulerSnapshot {
  readonly active: number;
  readonly queued: number;
  readonly connectors: Readonly<
    Record<
      string,
      {
        readonly active: number;
        readonly failures: number;
        readonly circuit: "closed" | "open";
        readonly lastError?: string;
      }
    >
  >;
}

export class InvocationScheduler {
  private readonly queue: QueuedWork<unknown>[] = [];
  private readonly activeByConnector = new Map<string, number>();
  private readonly circuits = new Map<string, CircuitState>();
  private active = 0;
  private sequence = 0;

  constructor(
    private readonly options: {
      readonly maxConcurrency?: number;
      readonly perConnectorConcurrency?: number;
      readonly failureThreshold?: number;
      readonly circuitCooldownMs?: number;
    } = {},
  ) {}

  run<T>(
    connectorId: string,
    operation: () => Promise<T>,
    options: { readonly priority?: number; readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    try {
      this.assertCircuit(connectorId);
    } catch (error) {
      return Promise.reject(rejectionError(error));
    }
    if (options.signal?.aborted) {
      return Promise.reject(rejectionError(options.signal.reason));
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        const index = this.queue.indexOf(work);
        if (index === -1) return;
        this.queue.splice(index, 1);
        work.removeAbortListener?.();
        work.reject(work.signal?.reason ?? new Error("cancelled"));
        this.pump();
      };
      const work = {
        connectorId,
        priority: options.priority ?? 0,
        sequence: this.sequence++,
        ...(options.signal ? { signal: options.signal } : {}),
        operation,
        resolve,
        reject,
        ...(options.signal
          ? {
              removeAbortListener: () => options.signal?.removeEventListener("abort", abort),
            }
          : {}),
      } as QueuedWork<unknown>;
      this.queue.push(work);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      this.queue.sort(
        (left, right) => right.priority - left.priority || left.sequence - right.sequence,
      );
      this.pump();
    });
  }

  snapshot(): SchedulerSnapshot {
    const connectorIds = new Set([
      ...this.activeByConnector.keys(),
      ...this.circuits.keys(),
      ...this.queue.map((work) => work.connectorId),
    ]);
    return {
      active: this.active,
      queued: this.queue.length,
      connectors: Object.fromEntries(
        [...connectorIds].map((connectorId) => {
          const circuit = this.circuits.get(connectorId) ?? { failures: 0 };
          return [
            connectorId,
            {
              active: this.activeByConnector.get(connectorId) ?? 0,
              failures: circuit.failures,
              circuit: this.isCircuitOpen(circuit) ? "open" : "closed",
              ...(circuit.lastError ? { lastError: circuit.lastError } : {}),
            },
          ];
        }),
      ),
    };
  }

  private pump(): void {
    const maxConcurrency = this.options.maxConcurrency ?? 8;
    const perConnector = this.options.perConnectorConcurrency ?? 4;
    while (this.active < maxConcurrency) {
      const index = this.queue.findIndex(
        (work) => (this.activeByConnector.get(work.connectorId) ?? 0) < perConnector,
      );
      if (index === -1) return;
      const [work] = this.queue.splice(index, 1);
      if (!work) return;
      work.removeAbortListener?.();
      if (work.signal?.aborted) {
        work.reject(work.signal.reason ?? new Error("cancelled"));
        continue;
      }
      try {
        this.assertCircuit(work.connectorId);
      } catch (error) {
        work.reject(error);
        continue;
      }
      this.active += 1;
      this.activeByConnector.set(
        work.connectorId,
        (this.activeByConnector.get(work.connectorId) ?? 0) + 1,
      );
      void work
        .operation()
        .then((value) => {
          this.circuits.set(work.connectorId, { failures: 0 });
          this.release(work.connectorId);
          work.resolve(value);
        })
        .catch((error: unknown) => {
          this.recordFailure(work.connectorId, error);
          this.release(work.connectorId);
          work.reject(error);
        });
    }
  }

  private release(connectorId: string): void {
    this.active -= 1;
    this.activeByConnector.set(
      connectorId,
      Math.max(0, (this.activeByConnector.get(connectorId) ?? 1) - 1),
    );
    this.pump();
  }

  private recordFailure(connectorId: string, error: unknown): void {
    const failure = asSwitchError(error);
    if (
      ![
        "connector_unavailable",
        "provider_error",
        "rate_limited",
        "quota_exhausted",
        "timeout",
      ].includes(failure.code)
    ) {
      return;
    }
    const state = this.circuits.get(connectorId) ?? { failures: 0 };
    state.failures += 1;
    state.lastError = failure.message;
    if (state.failures >= (this.options.failureThreshold ?? 5)) {
      state.openedAt = Date.now();
    }
    this.circuits.set(connectorId, state);
  }

  private assertCircuit(connectorId: string): void {
    const state = this.circuits.get(connectorId);
    if (!state || !this.isCircuitOpen(state)) return;
    throw new SwitchError({
      code: "connector_unavailable",
      message: `Circuit for connector ${connectorId} is open.`,
      retry: "retryable",
      details: {
        connectorId,
        failures: state.failures,
        retryAfterMs:
          (state.openedAt ?? Date.now()) + (this.options.circuitCooldownMs ?? 30_000) - Date.now(),
      },
    });
  }

  private isCircuitOpen(state: CircuitState): boolean {
    if (state.openedAt === undefined) return false;
    if (Date.now() - state.openedAt < (this.options.circuitCooldownMs ?? 30_000)) {
      return true;
    }
    state.failures = 0;
    delete state.openedAt;
    return false;
  }
}
