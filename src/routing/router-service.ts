import { createRoutingDecisionId, type RouterSessionId } from "../domain/ids.js";
import { asSwitchError } from "../domain/errors.js";
import type { ParticipantRegistry } from "../connectors/registry.js";
import type { SwitchConfig } from "../schema/config.js";
import type { RoutingDecision } from "../schema/routing.js";
import { ProtocolCompiler } from "../protocol/compiler.js";
import { validatePlan, type PlanValidation } from "../protocol/validator.js";
import { DeterministicRouter } from "./deterministic-router.js";
import { LlmRouter } from "./llm-router.js";
import type { RouterProposal } from "./schema.js";
import type { RouterSessionStore } from "./session-store.js";
import { type RouterSessionRecord, type RoutingScope } from "./session-store.js";

export interface RouteRequest {
  readonly query: string;
  readonly profileId?: string;
  readonly routerParticipantId?: string;
  readonly sessionId?: RouterSessionId;
  readonly scope?: RoutingScope;
  readonly eligibleParticipants?: readonly string[];
  readonly deterministic?: boolean;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface RouteResult {
  readonly session: RouterSessionRecord;
  readonly decision: RoutingDecision;
  readonly validation: PlanValidation;
  readonly source: "llm" | "deterministic" | "deterministic-fallback";
  readonly fallbackReason?: string;
}

function describeFallback(error: unknown): string {
  const normalized = asSwitchError(error);
  return `${normalized.code}: ${normalized.message}`;
}

function strategyProtocol(proposal: RouterProposal): string {
  if (proposal.strategy === "human_gate") return "human-gated-direct";
  if (proposal.strategy === "cached") {
    throw new Error("Cached routing is not available in local-v0.1.");
  }
  if (proposal.protocolId) return proposal.protocolId;
  switch (proposal.strategy) {
    case "single":
      return "direct";
    case "cascade":
    case "verify":
      return "cascade";
    case "sequential":
      return "generator-critic-verifier";
    case "parallel":
    case "council":
      return "independent-critique-synthesis";
  }
}

export class RouterService {
  private readonly deterministic: DeterministicRouter;
  private readonly compiler = new ProtocolCompiler();

