// Shared data contracts. See the product plan, "Data contracts".

export type Format = "film" | "series" | "album" | "tour" | "special";
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

export type EntityType = "movie" | "tv_show" | "artist" | "book" | "podcast" | "brand" | "person";

export type Comp = {
  name: string;
  entityId: string;
  type: EntityType;
  year?: number;
  descriptor?: string;
  /** The title's own Qloo media-genre tag IDs (from search), used to build a genre-signal partner pool. */
  genres?: string[];
};

export type Domain = "artist" | "podcast" | "tv_show" | "movie" | "book" | "brand";

/**
 * baseline: an entity's affinity for a broad reference audience (lift = comps − baseline).
 * cross: one comp (or a control title) scored inside another comp's audience, or inside the baseline audience.
 * similar: titles a comp's audience (or a logline's genre tags) ranks highly; feeds comp discovery.
 */
export type FactKind = "affinity" | "tag" | "demographic" | "heatmap" | "compare" | "baseline" | "cross" | "similar";

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

export type TestType = "geo_ab" | "podcast_host_read" | "artist_social_collab" | "screen_cross_promo" | "brand_copromo" | "creative_ab";

/** A pre-spend test, rendered by code from a type and plan items so it can only name what the plan contains. */
export type TestItem = { type: TestType; text: string; why?: string; subjects: string[] };

export type DecisionBrief = {
  recommendedId: string;
  rationale: Cited[];
  whyNotOthers: Cited[];
  tradeoffs: string[];
  testChecklist: string[];
  /** Typed tests behind testChecklist (same order). */
  tests?: TestItem[];
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
  /** Affinity for all comps' audience combined (pool scoring), when measured. */
  combined?: number;
  /** Affinity for the broad reference audience, when measured. */
  baseline?: number;
  /** combined − baseline: how much more these comps' fans like it than a typical audience does. */
  lift?: number;
  /** Where the candidate came from: the comps' own top results, a genre-tag signal, or the model's suggestion. */
  source?: "comp" | "genre" | "model";
};

export type RankedMarket = {
  name: string;
  country: string;
  score: number;
  perComp: Record<string, number>;
  factIds: string[];
  /** Mean percentile of the comps' fan concentration within the country, 0..1. */
  concentration?: number;
  /** concentration − the reference audience's percentile: positive = over-indexes for these comps. */
  overIndex?: number;
  /** Over-indexes strongly for every comp: possibly a sampling artefact, check before spending. */
  broad?: boolean;
  /** Approximate metro population, millions (static reference table). */
  population?: number;
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
  /** Share of the pair's distinct themes that both titles have, 0..1. Decides "one audience or two". */
  themeShare: number;
  /** How many distinct themes themeShare was computed over. */
  themesCompared: number;
  /** True when the verdict is "one audience": bridge rather than choose between. */
  similar: boolean;
  factIds: string[];
  /** Cross-affinity verdict (Qloo filter.results.entities): how much each comp's fans like the other, above a typical audience. */
  verdict?: "one" | "adjacent" | "different";
  /** b's affinity inside a's audience minus b's affinity inside the reference audience. */
  liftBinA?: number;
  liftAinB?: number;
  /** min(liftBinA, liftAinB). */
  mutualLift?: number;
  /** b's rank among the titles a's fans love most (1-based), if in the top list. */
  rankBinA?: number;
  rankAinB?: number;
  /** Lifts of the control titles inside each comp's audience, for calibration (should be near zero). */
  controls?: { name: string; liftInA?: number; liftInB?: number }[];
};

export type CompAdvice = {
  /** The comp to lead with. */
  lead: string;
  leadReason: string;
  /** A title the comps' fans love that is not yet a comp, with the facts behind it. */
  add?: { name: string; entityId: string; type: EntityType; factIds: string[]; reason: string };
  /** A comp that anchors weakly to the others. */
  drop?: { compId: string; reason: string; factIds: string[] };
  by: "agent" | "code";
};

export type AudienceMap = {
  partners: Record<Domain, RankedPartner[]>;
  markets: RankedMarket[];
  tags: { name: string; score: number; perComp: Record<string, number>; factIds: string[] }[];
  demographics: { compId: string; summary: string; factIds: string[] }[];
  overlaps: Overlap[];
  gaps: string[];
  /** Popular with these fans and with everyone else (lift ≤ 0): left out of the plan. */
  generic?: RankedPartner[];
  /** Comp weights the agent set (entityId → weight), when not all 1. */
  weights?: Record<string, number>;
  /** Comp audit: which comp to lead with, and any comp to add or drop. */
  advice?: CompAdvice;
};

export type TraceEntry = {
  at: string;
  kind: "plan" | "tool" | "qloo" | "decision" | "llm" | "validator" | "critic" | "limit" | "error";
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
  /** Run that this one re-planned (comp swap or refinement). */
  priorRunId?: string;
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
  /** In this run's own top results for the comps. */
  inCrossoverEvidence: boolean;
  /** Affinity for the comps' audience, measured for this partner by Qloo (filter.results.entities). */
  affinity?: number;
  /** Affinity for the reference audience. */
  baseline?: number;
  /** affinity − baseline. */
  lift?: number;
};

/** Both arms scored the same way: Qloo lift for every named partner. */
export type ArmScore = { scored: number; positive: number; medianLift: number | null };

export type BaselineResult = {
  concepts: { name: string; markets: string[]; partners: { name: string; domain: string }[]; angle: string }[];
  checks: BaselineCheck[];
  verifiability: number;
  grounding: number;
  /** Lift scoring of the model's partners and of Crossover's recommended partners, by the same code. */
  modelArm?: ArmScore;
  crossoverArm?: ArmScore;
  /** Model-named cities and their fan-concentration percentile in this run, when the city is mapped. */
  markets?: { name: string; percentile?: number }[];
  /** Set when the Qloo fact-check was limited (e.g. quota protection). */
  note?: string;
  llmUsage?: LLMUsage;
  error?: string;
};

export type ProgressEvent =
  | { type: "run"; runId: string }
  | { type: "step"; message: string; calls: number }
  /** Early result: the audience map is ready before the concepts are written. */
  | { type: "audience"; audience: AudienceMap; comps: Comp[] }
  | { type: "trace"; entry: TraceEntry }
  | { type: "result"; result: RunResult }
  | { type: "error"; message: string };
