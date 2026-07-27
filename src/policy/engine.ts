import { SwitchError } from "../domain/errors.js";
import type { SwitchConfig } from "../schema/config.js";
import type { ExecutionPlan } from "../schema/execution-plan.js";

export type DataClass = "public" | "internal" | "confidential" | "restricted";

export interface PolicyViolation {
  readonly code: string;
  readonly message: string;
  readonly participantId?: string;
}

export interface PolicyDecision {
  readonly outcome: "allowed" | "denied" | "requires_human";
  readonly dataClass: DataClass;
  readonly violations: readonly PolicyViolation[];
  readonly evaluatedAt: string;
  readonly policyVersion: "local-v1";
}

export class PolicyEngine {
  constructor(private readonly config: SwitchConfig) {}

  evaluate(plan: ExecutionPlan, dataClass: DataClass): PolicyDecision {
    const violations: PolicyViolation[] = [];
    const participantIds = new Set(plan.stages.flatMap((stage) => stage.participants));
    for (const participantId of participantIds) {
      const participant = this.config.participants[participantId];
      if (!participant) continue;
      const connector = this.config.connectors[participant.connector];
      if (!connector) continue;
      if (
        connector.billingType === "prepaid_subscription" &&
        (this.config.policy.deployment === "hosted" ||
          !this.config.policy.allowPersonalSubscriptions)
      ) {
        violations.push({
          code:
            this.config.policy.deployment === "hosted"
              ? "personal_subscription_in_hosted_mode"
              : "personal_subscription_disabled",
          message: `Personal subscription participant ${participantId} is disabled by policy.`,
          participantId,
        });
      }
      if (
        dataClass === "restricted" &&
        connector.kind !== "embedded" &&
        connector.kind !== "human"
      ) {
        violations.push({
          code: "restricted_data_external_connector",
          message: `Restricted data cannot be sent to external participant ${participantId}.`,
          participantId,
        });
      }
    }
    return {
      outcome: violations.length ? "denied" : "allowed",
      dataClass,
      violations,
      evaluatedAt: new Date().toISOString(),
      policyVersion: "local-v1",
    };
  }

  assertAllowed(plan: ExecutionPlan, dataClass: DataClass): PolicyDecision {
    const decision = this.evaluate(plan, dataClass);
    if (decision.outcome !== "allowed") {
      throw new SwitchError({
        code: "policy_denied",
        message: "Execution plan was denied by deterministic policy.",
        retry: "non_retryable",
        details: { decision },
      });
    }
    return decision;
  }
}
