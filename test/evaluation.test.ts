import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDataset, loadDataset } from "../src/evaluation/dataset.js";
import { scoreOutput } from "../src/evaluation/scoring.js";

void test("evaluation datasets load reproducibly from JSONL", () => {
  const directory = mkdtempSync(join(tmpdir(), "switch-eval-"));
  try {
    const path = join(directory, "cases.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          id: "one",
          input: "What is 2+2?",
          expected: { exact: "4" },
        }),
        JSON.stringify({
          id: "two",
          input: "Name primary colors.",
          expected: { containsAll: ["red", "blue"] },
        }),
      ].join("\n"),
    );
    const first = loadDataset(path);
    const second = loadDataset(path);
    assert.equal(first.cases.length, 2);
    assert.equal(first.hash, second.hash);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("deterministic reference scorers expose dimensions and pass state", () => {
  const dataset = createDataset("test", [
    {
      id: "case",
      input: "answer",
      expected: { containsAll: ["alpha", "beta"], containsAny: ["gamma", "delta"] },
    },
  ]);
  const item = dataset.cases[0];
  assert.ok(item);
  const score = scoreOutput(item, "Alpha, beta, and gamma.");
  assert.equal(score.passed, true);
  assert.equal(score.value, 1);
});
