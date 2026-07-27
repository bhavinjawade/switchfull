import type { PlanStage } from "../schema/execution-plan.js";
import { stage } from "./stages.js";
import type { ProtocolCompileContext, ProtocolDefinition, ProtocolMetadata } from "./types.js";

function metadata(
  id: string,
  name: string,
  description: string,
  options: {
    readonly status?: ProtocolMetadata["status"];
    readonly citations?: readonly string[];
    readonly minimumParticipants?: number;
  } = {},
): ProtocolMetadata {
  return {
    id,
    name,
    version: "1.0.0",
    status: options.status ?? "beta",
    description,
    citations: options.citations ?? [],
    minimumParticipants: options.minimumParticipants ?? 2,
  };
}

function synthesis(
  context: ProtocolCompileContext,
  dependsOn: readonly string[],
  id = "synthesis",
): PlanStage {
  return stage({
    id,
    operator: "synthesize",
    participants: [context.synthesizer],
    dependsOn,
    inputStages: dependsOn,
    role: "synthesizer",
    visibility: "public-result",
    quorum: 1,
    timeoutMs: context.timeoutMs,
  });
}

function finalStage(_context: ProtocolCompileContext, stages: readonly PlanStage[]): string {
  const final = stages.at(-1);
  if (!final) throw new Error("Protocol generated no stages.");
  return final.id;
}

function independentRounds(
  context: ProtocolCompileContext,
  options: { readonly includeCritique: boolean; readonly includeRevision: boolean },
): PlanStage[] {
  const stages: PlanStage[] = [
    stage({
      id: "independent",
      operator: "generate",
      participants: context.participants,
      role: "independent respondent",
      timeoutMs: context.timeoutMs,
    }),
  ];
  let previous = "independent";
  for (let round = 1; round <= context.critiqueRounds; round += 1) {
    if (options.includeCritique) {
      const id = `critique-${round}`;
      stages.push(
        stage({
          id,
          operator: "critique",
          participants: context.participants,
          dependsOn: [previous],
          inputStages: [previous],
          role: "critic",
          timeoutMs: context.timeoutMs,
          maxIterations: context.critiqueRounds,
          config: { round },
        }),
      );
      previous = id;
    }
    if (options.includeRevision) {
      const id = `revision-${round}`;
      stages.push(
        stage({
          id,
          operator: "revise",
          participants: context.participants,
          dependsOn: [previous],
          inputStages: [previous],
          role: "reviser",
          timeoutMs: context.timeoutMs,
          maxIterations: context.critiqueRounds,
          config: { round },
        }),
      );
      previous = id;
    }
  }
  stages.push(synthesis(context, [previous]));
  return stages;
}

const direct: ProtocolDefinition = {
  metadata: metadata("direct", "Direct", "One participant answers directly.", {
    status: "stable",
    minimumParticipants: 1,
    // Baseline single-sample decoding (no multi-agent paper)
    citations: ["https://arxiv.org/abs/2005.14165"],
  }),
  compile(context) {
    return [
      stage({
        id: "answer",
        operator: "generate",
        participants: [context.participants[0] ?? context.synthesizer],
        role: "primary",
        visibility: "public-result",
        quorum: 1,
        timeoutMs: context.timeoutMs,
      }),
    ];
  },
  finalStage,
};

const humanGatedDirect: ProtocolDefinition = {
  metadata: metadata(
    "human-gated-direct",
    "Human-gated Direct",
    "Pause for explicit human input before one participant answers.",
    {
      status: "stable",
      minimumParticipants: 1,
      // Human-in-the-loop / RLHF pipeline framing
      citations: ["https://arxiv.org/abs/2203.02155"],
    },
  ),
  compile(context) {
    return [
      stage({
        id: "human-approval",
        operator: "human_gate",
        participants: [],
        role: "human approver",
        visibility: "council",
        quorum: 0,
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "answer",
        operator: "generate",
        participants: [context.participants[0] ?? context.synthesizer],
        dependsOn: ["human-approval"],
        inputStages: ["human-approval"],
        role: "primary",
        visibility: "public-result",
        quorum: 1,
        timeoutMs: context.timeoutMs,
      }),
    ];
  },
  finalStage,
};

const independentCouncil: ProtocolDefinition = {
  metadata: metadata(
    "independent-critique-synthesis",
    "Independent Council",
    "Independent candidates, identity-stripped critiques, revisions, and synthesis.",
    {
      status: "stable",
      // ChatEval: multi-agent debate / referee-style evaluation
      citations: ["https://arxiv.org/abs/2308.07201"],
    },
  ),
  compile(context) {
    return independentRounds(context, { includeCritique: true, includeRevision: false });
  },
  finalStage,
};

