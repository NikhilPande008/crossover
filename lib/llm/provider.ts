// LLM provider interface. Implementations:
//   anthropic  Claude via the Anthropic SDK (lib/llm/anthropic.ts)
//   openai     any OpenAI-compatible chat API: Groq, Together, Fireworks, OpenRouter, vLLM, LM Studio
//   ollama     a local Ollama server through its OpenAI-compatible endpoint
// getLLM() returns null when none is configured, so callers fall back to templates.
//
// Messages and tools use the Anthropic shapes internally; other providers translate.

import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { config } from "@/lib/config";
import type { ProviderName, UsageMeter } from "./usage";
import { AnthropicLLM } from "./anthropic";
import { OpenAICompatibleLLM } from "./openai-compatible";
import { describeLLMError } from "./budget";

export type Effort = "low" | "medium" | "high";

export type ToolTurn = {
  content: Anthropic.Beta.BetaContentBlock[];
  toolUses: Anthropic.Beta.BetaToolUseBlock[];
  text: string;
  stopReason: string | null;
};

/**
 * Per-call options. Every call can be metered; `phase` labels it in the cost breakdown (research,
 * conceive, brief, baseline). `deadline` (epoch ms) caps the call and any retries inside it;
 * `signal` cancels it when the requester goes away.
 */
export type Metering = {
  meter?: UsageMeter;
  phase?: string;
  deadline?: number;
  signal?: AbortSignal;
  /** Per-attempt cap, below the provider default: a stalled call is retried once instead of waiting out the run. */
  maxMs?: number;
};

export interface LLM {
  provider: ProviderName;
  model: string;
  toolTurn(
    args: {
      system: string;
      messages: Anthropic.Beta.BetaMessageParam[];
      tools: Anthropic.Beta.BetaTool[];
      effort?: Effort;
      /** Ask the model to call a tool this turn. Honoured where the API allows it (not on Claude Opus 5.5, which rejects forced tool use). */
      requireTool?: boolean;
    } & Metering,
  ): Promise<ToolTurn>;
  structured<T extends z.ZodType>(args: { system: string; user: string; schema: T; effort?: Effort; maxTokens?: number } & Metering): Promise<z.infer<T>>;
}

let cached: LLM | null | undefined;

export function getLLM(): LLM | null {
  if (cached !== undefined) return cached;
  const p = config.llmProvider();
  if (!config.llmEnabled()) cached = null;
  else if (p === "anthropic") cached = new AnthropicLLM(config.llmKey(), config.llmModel());
  else if (p === "openai" || p === "ollama")
    cached = new OpenAICompatibleLLM({ provider: p, baseUrl: config.llmBaseUrl(), apiKey: config.llmKey(), model: config.llmModel(), reasoningEffort: config.llmReasoningEffort() });
  else cached = null;
  return cached;
}

/** Test hook: forget the cached provider after changing env vars. */
export function resetLLM() {
  cached = undefined;
}

const status = { lastError: undefined as string | undefined, lastOkAt: undefined as string | undefined };
export function llmStatus() {
  return { enabled: config.llmEnabled(), provider: config.llmProvider(), model: config.llmModel(), baseUrl: config.llmProvider() === "anthropic" ? undefined : config.llmBaseUrl(), ...status };
}
/** Records the outcome for /api/health. The full error goes to the server log; health gets the short form. */
export function noteLLM(ok: boolean, err?: unknown) {
  if (ok) status.lastOkAt = new Date().toISOString();
  else {
    console.warn("[llm-error]", err instanceof Error ? err.message : err);
    status.lastError = describeLLMError(err);
  }
}
