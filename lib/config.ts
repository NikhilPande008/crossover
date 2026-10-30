// Server-only configuration. Never import this from client components.

export type CrossoverMode = "live" | "fixture";

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" && v !== undefined ? n : d;
}

export const config = {
  get mode(): CrossoverMode {
    const explicit = process.env.CROSSOVER_MODE;
    if (explicit === "live" || explicit === "fixture") return explicit;
    return process.env.QLOO_API_KEY ? "live" : "fixture";
  },
  qlooKey: () => process.env.QLOO_API_KEY ?? "",
  qlooBaseUrl: () => (process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com").replace(/\/$/, ""),
  quotaFloor: () => num(process.env.QLOO_QUOTA_FLOOR, 1500),
  runsPerIpHour: () => num(process.env.LIVE_RUNS_PER_IP_HOUR, 6),
  maxCallsPerRun: () => num(process.env.QLOO_MAX_CALLS_PER_RUN, 36),
  trustedProxyHops: () => num(process.env.TRUSTED_PROXY_HOPS, 1),
  llmProvider: (): "anthropic" | "openai" | "ollama" | "none" => {
    const p = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
    return p === "openai" || p === "ollama" || p === "none" ? p : "anthropic";
  },
  llmKey: () => process.env.LLM_API_KEY || (config.llmProvider() === "anthropic" ? process.env.ANTHROPIC_API_KEY : "") || "",
  llmBaseUrl: () => process.env.LLM_BASE_URL || (config.llmProvider() === "ollama" ? "http://localhost:11434/v1" : ""),
  llmModel: () => process.env.LLM_MODEL || { anthropic: "claude-opus-5-5", ollama: "crossover-gpt-oss", openai: "", none: "" }[config.llmProvider()],
  /** reasoning_effort for open reasoning models (low|medium|high; "off" to omit). Ollama defaults to low for speed. */
  llmReasoningEffort: () => {
    const v = (process.env.LLM_REASONING_EFFORT ?? "").toLowerCase();
    if (v === "off" || v === "none") return undefined;
    return v || (config.llmProvider() === "ollama" ? "low" : undefined);
  },
  llmEnabled: () => {
    const p = config.llmProvider();
    if (p === "none") return false;
    if (p === "anthropic") return Boolean(config.llmKey());
    if (p === "ollama") return true;
    return Boolean(config.llmBaseUrl() && config.llmModel());
  },
  /** Wall-clock budget per run. Local models are slower, so Ollama gets longer by default. */
  runWallMs: () => num(process.env.RUN_WALL_SECONDS, config.llmProvider() === "ollama" ? 240 : 60) * 1000,
};
