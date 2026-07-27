import type { EvaluationCase } from "./dataset.js";

export interface EvaluationScore {
  readonly value: number;
  readonly passed: boolean;
  readonly dimensions: Readonly<Record<string, number>>;
  readonly explanation: string;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function scoreOutput(item: EvaluationCase, output: string): EvaluationScore {
  const expected = item.expected;
  if (!expected) {
    return {
      value: output.trim() ? 1 : 0,
      passed: Boolean(output.trim()),
      dimensions: { nonEmpty: output.trim() ? 1 : 0 },
      explanation: "No reference expectation; scored for a non-empty result only.",
    };
  }
  const dimensions: Record<string, number> = {};
  if (expected.exact !== undefined) {
    dimensions["exact"] = normalize(output) === normalize(expected.exact) ? 1 : 0;
  }
  if (expected.containsAll?.length) {
    const normalized = normalize(output);
    dimensions["containsAll"] =
      expected.containsAll.filter((term) => normalized.includes(normalize(term))).length /
      expected.containsAll.length;
  }
  if (expected.containsAny?.length) {
    const normalized = normalize(output);
    dimensions["containsAny"] = expected.containsAny.some((term) =>
      normalized.includes(normalize(term)),
    )
      ? 1
      : 0;
  }
  const values = Object.values(dimensions);
  const value = values.length
    ? values.reduce((total, current) => total + current, 0) / values.length
    : 0;
  return {
    value,
    passed: value >= 0.999,
    dimensions,
    explanation: `Deterministic reference score across ${values.length} dimension(s).`,
  };
}
