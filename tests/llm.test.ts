import { afterEach, describe, expect, it, vi } from "vitest";
import { costOf, formatUsage, priceFor, UsageMeter } from "@/lib/llm/usage";
import { extractJson, fromOpenAIResponse, OpenAICompatibleLLM, toOpenAIMessages, toOpenAITools } from "@/lib/llm/openai-compatible";
import { resetLLM } from "@/lib/llm/provider";
import { runPlan } from "@/lib/agent/loop";
import { PRESETS } from "@/lib/presets";
import { QlooClient } from "@/lib/qloo/client";
import { bestCandidate, resolveComps } from "@/lib/agent/resolve";
import { z } from "zod";
import type { Comp } from "@/lib/types";

const ENV_KEYS = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "LLM_PRICE_INPUT_PER_MTOK", "LLM_PRICE_OUTPUT_PER_MTOK", "CROSSOVER_MODE"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
  vi.unstubAllGlobals();
  resetLLM();
});

describe("pricing", () => {
  it("prices Claude models from the built-in table", () => {
    // 25k in / 12k out on Opus 5.5 at $4 / $20 per MTok = $0.10 + $0.24
    expect(costOf(priceFor("anthropic", "claude-opus-5-5"), { inputTokens: 25_000, outputTokens: 12_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.34, 6);
    expect(priceFor("anthropic", "claude-haiku-5-5")).toEqual({ input: 0.1, output: 0.5 });
  });
  it("treats local Ollama as free and unknown hosted models as unknown", () => {
    expect(priceFor("ollama", "gpt-oss:20b")).toEqual({ input: 0, output: 0 });
    expect(priceFor("openai", "some-open-model")).toBeUndefined();
  });
  it("lets env prices override", () => {
    process.env.LLM_PRICE_INPUT_PER_MTOK = "0.5";
    process.env.LLM_PRICE_OUTPUT_PER_MTOK = "1.5";
    expect(priceFor("openai", "x")).toEqual({ input: 0.5, output: 1.5 });
  });
  it("summarises per phase and propagates unknown cost", () => {
    const m = new UsageMeter();
    m.record({ phase: "research", provider: "anthropic", model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, ms: 1 });
    m.record({ phase: "brief", provider: "anthropic", model: "claude-opus-5-5", inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, ms: 1 });
    const s = m.summary();
    expect(s).toMatchObject({ calls: 2, inputTokens: 3000, outputTokens: 600 });
    expect(s.costUsd).toBeCloseTo((3000 * 4 + 600 * 20) / 1e6, 9);
    expect(s.byPhase.map((p) => p.phase)).toEqual(["research", "brief"]);
    m.record({ phase: "brief", provider: "openai", model: "unknown", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, ms: 1 });
    expect(m.summary().costUsd).toBeNull();
    expect(formatUsage(m.summary())).toMatch(/cost unknown/);
  });
});

describe("OpenAI-compatible translation", () => {
  it("maps Anthropic-shaped history to chat messages with tool calls and results in order", () => {
    const msgs = toOpenAIMessages("SYS", [
      { role: "user", content: "brief" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "x" },
          { type: "text", text: "Researching." },
          { type: "tool_use", id: "t1", name: "audience_tags", input: { comp_ids: ["a"], reason: "r" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "F1 dread 0.9" },
          { type: "text", text: "Evidence check: ok" },
        ],
      },
    ] as never);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
    expect(msgs[2]).toMatchObject({ content: "Researching.", tool_calls: [{ id: "t1", function: { name: "audience_tags", arguments: '{"comp_ids":["a"],"reason":"r"}' } }] });
    expect(msgs[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "F1 dread 0.9" });
  });
  it("maps tools and responses, tolerating broken argument JSON", () => {
    expect(toOpenAITools([{ name: "x", description: "d", input_schema: { type: "object", properties: {} } }])[0]).toMatchObject({ type: "function", function: { name: "x" } });
    const turn = fromOpenAIResponse({
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{bad" } }] } }],
    });
    expect(turn.stopReason).toBe("tool_use");
    expect(turn.toolUses[0].input).toEqual({ __invalid_arguments: "{bad" });
  });
  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a":2} hope that helps')).toEqual({ a: 2 });
  });
});