const selfConsistency: ProtocolDefinition = {
  metadata: metadata(
    "self-consistency",
    "Self-consistency",
    "Generate independent samples and aggregate the strongest common answer.",
    {
      citations: ["https://arxiv.org/abs/2203.11171"],
      minimumParticipants: 1,
    },
  ),
  compile(context) {
    const sampleCount = Number(context.parameters["sampleCount"] ?? 5);
    return [
      stage({
        id: "samples",
        operator: "sample",
        participants: [context.participants[0] ?? context.synthesizer],
        role: "sampler",
        timeoutMs: context.timeoutMs,
        config: { sampleCount: Math.max(2, Math.min(sampleCount, 16)) },
      }),
      synthesis(context, ["samples"]),
    ];
  },
  finalStage,
};

const generatorCriticVerifier: ProtocolDefinition = {
  metadata: metadata(
    "generator-critic-verifier",
    "Generator-Critic-Verifier",
    "A generator proposes, critics inspect, a verifier checks, and the generator revises.",
    {
      minimumParticipants: 3,
      // Self-Refine: iterative feedback and refinement
      citations: ["https://arxiv.org/abs/2303.17651"],
    },
  ),
  compile(context) {
    const [generator = context.synthesizer, ...reviewers] = context.participants;
    const critics = reviewers.length ? reviewers : [context.synthesizer];
    const verifier = critics.at(-1) ?? context.synthesizer;
    return [
      stage({
        id: "draft",
        operator: "generate",
        participants: [generator],
        role: "generator",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "critique",
        operator: "critique",
        participants: critics,
        dependsOn: ["draft"],
        inputStages: ["draft"],
        role: "critic",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "verification",
        operator: "verify",
        participants: [verifier],
        dependsOn: ["draft", "critique"],
        inputStages: ["draft", "critique"],
        role: "verifier",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "revision",
        operator: "revise",
        participants: [generator],
        dependsOn: ["critique", "verification"],
        inputStages: ["draft", "critique", "verification"],
        role: "reviser",
        timeoutMs: context.timeoutMs,
      }),
      synthesis(context, ["revision", "verification"]),
    ];
  },
  finalStage,
};

const jury: ProtocolDefinition = {
  metadata: metadata(
    "jury",
    "LLM Jury",
    "Candidates are judged by a randomized multi-model jury.",
    {
      status: "experimental",
      minimumParticipants: 3,
      // Judging LLM-as-a-Judge
      citations: ["https://arxiv.org/abs/2306.05685"],
    },
  ),
  compile(context) {
    return [
      stage({
        id: "candidates",
        operator: "generate",
        participants: context.participants,
        role: "candidate",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "jury-vote",
        operator: "vote",
        participants: context.participants,
        dependsOn: ["candidates"],
        inputStages: ["candidates"],
        role: "juror",
        timeoutMs: context.timeoutMs,
        config: { randomizePositions: true, allowAbstain: true },
      }),
      synthesis(context, ["candidates", "jury-vote"]),
    ];
  },
  finalStage,
};

const reconcile: ProtocolDefinition = {
  metadata: metadata(
    "reconcile",
    "ReConcile-style Council",
    "Independent answers enter bounded, confidence-aware reconciliation rounds.",
    {
      status: "experimental",
      citations: ["https://arxiv.org/abs/2309.13007"],
    },
  ),
  compile(context) {
    return independentRounds(
      { ...context, critiqueRounds: Math.max(1, context.critiqueRounds) },
      { includeCritique: false, includeRevision: true },
    );
  },
  finalStage,
};

const debate: ProtocolDefinition = {
  metadata: metadata(
    "multi-agent-debate",
    "Multi-agent Debate",
    "Independent claims, bounded rebuttal and revision rounds, then judgment.",
    {
      status: "experimental",
      citations: ["https://arxiv.org/abs/2305.14325"],
    },
  ),
  compile(context) {
    const stages = independentRounds(
      { ...context, critiqueRounds: Math.max(1, context.critiqueRounds) },
      { includeCritique: true, includeRevision: true },
    );
    stages.pop();
    const previous = stages.at(-1)?.id ?? "independent";
    stages.push(
      stage({
        id: "debate-judgment",
        operator: "vote",
        participants: [context.synthesizer],
        dependsOn: [previous],
        inputStages: [previous],
        role: "debate judge",
        timeoutMs: context.timeoutMs,
        config: { randomizePositions: true },
      }),
    );
    stages.push(synthesis(context, [previous, "debate-judgment"]));
    return stages;
  },
  finalStage,
};

