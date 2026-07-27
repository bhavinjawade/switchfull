import { randomUUID } from "node:crypto";
import type { SwitchConfig } from "../schema/config.js";
import type { ParticipantRegistry } from "../connectors/registry.js";
import { ProtocolRegistry } from "../protocol/registry.js";
import { defaultHyperparams, parametersForProtocol } from "../protocol/parameters.js";
import { roleSlotsForProtocol } from "../protocol/roles.js";
import type { ParticipantRequest } from "../schema/participant.js";

export interface AutoCouncilDecision {
  readonly protocolId: string;
  readonly participants: readonly string[];
  readonly synthesizer: string;
  readonly critiqueRounds: number;
  readonly hyperparams: Readonly<Record<string, unknown>>;
  readonly roleBindings: Readonly<Record<string, string>>;
  readonly rationale: string;
  readonly source: "llm" | "default-fallback";
  readonly fallbackReason?: string;
}

export class AutoDecider {
  private readonly protocols = new ProtocolRegistry();

  constructor(
    private readonly config: SwitchConfig,
    private readonly registry: ParticipantRegistry,
  ) {}

  async decide(options: {
    readonly query: string;
    readonly goal?: string;
    readonly eligibleParticipants: readonly string[];
    readonly deciderParticipantId: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
  }): Promise<AutoCouncilDecision> {
    const eligible = options.eligibleParticipants.filter(
      (id) => this.config.participants[id]?.enabled,
    );
    const fallback = this.defaultDecision(eligible);
    if (eligible.length === 0) return fallback;

    try {
      const catalog = this.protocols.list();
      const prompt = [
        "You are the Switch auto-decider. Choose a council approach for this query.",
        "Respond with ONLY JSON matching:",
        '{"protocolId":string,"participants":string[],"synthesizer":string,"critiqueRounds":number,"roleBindings":Record<string,string>,"rationale":string}',
        "Rules:",
        "- protocolId must be one of the listed protocols",
        "- participants must be a non-empty subset of eligible IDs",
        "- synthesizer must be one of the chosen participants",
        "- critiqueRounds between 0 and 3",
        "",
        `Eligible participants: ${JSON.stringify(
          eligible.map((id) => {
            const p = this.config.participants[id];
            if (!p) throw new Error(`Eligible participant ${id} is missing from configuration.`);
            return { id, role: p.role, model: p.model, displayName: p.displayName };
          }),
        )}`,
        `Protocols: ${JSON.stringify(
          catalog.map((meta) => ({
            id: meta.id,
            name: meta.name,
            description: meta.description,
            parameters: parametersForProtocol(meta.id),
            roles: roleSlotsForProtocol(meta.id),
          })),
        )}`,
        options.goal ? `Session goal: ${options.goal}` : "",
        `Query: ${options.query}`,
      ]
        .filter(Boolean)
        .join("\n");

      const port = this.registry.resolve(options.deciderParticipantId);
      const request: ParticipantRequest = {
        requestId: randomUUID(),
        messages: [{ role: "user", content: prompt }],
        ...(port.snapshot.model ? { model: port.snapshot.model } : {}),
        workspace: options.cwd,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        idempotencyKey: `auto-decider:${options.query.slice(0, 64)}`,
        metadata: { purpose: "auto-decider" },
      };
      const result = await port.invoke(request, {
        cwd: options.cwd,
        timeoutMs: 120_000,
        ...(options.signal ? { signal: options.signal } : {}),
        thinking: "medium",
      });
      const parsed = parseDecisionJson(result.text);
      return this.authorize(parsed, eligible, fallback);
    } catch (error) {
      return {
        ...fallback,
        source: "default-fallback",
        fallbackReason: error instanceof Error ? error.message : String(error),
        rationale: `Fell back to defaults: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private defaultDecision(eligible: readonly string[]): AutoCouncilDecision {
    const profile = this.config.profiles[this.config.defaults.profile];
    const participants =
      eligible.length > 0
        ? eligible
        : (profile?.participants ?? Object.keys(this.config.participants).slice(0, 3));
    const protocolId = profile?.protocol ?? "independent-critique-synthesis";
    const synthesizer = profile?.synthesizer ?? participants[0] ?? "codex-architect";
    const critiqueRounds = profile?.critiqueRounds ?? 1;
    const roleBindings: Record<string, string> = {
      members: participants.join(","),
      synthesizer,
    };
    return {
      protocolId,
      participants,
      synthesizer,
      critiqueRounds,
      hyperparams: { ...defaultHyperparams(protocolId), critiqueRounds },
      roleBindings,
      rationale: "Product default council configuration.",
      source: "default-fallback",
    };
  }

  private authorize(
    raw: {
      protocolId?: string;
      participants?: string[];
      synthesizer?: string;
      critiqueRounds?: number;
      roleBindings?: Record<string, string>;
      rationale?: string;
    },
    eligible: readonly string[],
    fallback: AutoCouncilDecision,
  ): AutoCouncilDecision {
    const known = new Set(this.protocols.list().map((meta) => meta.id));
    const protocolId =
      raw.protocolId && known.has(raw.protocolId) ? raw.protocolId : fallback.protocolId;
    const participants = (raw.participants ?? []).filter((id) => eligible.includes(id)).slice(0, 5);
    if (participants.length === 0) {
      return {
        ...fallback,
        source: "default-fallback",
        fallbackReason: "auto-decider proposed no eligible participants",
      };
    }
    const synthesizer =
      raw.synthesizer && participants.includes(raw.synthesizer)
        ? raw.synthesizer
        : (participants[0] ?? fallback.synthesizer);
    const critiqueRounds = Math.max(
      0,
      Math.min(3, Math.trunc(raw.critiqueRounds ?? fallback.critiqueRounds)),
    );
    return {
      protocolId,
      participants,
      synthesizer,
      critiqueRounds,
      hyperparams: { ...defaultHyperparams(protocolId), critiqueRounds },
      roleBindings: raw.roleBindings ?? {
        members: participants.join(","),
        synthesizer,
      },
      rationale: raw.rationale ?? "Authorized auto-decider proposal.",
      source: "llm",
    };
  }
}

function parseDecisionJson(text: string): {
  protocolId?: string;
  participants?: string[];
  synthesizer?: string;
  critiqueRounds?: number;
  roleBindings?: Record<string, string>;
  rationale?: string;
} {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  const candidate = fenced ?? (first >= 0 && last > first ? text.slice(first, last + 1) : "");
  if (!candidate) throw new Error("Auto-decider returned no JSON object.");
  return JSON.parse(candidate) as {
    protocolId?: string;
    participants?: string[];
    synthesizer?: string;
    critiqueRounds?: number;
    roleBindings?: Record<string, string>;
    rationale?: string;
  };
}
