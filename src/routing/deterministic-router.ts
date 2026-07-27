import type { SwitchConfig } from "../schema/config.js";
import type { RouterProposal } from "./schema.js";
import { estimateDifficulty, inferExpertise } from "./difficulty.js";
import type { RouterSessionRecord } from "./session-store.js";

function scoreParticipant(id: string, config: SwitchConfig, expertise: readonly string[]): number {
  const participant = config.participants[id];
  if (!participant?.enabled) return Number.NEGATIVE_INFINITY;
  const connector = config.connectors[participant.connector];
  if (!connector?.enabled) return Number.NEGATIVE_INFINITY;
  let score = participant.expertise.filter((item) => expertise.includes(item)).length * 4;
  score += participant.tags.filter((item) => expertise.includes(item)).length * 2;
  if (connector.billingType === "free_tier" || connector.billingType === "local_compute")
    score += 1;
  if (participant.costPolicy === "free-only") score += 1;
  return score;
}

export class DeterministicRouter {
  constructor(private readonly config: SwitchConfig) {}

  propose(query: string, session: RouterSessionRecord): RouterProposal {
    const difficulty = estimateDifficulty(query);
    const expertise = inferExpertise(query);
    const ranked = [...session.eligibleParticipants].sort(
      (left, right) =>
        scoreParticipant(right, this.config, expertise) -
          scoreParticipant(left, this.config, expertise) || left.localeCompare(right),
    );
    const available = ranked.filter(
      (id) => scoreParticipant(id, this.config, expertise) > Number.NEGATIVE_INFINITY,
    );
    if (available.length === 0) throw new Error("No eligible participants are available.");
    if (difficulty.level === "low" || available.length === 1) {
      return {
        strategy: "single",
        reason: "Low-complexity request fits one best-matched participant.",
        difficulty: { level: difficulty.level, confidence: difficulty.confidence },
        selectedParticipants: available.slice(0, 1),
        protocolId: "direct",
        critiqueRounds: 0,
        alternatives: available.slice(1, 3),
      };
    }
    if (difficulty.level === "medium" || available.length === 2) {
      return {
        strategy: "cascade",
        reason: "Moderate complexity benefits from a primary answer and independent verification.",
        difficulty: { level: difficulty.level, confidence: difficulty.confidence },
        selectedParticipants: available.slice(0, 2),
        protocolId: "cascade",
        critiqueRounds: 0,
        alternatives: available.slice(2, 4),
      };
    }
    const selected = available.slice(0, Math.min(4, available.length));
    return {
      strategy: "council",
      reason:
        difficulty.level === "extreme"
          ? "Extreme complexity warrants diverse generation, critique, and synthesis."
          : "High complexity and risk warrant a multi-model council.",
      difficulty: { level: difficulty.level, confidence: difficulty.confidence },
      selectedParticipants: selected,
      protocolId:
        difficulty.signals.includes("high_risk_domain") && selected.length >= 3
          ? "generator-critic-verifier"
          : "independent-critique-synthesis",
      critiqueRounds: 1,
      alternatives: available.slice(selected.length),
    };
  }
}
