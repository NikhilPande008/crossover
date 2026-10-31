// Per-call time budget and client-safe error text, shared by the LLM providers.

/** Thrown before a model call when the run has no time left for it. */
export class LLMBudgetError extends Error {
  constructor() {
    super("No time left in the run for another model call");
  }
}

/** Timeout for the next call: the provider's own limit, cut to what is left before `deadline`. */
export function callTimeout(maxMs: number, deadline?: number): number {
  const left = deadline ? deadline - Date.now() : Infinity;
  if (left < 1000) throw new LLMBudgetError();
  return Math.min(maxMs, left);
}

/** Timeout plus the run's abort signal, so a closed browser tab stops the call too. */
export function callSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
}

/**
 * Short description of a model failure for the browser and /api/health. Provider response
 * bodies stay in the server log: they can echo request details and are no use to a viewer.
 */
export function describeLLMError(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === "number") return `model API returned HTTP ${status}`;
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(e instanceof Error ? e.message : "")) return "model call timed out";
  return (e instanceof Error ? e.message : String(e)).slice(0, 160);
}
