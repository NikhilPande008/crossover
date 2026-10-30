// Shared data contracts. See the product plan, "Data contracts".

export type Format = "film" | "series" | "album" | "tour";
export type Budget = "S" | "M" | "L";

export type Brief = {
  title: string;
  format: Format;
  logline?: string;
  comps: string[];
  regions: string[];
  budget: Budget;
  exclusions: string[];
};

export type EntityType = "movie" | "tv_show" | "artist" | "book" | "podcast" | "brand";

export type Comp = {
  name: string;
  entityId: string;
  type: EntityType;
  year?: number;
  descriptor?: string;
};

export type Domain = "artist" | "podcast" | "tv_show" | "movie" | "book" | "brand";

export type FactKind = "affinity" | "tag" | "demographic" | "heatmap" | "compare";

export type Fact = {
  id: string;
  kind: FactKind;
  compIds: string[];
  subject?: { entityId?: string; name: string; type?: string };
  value: number | string;
  /** Extra numbers carried with the fact (e.g. rank, popularity), all validator-visible. */
  detail?: Record<string, number | string>;
  request: { path: string; params: Record<string, string> };
  retrievedAt: string;
  recorded: boolean;
  synthetic: boolean;
};

export type Lever = "market" | "partner" | "crossover";
export type Confidence = "high" | "medium" | "low";

export type Cited = { text: string; factIds: string[] };

export type Concept = {
  id: string;
  lever: Lever;
  name: string;
  leadComps: string[];
  markets: { name: string; factIds: string[] }[];
  partners: { name: string; domain: string; factIds: string[] }[];
  creativeAngle: Cited;
  confidence: Confidence;
  risks: string[];
  hypotheses: string[];
};

export type DecisionBrief = {
  recommendedId: string;
  rationale: Cited[];
  whyNotOthers: Cited[];
  tradeoffs: string[];
  testChecklist: string[];
  disclaimer: string;
  writtenBy: "llm" | "template";
  droppedSentences: number;
};

export type RankedPartner = {
  entityId?: string;
  name: string;
  domain: Domain;
  score: number;
  perComp: Record<string, number>;
  factIds: string[];
};

export type RankedMarket = {
  name: string;
  country: string;
  score: number;
  perComp: Record<string, number>;
  factIds: string[];
};

export type Overlap = {
  a: string;
  b: string;
  /** Jaccard overlap of the two comps' own audience affinities (or tags as a fallback), 0..1. */
  score: number;
  basis: "audience-affinities" | "taste-tags";
  /** How many distinct items the score was computed over. */
  compared: number;
  /** Partners both comps' audiences rank highly. */
  sharedAudience: string[];
  /** Shared and divergent themes (title characteristics). */
  shared: string[];
  onlyA: string[];
  onlyB: string[];
  /** Where the themes came from. */
  source: "compare-endpoint" | "estimated-from-tags";
  factIds: string[];
};

export type AudienceMap = {
  partners: Record<Domain, RankedPartner[]>;
  markets: RankedMarket[];
  tags: { name: string; score: number; perComp: Record<string, number>; factIds: string[] }[];
  demographics: { compId: string; summary: string; factIds: string[] }[];
  overlaps: Overlap[];
  gaps: string[];
};

export type TraceEntry = {
  at: string;
  kind: "plan" | "tool" | "qloo" | "decision" | "llm" | "validator" | "limit" | "error";
  message: string;
  data?: unknown;
};

export type RunMode = "live" | "fixture" | "recorded";

export type RunResult = {
  runId: string;
  mode: RunMode;
  brief: Brief;
  comps: Comp[];
  audience: AudienceMap;
  concepts: Concept[];
  decision: DecisionBrief;
  facts: Fact[];
  trace: TraceEntry[];
  qlooCalls: number;
  cachedCalls: number;
  llmUsed: boolean;
  ms: number;
  constraintRemovals: { constraint: string; kind: "exclusion" | "not-a-fit"; count: number }[];
  llmUsage: LLMUsage;
};

export type LLMUsage = {
  provider: string;
  models: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD; null when a model's price is unknown. */
  costUsd: number | null;
  byPhase: { phase: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number | null }[];
};

export type BaselineCheck = {
  name: string;
  domain: string;
  resolved: boolean;
  entityId?: string;
  inCrossoverEvidence: boolean;
  affinity?: number;
};

export type BaselineResult = {
  concepts: { name: string; markets: string[]; partners: { name: string; domain: string }[]; angle: string }[];
  checks: BaselineCheck[];
  verifiability: number;
  grounding: number;
  /** Set when the Qloo fact-check was limited (e.g. quota protection). */
  note?: string;
  llmUsage?: LLMUsage;
  error?: string;
};

export type ProgressEvent =
  | { type: "step"; message: string; calls: number }
  | { type: "trace"; entry: TraceEntry }
  | { type: "result"; result: RunResult }
  | { type: "error"; message: string };