const tournament: ProtocolDefinition = {
  metadata: metadata(
    "tournament",
    "Tournament",
    "Candidates are compared pairwise with randomized positions before final fusion.",
    {
      status: "experimental",
      minimumParticipants: 3,
      // LLM-Blender pairwise ranking / tournament-style fusion lineage
      citations: ["https://arxiv.org/abs/2306.02561"],
    },
  ),
  compile(context) {
    return [
      stage({
        id: "entrants",
        operator: "generate",
        participants: context.participants,
        role: "entrant",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "matches",
        operator: "vote",
        participants: context.participants,
        dependsOn: ["entrants"],
        inputStages: ["entrants"],
        role: "pairwise judge",
        timeoutMs: context.timeoutMs,
        config: { pairing: "round-robin", randomizePositions: true },
      }),
      synthesis(context, ["entrants", "matches"]),
    ];
  },
  finalStage,
};

const mixtureOfAgents: ProtocolDefinition = {
  metadata: metadata(
    "mixture-of-agents",
    "Mixture of Agents",
    "Diverse proposers feed one or more aggregation layers.",
    {
      status: "experimental",
      citations: ["https://arxiv.org/abs/2406.04692"],
    },
  ),
  compile(context) {
    return [
      stage({
        id: "proposers",
        operator: "generate",
        participants: context.participants,
        role: "proposer",
        timeoutMs: context.timeoutMs,
      }),
      synthesis(context, ["proposers"], "aggregation-1"),
      synthesis(context, ["proposers", "aggregation-1"], "aggregation-2"),
    ];
  },
  finalStage,
};

const pairRank: ProtocolDefinition = {
  metadata: metadata(
    "pair-rank-fusion",
    "Pair-rank and Fusion",
    "Pairwise judges rank candidates and a synthesizer fuses their strongest components.",
    {
      status: "experimental",
      citations: ["https://arxiv.org/abs/2306.02561"],
    },
  ),
  compile(context) {
    return [
      stage({
        id: "candidates",
        operator: "generate",
        participants: context.participants,
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "pair-rank",
        operator: "vote",
        participants: context.participants,
        dependsOn: ["candidates"],
        inputStages: ["candidates"],
        role: "ranker",
        timeoutMs: context.timeoutMs,
        config: { randomizePositions: true, scoring: "pairwise" },
      }),
      synthesis(context, ["candidates", "pair-rank"]),
    ];
  },
  finalStage,
};

const cascade: ProtocolDefinition = {
  metadata: metadata(
    "cascade",
    "Adaptive Cascade",
    "Start with one participant, verify independently, and synthesize only after escalation.",
    {
      status: "experimental",
      minimumParticipants: 2,
      // FrugalGPT-style cascading / escalation
      citations: ["https://arxiv.org/abs/2305.05176"],
    },
  ),
  compile(context) {
    const primary = context.participants[0] ?? context.synthesizer;
    const verifier = context.participants[1] ?? context.synthesizer;
    return [
      stage({
        id: "primary",
        operator: "generate",
        participants: [primary],
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "verify",
        operator: "verify",
        participants: [verifier],
        dependsOn: ["primary"],
        inputStages: ["primary"],
        timeoutMs: context.timeoutMs,
      }),
      synthesis(context, ["primary", "verify"]),
    ];
  },
  finalStage,
};

const courtroom: ProtocolDefinition = {
  metadata: metadata(
    "courtroom",
    "Courtroom",
    "Advocates present competing cases, cross-examine, and an independent judge rules.",
    {
      status: "experimental",
      minimumParticipants: 3,
      // Multi-agent debate with adversarial roles / judgment
      citations: ["https://arxiv.org/abs/2305.14325"],
    },
  ),
  compile(context) {
    const judge = context.synthesizer;
    const advocates = context.participants.filter((id) => id !== judge);
    return [
      stage({
        id: "opening-cases",
        operator: "generate",
        participants: advocates.length ? advocates : context.participants,
        role: "advocate",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "cross-examination",
        operator: "critique",
        participants: advocates.length ? advocates : context.participants,
        dependsOn: ["opening-cases"],
        inputStages: ["opening-cases"],
        role: "cross-examiner",
        timeoutMs: context.timeoutMs,
      }),
      stage({
        id: "ruling",
        operator: "vote",
        participants: [judge],
        dependsOn: ["opening-cases", "cross-examination"],
        inputStages: ["opening-cases", "cross-examination"],
        role: "judge",
        visibility: "public-result",
        quorum: 1,
        timeoutMs: context.timeoutMs,
        config: { requireDissent: true },
      }),
    ];
  },
  finalStage,
};

export const builtInProtocols: readonly ProtocolDefinition[] = [
  direct,
  humanGatedDirect,
  independentCouncil,
  selfConsistency,
  generatorCriticVerifier,
  jury,
  reconcile,
  debate,
  tournament,
  mixtureOfAgents,
  pairRank,
  cascade,
  courtroom,
];
