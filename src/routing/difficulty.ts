export interface DifficultyEstimate {
  readonly level: "low" | "medium" | "high" | "extreme";
  readonly confidence: number;
  readonly signals: readonly string[];
}

const highRiskTerms =
  /\b(security|production|migration|architecture|legal|medical|financial|incident|vulnerability|distributed|concurrency)\b/i;
const codingTerms =
  /\b(code|repository|implement|debug|typescript|javascript|python|rust|api|database|test|refactor)\b/i;
const researchTerms =
  /\b(research|paper|compare|evidence|sources|literature|analyze|investigate)\b/i;

export function estimateDifficulty(query: string): DifficultyEstimate {
  const length = query.length;
  const signals: string[] = [];
  let score = 0;
  if (length > 6_000) {
    score += 4;
    signals.push("very_long_context");
  } else if (length > 1_500) {
    score += 3;
    signals.push("long_context");
  } else if (length > 400) {
    score += 1;
    signals.push("moderate_context");
  }
  if (highRiskTerms.test(query)) {
    score += 3;
    signals.push("high_risk_domain");
  }
  if (codingTerms.test(query)) {
    score += 1;
    signals.push("coding");
  }
  if (researchTerms.test(query)) {
    score += 1;
    signals.push("research");
  }
  const subquestions = (query.match(/[?]/g) ?? []).length;
  if (subquestions > 2) {
    score += 1;
    signals.push("multiple_subquestions");
  }
  const level = score >= 6 ? "extreme" : score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return {
    level,
    confidence: Math.min(0.95, 0.58 + signals.length * 0.07),
    signals,
  };
}

export function inferExpertise(query: string): readonly string[] {
  const expertise: string[] = [];
  if (codingTerms.test(query)) expertise.push("coding", "debugging", "repository-analysis");
  if (researchTerms.test(query)) expertise.push("research", "analysis", "long-context");
  if (highRiskTerms.test(query)) expertise.push("adversarial-review", "critique");
  if (expertise.length === 0) expertise.push("analysis");
  return [...new Set(expertise)];
}
