// Claude via the Anthropic SDK. Server-side refusal fallbacks are on ("default" routing)
// so a safety decline is re-run on a fallback model inside the same call instead of
// failing the run; usage is priced by the model that actually served the request.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { LLM, Metering, ToolTurn } from "./provider";
import { callTimeout } from "./budget";

const BETAS = ["server-side-fallback-2026-07-01"];

export class AnthropicLLM implements LLM {
  provider = "anthropic" as const;
  private client: Anthropic;
  constructor(
    apiKey: string,
    public model: string,
  ) {
    // Hosted calls must fail well inside the plan route's 120 s limit so the run can fall back to templates.
    this.client = new Anthropic({ apiKey, timeout: 40_000, maxRetries: 1 });
  }

  private meter(m: Metering, res: Anthropic.Beta.BetaMessage, started: number) {
    m.meter?.record({
      phase: m.phase ?? "llm",
      provider: "anthropic",
      model: res.model || this.model,
      inputTokens: res.usage.input_tokens ?? 0,
      outputTokens: res.usage.output_tokens ?? 0,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      ms: Date.now() - started,
    });
  }

  async toolTurn({ system, messages, tools, effort = "low", requireTool: _require, ...m }: Parameters<LLM["toolTurn"]>[0]): Promise<ToolTurn> {
    void _require; // forced tool_choice returns 400 on current Claude models; the prompt asks instead
    const started = Date.now();
    const res = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: 4000,
        betas: BETAS,
        fallbacks: "default",
        system,
        messages,
        tools,
        output_config: { effort },
      },
      { timeout: callTimeout(m.maxMs ?? 40_000, m.deadline), signal: m.signal, ...(m.deadline ? { maxRetries: 0 } : {}) },
    );
    this.meter(m, res, started);
    if (res.stop_reason === "refusal") throw new Error("LLM declined the request");
    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { content: res.content, toolUses, text, stopReason: res.stop_reason };
  }

  async structured<T extends z.ZodType>({ system, user, schema, effort = "medium", maxTokens = 16000, ...m }: Parameters<LLM["structured"]>[0] & { schema: T }): Promise<z.infer<T>> {
    const started = Date.now();
    const fmt = zodOutputFormat(schema);
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: maxTokens,
        betas: BETAS,
        fallbacks: "default",
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort, format: { type: fmt.type, schema: fmt.schema } },
      },
      { timeout: callTimeout(m.maxMs ?? 40_000, m.deadline), signal: m.signal, ...(m.deadline ? { maxRetries: 0 } : {}) },
    );
    const res = await stream.finalMessage();
    this.meter(m, res, started);
    if (res.stop_reason === "refusal") throw new Error("LLM declined the request");
    if (res.stop_reason === "max_tokens") throw new Error("LLM output truncated");
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return fmt.parse(text) as z.infer<T>;
  }
}
