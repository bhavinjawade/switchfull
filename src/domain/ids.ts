import { randomUUID } from "node:crypto";

declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type RunId = Brand<string, "RunId">;
export type StageId = Brand<string, "StageId">;
export type AttemptId = Brand<string, "AttemptId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type ParticipantId = Brand<string, "ParticipantId">;
export type ConnectorId = Brand<string, "ConnectorId">;
export type ProtocolId = Brand<string, "ProtocolId">;
export type RouterSessionId = Brand<string, "RouterSessionId">;
export type RoutingDecisionId = Brand<string, "RoutingDecisionId">;
export type EvaluationId = Brand<string, "EvaluationId">;
export type EventId = Brand<string, "EventId">;

export function createId<T extends string>(): Brand<string, T> {
  return randomUUID() as Brand<string, T>;
}

export const createRunId = (): RunId => createId<"RunId">();
export const createStageId = (): StageId => createId<"StageId">();
export const createAttemptId = (): AttemptId => createId<"AttemptId">();
export const createArtifactId = (): ArtifactId => createId<"ArtifactId">();
export const createRouterSessionId = (): RouterSessionId => createId<"RouterSessionId">();
export const createRoutingDecisionId = (): RoutingDecisionId => createId<"RoutingDecisionId">();
export const createEvaluationId = (): EvaluationId => createId<"EvaluationId">();
export const createEventId = (): EventId => createId<"EventId">();

function assertUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return value;
}

export function asParticipantId(value: string): ParticipantId {
  return value as ParticipantId;
}

export function asConnectorId(value: string): ConnectorId {
  return value as ConnectorId;
}

export function asProtocolId(value: string): ProtocolId {
  return value as ProtocolId;
}

export function asStageId(value: string): StageId {
  return value as StageId;
}

export function asRunId(value: string): RunId {
  return assertUuid(value, "Run ID") as RunId;
}

export function asRouterSessionId(value: string): RouterSessionId {
  return assertUuid(value, "Router session ID") as RouterSessionId;
}
