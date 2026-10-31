// Token and cost metering for every LLM call. Prices are USD per million tokens.
// Claude prices: Anthropic list prices as of 2026-10-06 (first-party API). Open models
// run locally on Ollama cost $0; hosted open models need LLM_PRICE_*_PER_MTOK set,
// otherwise cost is reported as unknown (tokens are always logged).

export type Price = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

const CLAUDE_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10 },
  // Up to 100K-token prompts; Crossover prompts stay well under that.
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export type ProviderName = "anthropic" | "openai" | "ollama";

function envPrice(): Price | undefined {
  const i = Number(process.env.LLM_PRICE_INPUT_PER_MTOK);
  const o = Number(process.env.LLM_PRICE_OUTPUT_PER_MTOK);
  return process.env.LLM_PRICE_INPUT_PER_MTOK && process.env.LLM_PRICE_OUTPUT_PER_MTOK && Number.isFinite(i) && Number.isFinite(o) ? { input: i, output: o } : undefined;
}

/** Price for a model, or undefined when unknown. An explicit env price always wins. */
export function priceFor(provider: ProviderName, model: string): Price | undefined {
  const fromEnv = envPrice();
  if (fromEnv) return fromEnv;
  if (provider === "ollama") return { input: 0, output: 0 };
  if (provider === "anthropic") return CLAUDE_PRICES[model] ?? CLAUDE_PRICES[Object.keys(CLAUDE_PRICES).find((k) => model.startsWith(k)) ?? ""];
  return undefined;
}

export type UsageRecord = {
  phase: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when the model's price is unknown. */
  costUsd: number | null;
  ms: number;
};

export function costOf(p: Price | undefined, u: Pick<UsageRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number | null {
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cacheWrite = p.cacheWrite ?? p.input * 1.25;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * cacheRead + u.cacheWriteTokens * cacheWrite) / 1_000_000;
}

export type UsageSummary = {
  provider: string;
  models: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null when any call's price was unknown. */
  costUsd: number | null;
  byPhase: { phase: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number | null }[];
};

// Process-wide totals since boot, for /api/health.
const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unknownCostCalls: 0 };
export function usageTotals() {
  return { ...totals, costUsd: Math.round(totals.costUsd * 10000) / 10000 };
}

export class UsageMeter {
  records: UsageRecord[] = [];
  constructor(
    private onRecord?: (r: UsageRecord) => void,
    /** Provider notes worth showing in the run trace (e.g. a timed-out attempt that was retried). */
    private onNote?: (message: string) => void,
  ) {}

  note(message: string) {
    this.onNote?.(message);
  }

  record(r: Omit<UsageRecord, "costUsd">) {
    const full: UsageRecord = { ...r, costUsd: costOf(priceFor(r.provider, r.model), r) };
    this.records.push(full);
    totals.calls++;
    totals.inputTokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    totals.outputTokens += r.outputTokens;
    if (full.costUsd === null) totals.unknownCostCalls++;
    else totals.costUsd += full.costUsd;
    this.onRecord?.(full);
  }

  summary(): UsageSummary {
    const sum = (rs: UsageRecord[]) => ({
      calls: rs.length,
      inputTokens: rs.reduce((s, r) => s + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0),
      outputTokens: rs.reduce((s, r) => s + r.outputTokens, 0),
      costUsd: rs.some((r) => r.costUsd === null) ? null : round6(rs.reduce((s, r) => s + (r.costUsd ?? 0), 0)),
    });
    const phases = [...new Set(this.records.map((r) => r.phase))];
    return {
      provider: [...new Set(this.records.map((r) => r.provider))].join("+") || "none",
      models: [...new Set(this.records.map((r) => r.model))],
      ...sum(this.records),
      byPhase: phases.map((phase) => ({ phase, ...sum(this.records.filter((r) => r.phase === phase)) })),
    };
  }
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

export function formatUsage(u: Pick<UsageSummary, "inputTokens" | "outputTokens" | "costUsd" | "provider">): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const cost = u.costUsd === null ? "cost not tracked" : u.provider === "ollama" && u.costUsd === 0 ? "$0 (local)" : `$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(3)}`;
  return `${k(u.inputTokens)} in / ${k(u.outputTokens)} out · ${cost}`;
}
