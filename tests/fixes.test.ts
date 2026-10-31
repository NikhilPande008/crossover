// Regression tests for the code-review findings.

import { describe, expect, it } from "vitest";
import type { AudienceMap, Brief, Comp, Concept, Fact, RunResult } from "@/lib/types";
import { allowHit, capLimit, clientIp, isRefinementOf } from "@/lib/runs";
import { compareAudiences, fetchTags } from "@/lib/qloo/api";
import { FactStore } from "@/lib/facts/store";
import { QlooClient, QlooError } from "@/lib/qloo/client";
import { makeContext, validateCited, validateUncited } from "@/lib/validate/grounding";
import { templateConcepts, type Candidates } from "@/lib/agent/concepts";
import { templateBrief } from "@/lib/agent/brief";
import { runPlan, RunAborted } from "@/lib/agent/loop";

process.env.CROSSOVER_MODE = "fixture";
process.env.LLM_PROVIDER = "none";

const comp = (id: string, name = id): Comp => ({ name, entityId: id, type: "movie" });
const brief: Brief = { title: "T", format: "film", comps: ["A", "B", "C"], regions: ["US"], budget: "M", exclusions: [] };

describe("per-visitor caps", () => {
  it("treats a priorRunId with a new comp set as a new run", () => {
    const prior = { comps: [comp("a"), comp("b"), comp("c")] } as RunResult;
    expect(isRefinementOf(prior, ["a", "b", "d"])).toBe(true); // one comp swapped
    expect(isRefinementOf(prior, ["a", "b", "c"])).toBe(true); // exclude / pin
    expect(isRefinementOf(prior, ["x", "y", "z"])).toBe(false); // disguised full run
    expect(isRefinementOf(prior, ["a", "y", "z"])).toBe(false);
    expect(isRefinementOf(undefined, ["a", "b"])).toBe(false);
  });
  it("counts refinements against their own cap", async () => {
    const ip = `test-${Math.random()}`;
    for (let i = 0; i < capLimit("refine"); i++) expect(await allowHit("refine", ip)).toBe(true);
    expect(await allowHit("refine", ip)).toBe(false);
  });
  it("ignores client-supplied X-Forwarded-For entries", () => {
    const req = (xff: string) => new Request("http://x", { headers: { "x-forwarded-for": xff } });
    expect(clientIp(req("6.6.6.6, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("7.7.7.7, 203.0.113.9"))).toBe("203.0.113.9");
    expect(clientIp(req("203.0.113.9"))).toBe("203.0.113.9");
  });
});

describe("compare endpoint", () => {
  const fake = (handler: (path: string) => unknown) => {
    const paths: string[] = [];
    const client = {
      mode: "live",
      async get(path: string, params: Record<string, string>) {
        paths.push(path);
        const data = handler(path);
        if (data instanceof QlooError) throw data;
        return { data, status: 200, cached: false, synthetic: false, retrievedAt: "", ms: 0, req: { path, params } };
      },
    } as unknown as QlooClient;
    return { client, paths };
  };
  const grouped = { results: [{ type: "common", tags: [{ tag_id: "t1", name: "dread", query: { affinity: 0.8 } }] }] };

  it("uses the documented path and keeps trying after an empty or 404 pair", async () => {
    const empty = fake(() => ({ results: [] }));
    expect(await compareAudiences(empty.client, new FactStore(), comp("a"), comp("b"))).toBeNull();
    const notFound = fake((p) => new QlooError("No results", 404, { path: p, params: {} }));
    expect(await compareAudiences(notFound.client, new FactStore(), comp("a"), comp("b"))).toBeNull();
    const ok = fake(() => grouped);
    expect(await compareAudiences(ok.client, new FactStore(), comp("a"), comp("c"))).toHaveLength(1);
    expect([...empty.paths, ...notFound.paths, ...ok.paths].every((p) => p === "/v2/analysis/compare")).toBe(true);
  });
});

describe("cached and re-used facts are badged recorded", () => {
  it("marks facts built from a cache hit as recorded", async () => {
    const c = comp(`syn-cache-${Math.random()}`);
    const first = await fetchTags(new QlooClient({ maxCalls: 2, mode: "fixture" }), new FactStore(), [c]);
    const second = await fetchTags(new QlooClient({ maxCalls: 2, mode: "fixture" }), new FactStore(), [c]);
    expect(first.every((f) => !f.recorded)).toBe(true);
    expect(second.every((f) => f.recorded && f.retrievedAt === first[0].retrievedAt)).toBe(true);
  });
});

describe("validator does not misread entity names", () => {
  const fact = (id: string, name: string, value: number): Fact => ({
    id,
    kind: "affinity",
    compIds: ["a"],
    subject: { name, type: "artist" },
    value,
    request: { path: "/v2/insights", params: {} },
    retrievedAt: "",
    recorded: false,
    synthetic: false,
  });
  const ctx = makeContext([fact("F1", "The 1975", 0.8), fact("F2", "RuPaul's Drag Race", 0.7), fact("F3", "Blink-182", 0.6)], [comp("a", "Hereditary")], brief);
  it("keeps sentences naming partners with digits or sensitive-looking words", () => {
    expect(validateCited({ text: "The 1975 is the strongest shared artist.", factIds: ["F1"] }, ctx).ok).toBe(true);
    expect(validateCited({ text: "Fans also love RuPaul's Drag Race.", factIds: ["F2"] }, ctx).ok).toBe(true);
    expect(validateCited({ text: "Blink-182 shows up for both comps.", factIds: ["F3"] }, ctx).ok).toBe(true);
  });
  it("still catches invented numbers and sensitive language outside names", () => {
    expect(validateCited({ text: "The 1975 could add 40% reach.", factIds: ["F1"] }, ctx).ok).toBe(false);
    expect(validateUncited("Target viewers by race.", ctx)).not.toBeNull();
  });
});

describe("templates", () => {
  const A = comp("a", "A");
  const B = comp("b", "B");
  const C = comp("c", "C");
  const audienceWith = (overlaps: AudienceMap["overlaps"], markets: AudienceMap["markets"] = []): AudienceMap => ({
    partners: {
      podcast: [],
      // B has the most partner signal, so B is the lead.
      artist: [{ name: "x", domain: "artist", score: 1, perComp: { a: 0.2, b: 0.9, c: 0.3 }, factIds: [] }],
      tv_show: [],
      movie: [],
      book: [],
      brand: [],
    },
    markets,
    tags: [],
    demographics: [],
    overlaps,
    gaps: [],
  });
  const ov = (a: string, b: string, score: number) => ({ a, b, score, basis: "audience-affinities" as const, compared: 10, sharedAudience: [], shared: [], onlyA: [], onlyB: [], source: "compare-endpoint" as const, themeShare: score, themesCompared: 10, similar: score >= 0.1, factIds: [] });
  const cand: Candidates = { markets: [], partners: [], removals: [] };

  it("crossover targets the comp least like the lead, wherever it sits in the pair", () => {
    // Lead is B. A overlaps B strongly (0.8); C overlaps B weakly (0.1).
    const audience = audienceWith([ov("a", "b", 0.8), ov("a", "c", 0.5), ov("b", "c", 0.1)]);
    const crossover = templateConcepts(audience, cand, [A, B, C], brief)[2];
    expect(crossover.leadComps).toEqual(["c"]);
  });

  it("template brief names the concept's strongest market, not a pinned one", () => {
    const m = (name: string) => ({ name, country: "US", score: 0, perComp: {}, factIds: [`F-${name}`] });
    const audience = audienceWith([ov("a", "b", 0.5)], [m("Houston"), m("Boston"), m("Detroit")]);
    const concept: Concept = {
      id: "C1",
      lever: "market",
      name: "x",
      leadComps: ["a"],
      markets: [m("Detroit"), m("Boston")], // Detroit pinned to the front
      partners: [],
      creativeAngle: { text: "", factIds: [] },
      confidence: "high",
      risks: [],
      hypotheses: [],
    };
    const b = templateBrief([concept], audience, [A, B]);
    const text = b.rationale.map((r) => r.text).join(" ");
    expect(text).toContain("Boston has the strongest fan concentration");
    expect(text).not.toMatch(/Detroit .*top/);
  });
});

describe("abort", () => {
  it("stops the run when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runPlan({ brief, comps: [comp("syn-a"), comp("syn-b")], mode: "fixture", signal: ac.signal })).rejects.toBeInstanceOf(RunAborted);
  });
});

describe("no personal data to Qloo", async () => {
  const { ResolveRequest } = await import("@/lib/validate/input");
  it("rejects emails, phone numbers and links as comp names", () => {
    for (const bad of ["someone@example.com", "+1 (555) 123-4567", "https://example.com/film"])
      expect(ResolveRequest.safeParse({ comps: [bad], format: "film" }).success).toBe(false);
  });
  it("accepts titles with numbers", () => {
    for (const ok of ["2001: A Space Odyssey", "The 1975", "Blade Runner 2049", "Ocean's 11"])
      expect(ResolveRequest.safeParse({ comps: [ok], format: "film" }).success).toBe(true);
  });
});

describe("plan request input", () => {
  it("clips long Qloo descriptors instead of rejecting the run", async () => {
    const { PlanRequest } = await import("@/lib/validate/input");
    const long = "x".repeat(650);
    const r = PlanRequest.safeParse({
      brief,
      comps: [
        { ...comp("a"), descriptor: long },
        { ...comp("b"), descriptor: long },
      ],
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.comps[0].descriptor?.length).toBe(400);
  });
});

describe("comp match closeness", () => {
  it("flags a made-up title but not a real one", async () => {
    const { isCloseMatch } = await import("@/lib/match");
    expect(isCloseMatch("Glorbnax Quintessence 3000", "Three Thousand Years of Longing")).toBe(false);
    expect(isCloseMatch("Perks of Being a Wallflower", "The Perks of Being a Wallflower")).toBe(true);
    expect(isCloseMatch("hereditary", "Hereditary")).toBe(true);
    expect(isCloseMatch("The Witch", "The Witcher")).toBe(false);
  });
});

describe("creative tag filter", () => {
  it("keeps story and media tags and drops place, brand and payment tags (invented IDs, real type:domain pairs)", async () => {
    const { isCreativeTag } = await import("@/lib/qloo/api");
    for (const id of ["urn:tag:plot:qloo:example_plot", "urn:tag:style:qloo:example_style", "urn:tag:keyword:media:example_keyword", "urn:tag:archetype:qloo:example_archetype"])
      expect(isCreativeTag(id)).toBe(true);
    for (const id of ["urn:tag:genre:brand:example_brand", "urn:tag:genre:music:example_music", "urn:tag:credit_card:place:example_card", "urn:tag:genre:place:example_place:sub", "urn:tag:backdrop:qloo:example_city", "urn:tag:genre:media:example_genre", "urn:tag:theme:qloo:example_theme", undefined])
      expect(isCreativeTag(id)).toBe(false);
  });
});
