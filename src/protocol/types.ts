import type { Budget } from "../schema/common.js";
import type { PlanStage } from "../schema/execution-plan.js";

export interface ProtocolMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly status: "stable" | "beta" | "experimental";
  readonly description: string;
  readonly citations: readonly string[];
  readonly minimumParticipants: number;
}

export interface ProtocolCompileContext {
  readonly participants: readonly string[];
  readonly synthesizer: string;
  readonly critiqueRounds: number;
  readonly timeoutMs: number;
  readonly budget: Budget;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ProtocolDefinition {
  readonly metadata: ProtocolMetadata;
  compile(context: ProtocolCompileContext): readonly PlanStage[];
  finalStage(context: ProtocolCompileContext, stages: readonly PlanStage[]): string;
}