  constructor(
    private readonly config: SwitchConfig,
    private readonly participants: ParticipantRegistry,
    private readonly sessions: RouterSessionStore,
  ) {
    this.deterministic = new DeterministicRouter(config);
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    const profileId = request.profileId ?? "router-balanced";
    const profile = this.config.profiles[profileId];
    if (!profile) throw new Error(`Unknown router profile ${profileId}.`);
    const routerParticipantId =
      request.routerParticipantId ?? profile.router ?? profile.participants[0];
    if (!routerParticipantId) throw new Error("No router participant is configured.");
    const eligible = request.eligibleParticipants ?? profile.participants;
    const session = request.sessionId
      ? this.sessions.get(request.sessionId)
      : this.sessions.create({
          routerParticipantId,
          profileId,
          scope: request.scope ?? "conversation",
          eligibleParticipants: eligible,
          budget: profile.budget,
        });
    if (session.routerParticipantId !== routerParticipantId) {
      throw new Error("A router session cannot change router participant.");
    }

    let proposal: RouterProposal;
    let source: RouteResult["source"];
    let fallbackReason: string | undefined;
    if (request.deterministic) {
      proposal = this.deterministic.propose(request.query, session);
      source = "deterministic";
    } else {
      try {
        const catalog = session.eligibleParticipants.map((id) => {
          const participant = this.config.participants[id];
          const connector = participant ? this.config.connectors[participant.connector] : undefined;
          return {
            id,
            displayName: participant?.displayName,
            kind: participant?.kind,
            model: participant?.model,
            expertise: participant?.expertise ?? [],
            tags: participant?.tags ?? [],
            billingType: connector?.billingType,
          };
        });
        proposal = await new LlmRouter(
          this.participants.resolve(routerParticipantId),
          catalog,
        ).propose(request.query, session, {
          cwd: request.cwd,
          timeoutMs: this.config.defaults.timeoutMs,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        source = "llm";
      } catch (error) {
        fallbackReason = describeFallback(error);
        proposal = this.deterministic.propose(request.query, session);
        source = "deterministic-fallback";
      }
    }
    proposal = this.sanitizeProposal(proposal, session);
    let plan;
    let validation: PlanValidation;
    try {
      plan = this.compileProposal(profileId, proposal, session, routerParticipantId);
      validation = validatePlan(plan, this.config);
      if (validation.outcome !== "accepted") {
        throw new Error(`Proposed plan was ${validation.outcome}.`);
      }
    } catch (error) {
      if (source !== "llm") throw error;
      fallbackReason = describeFallback(error);
      proposal = this.deterministic.propose(request.query, session);
      source = "deterministic-fallback";
      plan = this.compileProposal(profileId, proposal, session, routerParticipantId, true);
      validation = validatePlan(plan, this.config);
    }
    if (validation.outcome !== "accepted") {
      throw new Error(`Deterministic fallback plan was denied: ${JSON.stringify(validation)}`);
    }
    const decision: RoutingDecision = {
      apiVersion: "switch.dev/routing-decision/v1alpha1",
      id: createRoutingDecisionId(),
      routerSessionId: session.id,
      strategy: proposal.strategy,
      reason: proposal.reason,
      difficulty: proposal.difficulty,
      selectedParticipants: proposal.selectedParticipants,
      proposedPlan: plan,
      requestedBudget: plan.budget,
      alternatives: proposal.alternatives,
    };
    const updatedSession = this.sessions.append(
      session.id,
      {
        timestamp: new Date().toISOString(),
        querySummary: request.query.slice(0, 240),
        strategy: decision.strategy,
        selectedParticipants: decision.selectedParticipants,
        outcome: source === "deterministic-fallback" ? "fallback" : "accepted",
        ...(fallbackReason ? { fallbackReason } : {}),
      },
      `Last route used ${decision.strategy} with ${decision.selectedParticipants.join(", ")} for a ${decision.difficulty.level}-difficulty request.`,
    );
    return {
      session: updatedSession,
      decision,
      validation,
      source,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
  }

  private compileProposal(
    profileId: string,
    proposal: RouterProposal,
    session: RouterSessionRecord,
    routerParticipantId: string,
    fallback = false,
  ) {
    const synthesizer = proposal.selectedParticipants[0];
    if (!synthesizer) throw new Error("Router selected no participants.");
    const plan = this.compiler.compile(this.config, {
      profileId,
      protocolId: strategyProtocol(proposal),
      participants: proposal.selectedParticipants,
      synthesizer,
      critiqueRounds: proposal.critiqueRounds ?? 0,
      parameters: {
        routed: true,
        strategy: proposal.strategy,
        ...(fallback ? { fallback: true } : {}),
      },
    });
    return {
      ...plan,
      mode: "routed" as const,
      metadata: {
        ...plan.metadata,
        routerSessionId: session.id,
        routerParticipantId,
        routingStrategy: proposal.strategy,
        ...(fallback ? { fallback: true } : {}),
      },
    };
  }

  private sanitizeProposal(proposal: RouterProposal, session: RouterSessionRecord): RouterProposal {
    const allowed = new Set(session.eligibleParticipants);
    const selected = proposal.selectedParticipants.filter((id) => allowed.has(id));
    if (selected.length === 0) return this.deterministic.propose("", session);
    const maxParticipants = Math.max(1, Math.min(4, session.budget.maxConcurrency ?? 4));
    return {
      ...proposal,
      selectedParticipants: selected.slice(0, maxParticipants),
      alternatives: proposal.alternatives.filter((id) => allowed.has(id)),
      critiqueRounds: Math.min(proposal.critiqueRounds ?? 0, session.budget.maxRounds ?? 1),
    };
  }
}
