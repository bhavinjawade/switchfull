import { SwitchError } from "./errors.js";

export const runStatuses = [
  "created",
  "validating",
  "planned",
  "queued",
  "running",
  "waiting_for_human",
  "paused",
  "recovering",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
] as const;
export type RunStatus = (typeof runStatuses)[number];

export const stageStatuses = [
  "pending",
  "ready",
  "running",
  "waiting_for_human",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "skipped",
] as const;
export type StageStatus = (typeof stageStatuses)[number];

export const attemptStatuses = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
] as const;
export type AttemptStatus = (typeof attemptStatuses)[number];

export const terminalRunStatuses = new Set<RunStatus>(["cancelled", "failed", "completed"]);
export const terminalStageStatuses = new Set<StageStatus>([
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export const terminalAttemptStatuses = new Set<AttemptStatus>([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "unknown",
]);

const runTransitions: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  created: new Set(["validating", "cancelling", "failed"]),
  validating: new Set(["planned", "cancelling", "failed"]),
  planned: new Set(["queued", "cancelling", "failed"]),
  queued: new Set(["running", "cancelling", "failed"]),
  running: new Set([
    "waiting_for_human",
    "paused",
    "recovering",
    "cancelling",
    "failed",
    "completed",
  ]),
  waiting_for_human: new Set(["running", "paused", "cancelling", "failed"]),
  paused: new Set(["running", "recovering", "cancelling", "failed"]),
  recovering: new Set(["running", "paused", "cancelling", "failed"]),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  failed: new Set(),
  completed: new Set(),
};

const stageTransitions: Readonly<Record<StageStatus, ReadonlySet<StageStatus>>> = {
  pending: new Set(["ready", "cancelled", "skipped"]),
  ready: new Set(["running", "cancelled", "skipped"]),
  running: new Set(["waiting_for_human", "paused", "completed", "failed", "cancelled"]),
  waiting_for_human: new Set(["running", "paused", "failed", "cancelled"]),
  paused: new Set(["ready", "running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  skipped: new Set(),
};

const attemptTransitions: Readonly<Record<AttemptStatus, ReadonlySet<AttemptStatus>>> = {
  pending: new Set(["running", "cancelled"]),
  running: new Set(["succeeded", "failed", "timed_out", "cancelled", "unknown"]),
  succeeded: new Set(),
  failed: new Set(),
  timed_out: new Set(),
  cancelled: new Set(),
  unknown: new Set(),
};

function assertTransition<T extends string>(
  kind: string,
  transitions: Readonly<Record<T, ReadonlySet<T>>>,
  from: T,
  to: T,
): void {
  if (from === to || transitions[from].has(to)) return;
  throw new SwitchError({
    code: "validation_error",
    message: `Invalid ${kind} transition: ${from} -> ${to}`,
    retry: "non_retryable",
    details: { kind, from, to },
  });
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  assertTransition("run", runTransitions, from, to);
}

export function assertStageTransition(from: StageStatus, to: StageStatus): void {
  assertTransition("stage", stageTransitions, from, to);
}

export function assertAttemptTransition(from: AttemptStatus, to: AttemptStatus): void {
  assertTransition("attempt", attemptTransitions, from, to);
}
