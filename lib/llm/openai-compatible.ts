// Any OpenAI-compatible chat-completions API: Ollama (local), Groq, Together, Fireworks,
// OpenRouter, vLLM, LM Studio. Uses fetch; no vendor SDK. The agent loop speaks the
// Anthropic message shapes, so this file translates both ways.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { LLM, Metering, ToolTurn } from "./provider";

type OAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type OAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OAIResponse = {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: OAIToolCall[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

/** Rough token estimate (≈4 characters per token) for detecting silent truncation. */
export function estimateTokens(body: unknown): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}

export class LLMHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- translation (exported for tests) ----------

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === "object" && "text" in b && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

export function toOpenAIMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[]): OAIMessage[] {
  const out: OAIMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m.role === "assistant" ? { role: "assistant", content: m.content } : { role: "user", content: m.content });
      continue;
    }
    const blocks = m.content as unknown as Record<string, unknown>[];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      const toolCalls: OAIToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      // Thinking blocks are Claude-specific and dropped here.
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    // User turn: tool results first (they must follow the assistant's tool calls), then any text.
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const body = blockText(b.content);
        out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: b.is_error ? `ERROR: ${body}` : body });
      } else if (b.type === "text") texts.push(String(b.text ?? ""));
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n") });
  }
  return out;
}

export function toOpenAITools(tools: Anthropic.Beta.BetaTool[]) {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
}

const STOP: Record<string, string> = { tool_calls: "tool_use", stop: "end_turn", length: "max_tokens" };

export function fromOpenAIResponse(res: OAIResponse): ToolTurn {
  const choice = res.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Record<string, unknown>[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content, citations: null });
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown;
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      // Small models sometimes emit broken JSON; the tool runner reports it back as an error.
      input = { __invalid_arguments: tc.function.arguments };
    }
    content.push({ type: "tool_use", id: tc.id || `call_${content.length}`, name: tc.function.name, input });
  }
  const blocks = content as unknown as Anthropic.Beta.BetaContentBlock[];
  return {
    content: blocks,
    toolUses: blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use"),
    text: msg.content ?? "",
    stopReason: STOP[choice?.finish_reason ?? ""] ?? choice?.finish_reason ?? null,
  };
}

/** Pull a JSON object out of model text: strips code fences and leading prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

// ---------- provider ----------

export class OpenAICompatibleLLM implements LLM {
  provider: "openai" | "ollama";
  model: string;
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  /** Sent as `reasoning_effort` (gpt-oss and other reasoning models); dropped if the host rejects it. */
  private reasoningEffort: string | undefined;

  constructor(o: { provider: "openai" | "ollama"; baseUrl: string; apiKey?: string; model: string; timeoutMs?: number; reasoningEffort?: string }) {
    this.provider = o.provider;
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.apiKey = o.apiKey ?? "";
    this.model = o.model;
    this.reasoningEffort = o.reasoningEffort || undefined;
    // Local models on a laptop are slow; give each call room.
    this.timeoutMs = o.timeoutMs ?? (o.provider === "ollama" ? 240_000 : 90_000);
  }

  private async post(body: Record<string, unknown>) {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async chat(body: Record<string, unknown>, m: Metering): Promise<OAIResponse> {
    const started = Date.now();
    const full: Record<string, unknown> = { model: this.model, temperature: 0, ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}), ...body };
    let r = await this.post(full);
    if (r.status === 400 && this.reasoningEffort) {
      const text = await r.text().catch(() => "");
      if (/reasoning/i.test(text)) {
        this.reasoningEffort = undefined; // host does not support it; stop sending
        const { reasoning_effort: _drop, ...rest } = full;
        void _drop;
        r = await this.post(rest);
      } else throw new LLMHttpError(400, `${this.provider} 400: ${text.slice(0, 300)}`);
    }
    if (r.status === 404 && this.provider === "ollama")
      throw new LLMHttpError(404, `Ollama has no model "${this.model}". Run \`npm run ollama:setup\` (or \`ollama pull ${this.model}\`).`);
    if (!r.ok) throw new LLMHttpError(r.status, `${this.provider} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
    const json = (await r.json()) as OAIResponse;
    // Ollama silently truncates prompts longer than the model's context window, which
    // produces confident garbage. Fail loudly instead.
    const sent = estimateTokens({ messages: full.messages, tools: full.tools });
    const seen = json.usage?.prompt_tokens ?? 0;
    if (this.provider === "ollama" && sent > 1500 && seen > 0 && seen < sent * 0.5)
      throw new Error(`Ollama truncated the prompt (~${sent} tokens sent, ${seen} read): the model's context window is too small. Run \`npm run ollama:setup\` and use LLM_MODEL=crossover-gpt-oss.`);
    const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    m.meter?.record({
      phase: m.phase ?? "llm",
      provider: this.provider,
      model: json.model || this.model,
      inputTokens: (json.usage?.prompt_tokens ?? 0) - cached,
      outputTokens: json.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      ms: Date.now() - started,
    });
    return json;
  }

  async toolTurn({ system, messages, tools, requireTool, ...m }: Parameters<LLM["toolTurn"]>[0]): Promise<ToolTurn> {
    const res = await this.chat({ messages: toOpenAIMessages(system, messages), tools: toOpenAITools(tools), tool_choice: requireTool ? "required" : "auto" }, m);
    return fromOpenAIResponse(res);
  }

  async structured<T extends z.ZodType>({ system, user, schema, maxTokens = 8000, effort: _effort, ...m }: Parameters<LLM["structured"]>[0] & { schema: T }): Promise<z.infer<T>> {
    void _effort; // one reasoning level for open models, set by LLM_REASONING_EFFORT
    const { $schema, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
    void $schema;
    const sys = `${system}\n\nReply with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(jsonSchema)}`;
    const messages: OAIMessage[] = [
      { role: "system", content: sys },
      { role: "user", content: user },
    ];
    // Prefer schema-constrained output; hosts that reject it get plain JSON mode instead.
    let format: Record<string, unknown> = { type: "json_schema", json_schema: { name: "output", schema: jsonSchema, strict: true } };
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: OAIResponse;
      try {
        res = await this.chat({ messages, response_format: format, max_tokens: maxTokens }, m);
      } catch (e) {
        if (e instanceof LLMHttpError && e.status === 400 && format.type === "json_schema") {
          format = { type: "json_object" };
          continue;
        }
        throw e;
      }
      const text = res.choices?.[0]?.message?.content ?? "";
      let parsed: z.ZodSafeParseResult<z.infer<T>> | null = null;
      let problem = "";
      try {
        parsed = schema.safeParse(extractJson(text));
        if (!parsed.success) problem = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch (e) {
        problem = `not valid JSON (${e instanceof Error ? e.message : e})`;
      }
      if (parsed?.success) return parsed.data;
      // One repair round: show the model what was wrong.
      messages.push({ role: "assistant", content: text }, { role: "user", content: `That output was invalid: ${problem}. Reply again with only the corrected JSON object.` });
    }
    throw new Error(`${this.provider} model did not return valid JSON for the schema`);
  }
}
