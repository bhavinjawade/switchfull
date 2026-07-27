import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { hashObject } from "../domain/hash.js";

export interface EvaluationExpectation {
  readonly exact?: string;
  readonly containsAll?: readonly string[];
  readonly containsAny?: readonly string[];
}

export interface EvaluationCase {
  readonly id: string;
  readonly input: string;
  readonly expected?: EvaluationExpectation;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EvaluationDataset {
  readonly name: string;
  readonly cases: readonly EvaluationCase[];
  readonly hash: string;
  readonly source?: string;
}

function validateCase(value: unknown, index: number): EvaluationCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Dataset case ${index + 1} must be an object.`);
  }
  const item = value as Record<string, unknown>;
  if (typeof item["id"] !== "string" || !item["id"]) {
    throw new Error(`Dataset case ${index + 1} requires a non-empty id.`);
  }
  if (typeof item["input"] !== "string" || !item["input"].trim()) {
    throw new Error(`Dataset case ${item["id"]} requires non-empty input.`);
  }
  const expected = item["expected"];
  if (
    expected !== undefined &&
    (!expected || typeof expected !== "object" || Array.isArray(expected))
  ) {
    throw new Error(`Dataset case ${item["id"]} expected must be an object.`);
  }
  return value as EvaluationCase;
}

export function createDataset(
  name: string,
  cases: readonly EvaluationCase[],
  source?: string,
): EvaluationDataset {
  if (cases.length === 0) throw new Error("Evaluation dataset cannot be empty.");
  if (cases.length > 10_000) throw new Error("Evaluation dataset exceeds 10,000 cases.");
  const ids = new Set<string>();
  cases.forEach((item, index) => {
    validateCase(item, index);
    if (ids.has(item.id)) throw new Error(`Duplicate evaluation case ID ${item.id}.`);
    ids.add(item.id);
  });
  return {
    name,
    cases,
    hash: hashObject({ name, cases }),
    ...(source ? { source } : {}),
  };
}

export function loadDataset(path: string): EvaluationDataset {
  const content = readFileSync(path, "utf8");
  if (Buffer.byteLength(content) > 50 * 1024 * 1024) {
    throw new Error("Evaluation dataset exceeds the 50 MiB limit.");
  }
  let name = path;
  let values: unknown[];
  if (extname(path).toLowerCase() === ".jsonl") {
    values = content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(
            `Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      });
  } else {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) values = parsed;
    else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as Record<string, unknown>)["cases"])
    ) {
      const record = parsed as { name?: unknown; cases: unknown[] };
      name = typeof record.name === "string" ? record.name : path;
      values = record.cases;
    } else {
      throw new Error("JSON dataset must be an array or an object with a cases array.");
    }
  }
  return createDataset(name, values.map(validateCase), path);
}
