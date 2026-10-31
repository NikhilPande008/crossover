// Regression tests for the 2026-10-31 audit fixes: confidence, validator, presets, baseline,
// Qloo client retries and quota headers, and model-call time budgets.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Brief, Comp, Concept, Fact, RunResult } from "@/lib/types";
import { conceptConfidence } from "@/lib/score";
import { makeContext, stripCitations, validateCited, validateUncited } from "@/lib/validate/grounding";
import { PlanRequest } from "@/lib/validate/input";
import { PRESETS, matchesPreset } from "@/lib/presets";
import { loadRecorded, saveRun } from "@/lib/runs";
import { QlooClient, quotaStatus } from "@/lib/qloo/client";
import { LLMBudgetError, callTimeout, describeLLMError } from "@/lib/llm/budget";
import { LLMHttpError, OpenAICompatibleLLM } from "@/lib/llm/openai-compatible";
import { z } from "zod";

process.env.CROSSOVER_MODE = "fixture";
process.env.LLM_PROVIDER = "none";

const comps: Comp[] = [
  { name: "Hereditary", entityId: "a", type: "movie" },
  { name: "The Witch", entityId: "b", type: "movie" },
];
const brief: Brief = { title: "The Tithe", format: "film", comps: ["Hereditary", "The Witch"], regions: ["US"], budget: "M", exclusions: [] };
const fact = (id: string, kind: Fact["kind"], name: string, value: number, compIds = ["a"], type = "podcast"): Fact => ({
  id,
  kind,
  compIds,
  subject: { entityId: `e-${id}`, name, type },
  value,
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "",
  recorded: false,
  synthetic: true,
});

describe("confidence", () => {
  it("does not count a combined-signal fact as agreement between comps", () => {
    const combined = fact("F1", "affinity", "Night Shift Radio", 0.97, ["a", "b"]);
    const c = { partners: [{ name: "Night Shift Radio", domain: "podcast", factIds: ["F1"] }], markets: [] };
    expect(conceptConfidence(c, [combined], comps, false)).toBe("medium");
  });
  it("still rates per-comp agreement high", () => {
    const fs = [fact("F1", "affinity", "Night Shift Radio", 0.9, ["a"]), fact("F2", "affinity", "Night Shift Radio", 0.9, ["b"])];
    const c = { partners: [{ name: "Night Shift Radio", domain: "podcast", factIds: ["F1", "F2"] }], markets: [] };
    expect(conceptConfidence(c, fs, comps, false)).toBe("high");
  });
});

describe("grounding validator bypasses", () => {
  const facts = [fact("F1", "tag", "Ghost", 0.99, ["a"], "tag"), fact("F2", "affinity", "Night Shift Radio", 0.9), fact("F3", "tag", "Mental Illness", 0.99, ["a"], "tag"), fact("F4", "affinity", "F1", 0.9, ["a"], "movie")];
  const ctx = makeContext(facts, comps, brief);
  it("refuses quantities written in words", () => {
    expect(validateUncited("Fans are ten times more likely to convert.", ctx)?.reason).toMatch(/quantity/);
    expect(validateUncited("Twice as many fans will share it.", ctx)?.reason).toMatch(/quantity/);
    expect(validateUncited("One in five viewers will return.", ctx)?.reason).toMatch(/quantity/);
    expect(validateUncited("Millions of fans are waiting.", ctx)?.reason).toMatch(/quantity/);
  });
  it("keeps ordinary counting words", () => {
    expect(validateUncited("Test two creative cuts before choosing one audience to lead with.", ctx)).toBeNull();
  });
  it("refuses invented names that only share a substring or one word with a known name", () => {
    expect(validateCited({ text: "Partner with the Ghost Adventures Weekly Podcast.", factIds: ["F1"] }, ctx).ok).toBe(false);
    expect(validateCited({ text: "Book a slot on Ghostbusters Afterlife Radio.", factIds: ["F1"] }, ctx).ok).toBe(false);
    expect(validateCited({ text: "Lean into Ghost themes with Night Shift Radio.", factIds: ["F1", "F2"] }, ctx).ok).toBe(true);
  });
  it("blocks sensitive language even when a taste tag has that name", () => {
    expect(validateUncited("Target viewers living with mental illness.", ctx)?.reason).toMatch(/sensitive/);
  });
  it("keeps a partner literally named F1 while stripping citation markers", () => {
    expect(stripCitations("Pair it with F1 (F4) for launch.", ctx.known)).toBe("Pair it with F1 for launch.");
    expect(validateCited({ text: "Pair the launch with F1 fans.", factIds: ["F4"] }, ctx).ok).toBe(true);
    expect(stripCitations("Strong signal F12.", ctx.known)).toBe("Strong signal .");
  });
});