function fakeServer(handler: (body: Record<string, unknown>) => { status?: number; json?: unknown }) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    const r = handler(body);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const reply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }) => ({ json: { model: "m", choices: [{ finish_reason: "stop", message: { content } }], usage } });

describe("OpenAICompatibleLLM", () => {
  const Schema = z.object({ answer: z.string() });

  it("calls /chat/completions without auth for Ollama and meters usage at $0", async () => {
    const calls = fakeServer(() => reply('{"answer":"ok"}'));
    const llm = new OpenAICompatibleLLM({ provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "gpt-oss:20b" });
    const meter = new UsageMeter();
    expect(await llm.structured({ system: "s", user: "u", schema: Schema, meter, phase: "brief" })).toEqual({ answer: "ok" });
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.response_format).toMatchObject({ type: "json_schema" });
    expect(meter.summary()).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 20, costUsd: 0 });
  });

  it("falls back to JSON mode when the host rejects json_schema, and repairs invalid output once", async () => {
    let n = 0;
    const calls = fakeServer((body) => {
      n++;
      if ((body.response_format as { type: string }).type === "json_schema") return { status: 400, json: { error: "unsupported" } };
      return n === 2 ? reply("not json at all") : reply('{"answer":"fixed"}');
    });
    const llm = new OpenAICompatibleLLM({ provider: "openai", baseUrl: "https://host/v1", apiKey: "k", model: "m" });
    expect(await llm.structured({ system: "s", user: "u", schema: Schema })).toEqual({ answer: "fixed" });
    expect(calls.map((c) => (c.body.response_format as { type: string }).type)).toEqual(["json_schema", "json_object", "json_object"]);
    expect(calls[1].headers.authorization).toBe("Bearer k");
    expect((calls[2].body.messages as { content: string }[]).at(-1)!.content).toMatch(/invalid/);
  });
});

describe("full agent run through an OpenAI-compatible model", () => {
  it("researches with tool calls, writes concepts and brief, and logs cost", async () => {
    process.env.CROSSOVER_MODE = "fixture";
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_BASE_URL = "http://fake/v1";
    process.env.LLM_MODEL = "open-model";
    process.env.LLM_PRICE_INPUT_PER_MTOK = "0.2";
    process.env.LLM_PRICE_OUTPUT_PER_MTOK = "0.6";
    resetLLM();
    const preset = PRESETS[0];
    const res = await resolveComps(new QlooClient({ maxCalls: 10, mode: "fixture" }), preset.brief.comps, preset.compTypes);
    const comps = res.map(bestCandidate).filter((c): c is Comp => !!c);
    let researchTurns = 0;
    fakeServer((body) => {
      const sys = String((body.messages as { content: string }[])[0].content);
      if (body.tools) {
        researchTurns++;
        const tool_calls =
          researchTurns === 1
            ? [
                { id: "a", type: "function", function: { name: "audience_affinities", arguments: JSON.stringify({ comp_ids: [comps[0].entityId], domain: "podcast", reason: "podcasts first" }) } },
                { id: "b", type: "function", function: { name: "audience_tags", arguments: "{oops" } },
              ]
            : [{ id: "c", type: "function", function: { name: "finish_research", arguments: JSON.stringify({ reason: "enough" }) } }];
        return { json: { model: "open-model", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls } }], usage: { prompt_tokens: 2000, completion_tokens: 200 } } };
      }
      if (sys.includes("campaign strategist")) {
        const concept = (lever: string, m: string[], p: string[]) => ({ lever, name: `${lever} plan`, leadCompIds: [comps[0].entityId], marketKeys: m, partnerKeys: p, creativeAngle: { text: "Lean into dread.", factIds: [] }, risks: ["Narrow reach."], hypotheses: ["Podcasts may convert."] });
        return reply(JSON.stringify({ concepts: [concept("market", ["M1", "M2", "M3"], ["P1", "P2", "P3", "P4"]), concept("partner", ["M4", "M5", "M6"], ["P5", "P6", "P7", "P8"]), concept("crossover", ["M7", "M8", "M9"], ["P9", "P10", "P11", "P12"])] }), { prompt_tokens: 5000, completion_tokens: 1500 });
      }
      return reply(JSON.stringify({ recommendedLever: "partner", rationale: [{ text: "This plan rests on shared signals.", factIds: ["F1"] }], whyNotOthers: [], tradeoffs: ["Broader reach."], testChecklist: ["Run a small paid test."] }), { prompt_tokens: 4000, completion_tokens: 600 });
    });

    const run = await runPlan({ brief: preset.brief, comps, mode: "fixture" });
    expect(run.llmUsed).toBe(true);
    expect(run.trace.some((t) => t.kind === "tool" && t.message.includes("invalid tool arguments"))).toBe(true);
    expect(run.concepts.map((c) => c.name)).toEqual(["market plan", "partner plan", "crossover plan"]);
    expect(run.decision.writtenBy).toBe("llm");
    const u = run.llmUsage;
    expect(u.byPhase.map((p) => p.phase)).toEqual(["research", "conceive", "brief"]);
    expect(u).toMatchObject({ provider: "openai", calls: 4, inputTokens: 13_000, outputTokens: 2_500 });
    expect(u.costUsd).toBeCloseTo((13_000 * 0.2 + 2_500 * 0.6) / 1e6, 9);
    expect(run.trace.filter((t) => t.kind === "llm" && /in \/ .* out/.test(t.message)).length).toBe(4);
  });
});

