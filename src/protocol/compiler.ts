import { randomUUID } from "node:crypto";
import { SwitchError } from "../domain/errors.js";
import type { SwitchConfig } from "../schema/config.js";
import type { ExecutionPlan } from "../schema/execution-plan.js";
import { ProtocolRegistry } from "./registry.js";
import { assertValidPlan } from "./validator.js";

export interface CompileProfileOptions {
  readonly profileId: string;
  readonly protocolId?: string;
  readonly participants?: readonly string[];
  readonly synthesizer?: string;
  readonly critiqueRounds?: number;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly planId?: string;
}

export class ProtocolCompiler {
  constructor(readonly registry = new ProtocolRegistry()) {}

  compile(config: SwitchConfig, options: CompileProfileOptions): ExecutionPlan {
    const profile = config.profiles[options.profileId];
    if (!profile) {
      throw new SwitchError({
        code: "configuration_error",
        message: `Unknown profile ${options.profileId}.`,
        retry: "non_retryable",
      });
    }
    const requestedParticipants = options.participants ?? profile.participants;
    const participants = options.participants
      ? [...requestedParticipants]
      : requestedParticipants.filter((id) => {
          const participant = config.participants[id];
          if (!participant) return true;
          const connector = config.connectors[participant.connector];
          return participant.enabled && connector?.enabled !== false;
        });
    const protocolId =
      options.protocolId ??
      profile.protocol ??
      (profile.mode === "direct" ? "direct" : "independent-critique-synthesis");
    const protocol = this.registry.get(protocolId);
    if (participants.length < protocol.metadata.minimumParticipants) {
      throw new SwitchError({
        code: "protocol_error",
        message: `${protocol.metadata.name} requires at least ${protocol.metadata.minimumParticipants} participants.`,
        retry: "non_retryable",
      });
    }
    const profileSynthesizer =
      profile.synthesizer && participants.includes(profile.synthesizer)
        ? profile.synthesizer
        : undefined;
    const synthesizer = options.synthesizer ?? profileSynthesizer ?? participants[0];
    if (!synthesizer || !participants.includes(synthesizer)) {
      throw new SwitchError({
        code: "configuration_error",
        message: "The synthesizer must be one of the selected participants.",
        retry: "non_retryable",
      });
    }
    const context = {
      participants,
      synthesizer,
      critiqueRounds: options.critiqueRounds ?? profile.critiqueRounds ?? 0,
      timeoutMs: config.defaults.timeoutMs,
      budget: profile.budget,
      parameters: { ...profile.config, ...options.parameters },
    };
    const stages = [...protocol.compile(context)];
    const plan: ExecutionPlan = {
      apiVersion: "switch.dev/plan/v1alpha1",
      id: options.planId ?? randomUUID(),
      mode:
        profile.mode === "routed"
          ? "routed"
          : protocol.metadata.id === "direct"
            ? "direct"
            : "council",
      protocolId: protocol.metadata.id,
      protocolVersion: protocol.metadata.version,
      stages,
      entryStages: stages.filter((stage) => stage.dependsOn.length === 0).map((stage) => stage.id),
      finalStage: protocol.finalStage(context, stages),
      budget: profile.budget,
      metadata: {
        profileId: options.profileId,
        protocolName: protocol.metadata.name,
        protocolStatus: protocol.metadata.status,
        parameters: context.parameters,
      },
    };
    return assertValidPlan(plan, config);
  }
}