describe("presets and recorded runs", () => {
  const preset = PRESETS[0];
  it("accepts only known preset ids", () => {
    const body = { brief: preset.brief, comps: [{ name: "x", entityId: "1", type: "movie" }, { name: "y", entityId: "2", type: "movie" }] };
    expect(PlanRequest.safeParse({ ...body, presetId: preset.id }).success).toBe(true);
    expect(PlanRequest.safeParse({ ...body, presetId: "../../package" }).success).toBe(false);
  });
  it("matches only the preset's own brief", () => {
    expect(matchesPreset(preset.id, preset.brief)).toBe(true);
    expect(matchesPreset(preset.id, { ...preset.brief, comps: preset.brief.comps.map((c) => (c === preset.swap.from ? preset.swap.to : c)) })).toBe(false);
    expect(matchesPreset(preset.id, { ...preset.brief, title: "Something else" })).toBe(false);
  });
  it("refuses unsafe ids for recorded-run files", async () => {
    expect(await loadRecorded("../../package")).toBeUndefined();
  });
});

describe("baseline route", () => {
  const run = { runId: "known-run", mode: "fixture", brief, comps, facts: [] } as unknown as RunResult;
  it("does not let a malformed client copy block a run the server knows", async () => {
    await saveRun(run);
    const { POST } = await import("@/app/api/baseline/route");
    const res = await POST(new Request("http://x/api/baseline", { method: "POST", body: JSON.stringify({ runId: "known-run", run: { junk: true } }) }));
    expect(res.status).toBe(200);
  });
  it("rejects a malformed client copy of an unknown run", async () => {
    const { POST } = await import("@/app/api/baseline/route");
    const res = await POST(new Request("http://x/api/baseline", { method: "POST", body: JSON.stringify({ runId: "unknown", run: { junk: true } }) }));
    expect(res.status).toBe(422);
  });
});

describe("Qloo live client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.QLOO_API_KEY;
  });
  it("retries a 429 and records quota header names but not values", async () => {
    process.env.QLOO_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "x-second-ratelimit-reset": "0.01" } }))
      .mockResolvedValueOnce(Response.json({ results: [] }, { headers: { "x-ratelimit-remaining-month": "9000" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QlooClient({ maxCalls: 1, mode: "live" });
    const res = await client.get("/search", { query: "audit-retry-probe", types: "urn:entity:movie", take: "1" });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.calls).toBe(1);
    expect(quotaStatus().headersSeen).toContain("x-ratelimit-remaining-month");
    expect(quotaStatus().remaining).toBe(9000);
  });
});

describe("model-call time budget", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("refuses a call with no time left, before any request", async () => {
    expect(() => callTimeout(40_000, Date.now() + 500)).toThrow(LLMBudgetError);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const llm = new OpenAICompatibleLLM({ provider: "openai", baseUrl: "http://llm.test/v1", model: "m" });
    await expect(llm.structured({ system: "s", user: "u", schema: z.object({ a: z.string() }), deadline: Date.now() + 100 })).rejects.toThrow(LLMBudgetError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("describes provider failures without their response bodies", () => {
    expect(describeLLMError(new LLMHttpError(401, 'openai 401: {"error":"Incorrect API key provided: sk-...abcd"}'))).toBe("model API returned HTTP 401");
    expect(describeLLMError(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }))).toBe("model call timed out");
  });
});

describe("recommendation is chosen in code", () => {
  it("prefers higher confidence, then the bridge when most comp pairs share an audience, and says why", async () => {
    const { explainRecommended } = await import("@/lib/agent/brief");
    const concept = (id: string, lever: Concept["lever"], confidence: Concept["confidence"]): Concept => ({ id, lever, confidence, name: id, leadComps: [], markets: [], partners: [], creativeAngle: { text: "", factIds: [] }, risks: [], hypotheses: [] });
    const overlap = (similar: boolean) => ({ a: "a", b: "b", score: 0, basis: "taste-tags" as const, compared: 0, sharedAudience: [], shared: [], onlyA: [], onlyB: [], source: "compare-endpoint" as const, themeShare: similar ? 0.2 : 0.02, themesCompared: 50, similar, factIds: [] });
    const audience = (similar: boolean) => ({ partners: {} as never, markets: [], tags: [], demographics: [], overlaps: [overlap(similar)], gaps: [] });
    const tied = [concept("C1", "market", "medium"), concept("C2", "partner", "medium"), concept("C3", "crossover", "medium")];
    expect(explainRecommended([...tied], audience(true)).concept.lever).toBe("partner");
    expect(explainRecommended([...tied], audience(false)).concept.lever).toBe("market");
    const r = explainRecommended([concept("C1", "market", "medium"), concept("C2", "partner", "low"), concept("C3", "crossover", "high")], audience(true));
    expect(r.concept.lever).toBe("crossover");
    expect(r.reason).toMatch(/highest confidence/);
  });
});