describe("open-model speed and reliability options", () => {
  it("sends reasoning_effort, and drops it once if the host rejects it", async () => {
    let n = 0;
    const calls = fakeServer((body) => {
      n++;
      if (n === 1 && body.reasoning_effort) return { status: 400, json: { error: { message: "unknown parameter: reasoning_effort" } } };
      return reply('{"answer":"ok"}');
    });
    const llm = new OpenAICompatibleLLM({ provider: "openai", baseUrl: "https://host/v1", model: "m", reasoningEffort: "low" });
    expect(await llm.structured({ system: "s", user: "u", schema: z.object({ answer: z.string() }) })).toEqual({ answer: "ok" });
    expect(calls[0].body.reasoning_effort).toBe("low");
    expect(calls[1].body.reasoning_effort).toBeUndefined();
    await llm.structured({ system: "s", user: "u", schema: z.object({ answer: z.string() }) });
    expect(calls[2].body.reasoning_effort).toBeUndefined();
  });

  it("forces a tool call only when asked", async () => {
    const calls = fakeServer(() => ({ json: { choices: [{ finish_reason: "stop", message: { content: "x" } }] } }));
    const llm = new OpenAICompatibleLLM({ provider: "ollama", baseUrl: "http://o/v1", model: "m" });
    await llm.toolTurn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [], requireTool: true });
    await llm.toolTurn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(calls.map((c) => c.body.tool_choice)).toEqual(["required", "auto"]);
  });

  it("fails loudly when Ollama truncates a long prompt", async () => {
    fakeServer(() => reply('{"answer":"ok"}', { prompt_tokens: 2050, completion_tokens: 5 }));
    const llm = new OpenAICompatibleLLM({ provider: "ollama", baseUrl: "http://o/v1", model: "m" });
    const long = "market candidate line with a score\n".repeat(2000);
    await expect(llm.structured({ system: "s", user: long, schema: z.object({ answer: z.string() }) })).rejects.toThrow(/truncated the prompt/);
  });

  it("explains a missing Ollama model", async () => {
    fakeServer(() => ({ status: 404, json: { error: "model not found" } }));
    const llm = new OpenAICompatibleLLM({ provider: "ollama", baseUrl: "http://o/v1", model: "crossover-gpt-oss" });
    await expect(llm.toolTurn({ system: "s", messages: [{ role: "user", content: "u" }], tools: [] })).rejects.toThrow(/npm run ollama:setup/);
  });
});
