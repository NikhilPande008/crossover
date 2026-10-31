// End-to-end agent run in fixture mode (synthetic data, no LLM).

import { beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@/lib/presets";
import { QlooClient, resetQlooCache } from "@/lib/qloo/client";
import { bestCandidate, resolveComps } from "@/lib/agent/resolve";
import { runPlan } from "@/lib/agent/loop";
import { diffRuns } from "@/lib/diff";
import { assertParams } from "@/lib/qloo/params";
import type { Comp, RunResult } from "@/lib/types";

process.env.CROSSOVER_MODE = "fixture";
process.env.LLM_PROVIDER = "none";

const preset = PRESETS[0];
let comps: Comp[];
let run: RunResult;

beforeAll(async () => {
  const res = await resolveComps(new QlooClient({ maxCalls: 10, mode: "fixture" }), preset.brief.comps, preset.compTypes);
  comps = res.map(bestCandidate).filter((c): c is Comp => !!c);
  run = await runPlan({ brief: preset.brief, comps, mode: "fixture" });
});

describe("agent (fixture mode)", () => {
  it("stays inside the Qloo call budget", () => {
    expect(run.qlooCalls).toBeGreaterThan(10);
    expect(run.qlooCalls).toBeLessThanOrEqual(30);
  });
  it("produces three concepts with distinct levers", () => {
    expect(run.concepts.map((c) => c.lever).sort()).toEqual(["crossover", "market", "partner"]);
  });
  it("cites only facts that exist", () => {
    const ids = new Set(run.facts.map((f) => f.id));
    for (const c of run.concepts) for (const x of [...c.partners, ...c.markets, c.creativeAngle]) for (const id of x.factIds) expect(ids.has(id)).toBe(true);
    for (const r of run.decision.rationale) expect(r.factIds.every((id) => ids.has(id))).toBe(true);
  });
  it("names only partners that exist in the fact store", () => {
    const names = new Set(run.facts.map((f) => f.subject?.name));
    for (const c of run.concepts) for (const p of c.partners) expect(names.has(p.name)).toBe(true);
  });
  it("honours brief exclusions (alcohol brands)", () => {
    const partners = run.concepts.flatMap((c) => c.partners.map((p) => p.name));
    expect(partners).not.toContain("Hollowbrook Cider");
    expect(partners).not.toContain("Ferrous Brewing");
    expect(run.constraintRemovals.find((r) => r.constraint === "alcohol")?.count).toBeGreaterThan(0);
  });
  it("labels synthetic data and falls back to a templated brief without an LLM", () => {
    expect(run.mode).toBe("fixture");
    expect(run.facts.every((f) => f.synthetic)).toBe(true);
    expect(run.decision.writtenBy).toBe("template");
    expect(run.decision.disclaimer).toMatch(/not a forecast/);
  });
  it("re-plans a comp swap cheaply, reusing still-valid facts, and the plan changes", async () => {
    const [swapRes] = await resolveComps(new QlooClient({ maxCalls: 2, mode: "fixture" }), [preset.swap.to], preset.compTypes);
    const swapped = comps.map((c) => (c.name === preset.swap.from ? bestCandidate(swapRes)! : c));
    // Empty the response cache first: otherwise every repeated request is a free cache hit and the
    // swap looks cheap even if no prior fact were reused.
    resetQlooCache();
    const next = await runPlan({ brief: preset.brief, comps: swapped, priorFacts: run.facts, mode: "fixture" });
    expect(next.qlooCalls).toBeLessThanOrEqual(10); // only the new comp: 4 domains, tags, 2 regions, demographics, 2 compares
    expect(next.cachedCalls).toBe(0);
    resetQlooCache();
    const fromScratch = await runPlan({ brief: preset.brief, comps: swapped, mode: "fixture" });
    expect(fromScratch.qlooCalls).toBeGreaterThan(next.qlooCalls + 10);
    const d = diffRuns(run, next);
    expect(d.marketsChanged + d.partnersChanged).toBeGreaterThan(0);
  });
  it("applies refinements: excluded partner absent, pinned market present", async () => {
    const victim = run.concepts[0].partners[0].name;
    const pin = run.audience.markets.at(-1)!.name;
    const next = await runPlan({ brief: preset.brief, comps, priorFacts: run.facts, refinements: { excludedPartners: [victim], pinnedMarkets: [pin] }, mode: "fixture" });
    for (const c of next.concepts) {
      expect(c.partners.map((p) => p.name)).not.toContain(victim);
      expect(c.markets.map((m) => m.name)).toContain(pin);
    }
  });
});

describe("param allowlist", () => {
  it("refuses unknown params", () => {
    expect(() => assertParams("/v2/insights", { "filter.type": "urn:entity:artist", "filter.bogus": "1" })).toThrow();
    expect(() => assertParams("/v2/insights", { "filter.type": "urn:entity:artist", take: "5" })).not.toThrow();
  });
});
