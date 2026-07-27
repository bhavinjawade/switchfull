import { ProtocolRegistry } from "./registry.js";

/** Human-readable paper titles for built-in approach citations (arxiv abs URLs). */
const PAPER_TITLES: Readonly<Record<string, string>> = {
  "https://arxiv.org/abs/2005.14165": "Language Models are Few-Shot Learners (GPT-3)",
  "https://arxiv.org/abs/2203.02155":
    "Training language models to follow instructions with human feedback",
  "https://arxiv.org/abs/2203.11171": "Self-Consistency Improves Chain of Thought Reasoning",
  "https://arxiv.org/abs/2303.17651": "Self-Refine: Iterative Refinement with Self-Feedback",
  "https://arxiv.org/abs/2305.05176":
    "FrugalGPT: How to Use Large Language Models While Reducing Cost and Improving Performance",
  "https://arxiv.org/abs/2305.14325": "Improving Factuality and Reasoning via Multiagent Debate",
  "https://arxiv.org/abs/2306.02561": "LLM-Blender: Ensembling Large Language Models",
  "https://arxiv.org/abs/2306.05685": "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena",
  "https://arxiv.org/abs/2308.07201":
    "ChatEval: Towards Better LLM-based Evaluators through Multi-Agent Debate",
  "https://arxiv.org/abs/2309.13007":
    "ReConcile: Round-Table Conference Improves Reasoning via Consensus",
  "https://arxiv.org/abs/2406.04692":
    "Mixture-of-Agents Enhances Large Language Model Capabilities",
};

export interface ApproachPaper {
  readonly protocolId: string;
  readonly protocolName: string;
  readonly url: string;
  readonly title: string;
  readonly allUrls: readonly string[];
}

const registry = new ProtocolRegistry();

export function paperTitleForUrl(url: string): string {
  return PAPER_TITLES[url] ?? url;
}

export function approachPaper(protocolId: string): ApproachPaper | undefined {
  let meta;
  try {
    meta = registry.get(protocolId).metadata;
  } catch {
    return undefined;
  }
  const url = meta.citations[0];
  if (!url) return undefined;
  return {
    protocolId: meta.id,
    protocolName: meta.name,
    url,
    title: paperTitleForUrl(url),
    allUrls: meta.citations,
  };
}

export function listApproachPapers(): readonly ApproachPaper[] {
  return registry
    .list()
    .map((meta) => approachPaper(meta.id))
    .filter((paper): paper is ApproachPaper => paper !== undefined);
}
