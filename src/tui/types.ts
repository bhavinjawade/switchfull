import type { RunProgress } from "../runtime/executor.js";
import type { SessionState } from "../schema/session.js";

export type Screen = "splash" | "main" | "setup" | "help" | "council" | "protocols";

export interface StreamEntry {
  readonly id: string;
  readonly kind: "user" | "system" | "stage" | "invocation" | "decision" | "error" | "tool";
  readonly title: string;
  readonly body: string;
  readonly collapsed: boolean;
  readonly stageId?: string;
  readonly participantId?: string;
  readonly timestamp: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  reported: boolean;
  byParticipant: Record<string, { input: number; output: number; calls: number }>;
}

export interface LiveStatus {
  invoking?: string;
  phase?: string;
  stageId?: string;
  lastMessage?: string;
}

/** One council seat for the right-rail roles panel. */
export interface RailMember {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly model: string;
  readonly connector: string;
  readonly isSynthesizer: boolean;
  readonly isRouter: boolean;
}

export interface ApproachInfo {
  readonly id: string;
  readonly name: string;
  readonly paperTitle?: string;
  readonly paperUrl?: string;
}

export interface TuiModel {
  screen: Screen;
  session: SessionState;
  input: string;
  entries: StreamEntry[];
  scroll: number;
  setupIndex: number;
  setupStatuses: readonly {
    id: string;
    label: string;
    status: string;
    detail: string;
    /** Optional paper URL for approach picker rows. */
    paperUrl?: string;
  }[];
  protocolIndex: number;
  councilFocus: number;
  running: boolean;
  live: LiveStatus;
  usage: UsageTotals;
  statusLine: string;
  cwd: string;
  width: number;
  height: number;
  lastProgress?: RunProgress;
  /** Resolved roster for the rail (role + concrete model). */
  railMembers: readonly RailMember[];
  /** Current approach display + paper link. */
  approach: ApproachInfo;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    reported: false,
    byParticipant: {},
  };
}
