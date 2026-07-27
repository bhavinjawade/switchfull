import { randomUUID } from "node:crypto";
import type { ParticipantPort } from "../connectors/port.js";
import { SwitchError } from "../domain/errors.js";
import { compileValidator } from "../schema/validator.js";
import type { ParticipantRequest } from "../schema/participant.js";
import { RouterProposalSchema, type RouterProposal } from "./schema.js";
import type { RouterSessionRecord } from "./session-store.js";

const validateProposal = compileValidator(RouterProposalSchema);

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

function routerPrompt(
  query: string,
  session: RouterSessionRecord,
  candidates: readonly Readonly<Record<string, unknown>>[],
  repair?: string,
): string {
  return [
    "You are the selected Switch router. Propose a bounded route; deterministic code will authorize it.",
    "Never include commands, credentials, tools, or participants outside the supplied catalog.",
    "Choose strategy, participant IDs, and an optional protocol. Optimize quality, expertise, latency, and budget.",
    "Allowed strategies: single, parallel, sequential, council, verify, cascade, human_gate.",
    "Useful protocols: direct, independent-critique-synthesis, generator-critic-verifier, cascade, jury, reconcile, multi-agent-debate.",
    `Eligible candidates:\n${JSON.stringify(candidates, null, 2)}`,
    session.summary ? `Session summary:\n${session.summary}` : "",
    session.history.length
      ? `Recent routing history:\n${JSON.stringify(session.history.slice(-5), null, 2)}`
      : "",
    `<USER_QUERY>\n${query}\n</USER_QUERY>`,
    repair ? `Your previous output was invalid. Repair it using this error:\n${repair}` : "",
    "Return only JSON with: strategy, reason, difficulty {level, confidence}, selectedParticipants, optional protocolId, optional critiqueRounds, alternatives.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class LlmRouter {
  constructor(
    private readonly participant: ParticipantPort,
    private readonly candidates: readonly Readonly<Record<string, unknown>>[],
  ) {}

  async propose(
    query: string,
    session: RouterSessionRecord,
    context: { readonly cwd: string; readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<RouterProposal> {
    let repair: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const request: ParticipantRequest = {
        requestId: randomUUID(),
        messages: [
          {
            role: "user",
            content: routerPrompt(query, session, this.candidates, repair),
          },
        ],
        outputSchema: RouterProposalSchema,
        workspace: context.cwd,
        metadata: { purpose: "routing", routerSessionId: session.id, attempt },
      };
      try {
        const result = await this.participant.invoke(request, {
          cwd: context.cwd,
          timeoutMs: context.timeoutMs,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return validateProposal(extractJson(result.text));
      } catch (error) {
        if (
          error instanceof SwitchError &&
          [
            "authentication_error",
            "cancelled",
            "connector_unavailable",
            "policy_denied",
            "quota_exhausted",
            "rate_limited",
            "timeout",
          ].includes(error.code)
        ) {
          throw error;
        }
        repair = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`Router failed to produce a valid proposal: ${repair ?? "unknown error"}`);
  }
}
