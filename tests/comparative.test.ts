// Rule 6: comparative claims must match the run's scores. Market scores mirror the
// 2026-10-25 live prestige-horror run.

import { describe, expect, it } from "vitest";
import type { AudienceMap, Brief, Comp, Concept, Fact, RankedMarket, RankedPartner } from "@/lib/types";
import { buildScoreScope } from "@/lib/validate/comparative";
import { checkComparativeClaim, makeContext, validateCited } from "@/lib/validate/grounding";

const comps: Comp[] = [
  { name: "Hereditary", entityId: "H", type: "movie" },
  { name: "The Witch", entityId: "W", type: "movie" },
];
const brief: Brief = { title: "The Tithe", format: "film", comps: ["Hereditary", "The Witch"], regions: ["US", "GB"], budget: "M", exclusions: [] };

const market = (name: string, score: number, perComp: Record<string, number> = {}): RankedMarket => ({ name, country: "", score, perComp, factIds: [`h-${name}`] });
const tv = (name: string, score: number, perComp: Record<string, number> = {}): RankedPartner => ({ name, domain: "tv_show", score, perComp, factIds: [`a-${name}`] });

const markets = [
  market("Boston", 0.946, { H: 0.9, W: 0.99 }),
  market("Portland", 0.871, { H: 0.95, W: 0.79 }),
  market("Salt Lake City", 0.871),
  market("Austin", 0.839, { H: 0.99, W: 0.69 }),
  market("Los Angeles", 0.828),
  market("Edinburgh", 0.806, { H: 0.7, W: 0.91 }),
];
const shows = [tv("The Midnight Club", 0.639), tv("Chapelwaite", 0.639), tv("Midnight Mass", 0.638), tv("Salem", 0.33), tv("The Haunting of Hill House", 0.32)];
const audience = { markets, partners: { tv_show: shows, podcast: [], artist: [], movie: [], book: [], brand: [] }, tags: [], demographics: [], overlaps: [], gaps: [] } as AudienceMap;
const concept: Concept = {
  id: "C2",
  lever: "partner",
  name: "Bridge the horror-thriller community",
  leadComps: ["H", "W"],
  markets: ["Portland", "Austin", "Edinburgh"].map((name) => ({ name, factIds: [`h-${name}`] })),
  partners: ["The Midnight Club", "Salem", "The Haunting of Hill House"].map((name) => ({ name, domain: "tv_show", factIds: [`a-${name}`] })),
  creativeAngle: { text: "", factIds: [] },
  confidence: "high",
  risks: [],
  hypotheses: [],
};

const facts: Fact[] = [...markets.map((m) => ({ n: m.name, k: "heatmap" as const })), ...shows.map((s) => ({ n: s.name, k: "affinity" as const }))].map(({ n, k }) => ({
  id: `${k === "heatmap" ? "h" : "a"}-${n}`,
  kind: k,
  compIds: ["H"],
  subject: { name: n, type: k === "heatmap" ? "city:US" : "tv_show" },
  value: 0.9,
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "",
  recorded: false,
  synthetic: false,
}));
const ctx = makeContext(facts, comps, brief);
ctx.scores = buildScoreScope(audience, [concept], comps);
const claim = (text: string) => checkComparativeClaim(text, ctx);

describe("comparative claims", () => {
  it("drops the live run's false claim about Edinburgh", () => {
    const issue = claim("The heatmap for Edinburgh, a key market in the partner concept, is higher than for the other markets.");
    expect(issue?.reason).toMatch(/Edinburgh is the highest, but it ranks 6 of 6 in all markets; 3 of 3 in Bridge the horror-thriller community markets/);
  });

  it("accepts true superlatives in the run-wide ranking", () => {
    expect(claim("Boston has the strongest fan concentration.")).toBeNull();
  });

  it("accepts a claim that holds within the concept even if not run-wide", () => {
    expect(claim("Portland has the highest fan concentration of this concept's markets.")).toBeNull();
  });

  it("checks pairwise comparisons in the stated direction", () => {
    expect(claim("Austin shows higher fan concentration than Portland.")?.reason).toMatch(/0.839 vs 0.871/);
    expect(claim("Portland shows higher fan concentration than Austin.")).toBeNull();
    expect(claim("Edinburgh has lower interest than Boston.")).toBeNull();
  });

  it("uses a named comp's own scores", () => {
    // Overall Austin (0.839) trails Portland (0.871), but for Hereditary's fans it leads.
    expect(claim("Among Hereditary fans, Austin shows higher fan concentration than Portland.")).toBeNull();
    expect(claim("For The Witch's audience, Edinburgh has higher interest than Portland.")).toBeNull();
  });

  it("treats several names or 'among' as a top-k claim", () => {
    expect(claim("The Midnight Club and Chapelwaite carry the strongest affinity signals.")).toBeNull();
    expect(claim("The Haunting of Hill House is among the strongest affinity signals.")).toBeNull(); // top 3 of the concept's TV partners
    expect(claim("The Midnight Club, Midnight Mass and Salem show the strongest affinity scores.")).toBeNull();
  });

  it("checks low claims too", () => {
    expect(claim("Edinburgh has the lowest fan concentration of the concept's markets.")).toBeNull();
    expect(claim("Boston has the weakest fan concentration.")?.reason).toMatch(/Boston is the lowest/);
  });

  it("ignores taste superlatives and sentences without named items", () => {
    expect(claim("The Haunting of Hill House is the most atmospheric show on the list.")).toBeNull();
    expect(claim("The partner lever has the strongest affinity signals.")).toBeNull();
  });

  it("is enforced by validateCited", () => {
    expect(validateCited({ text: "Edinburgh has the highest fan concentration.", factIds: ["h-Edinburgh"] }, ctx).ok).toBe(false);
    expect(validateCited({ text: "Boston has the highest fan concentration.", factIds: ["h-Boston"] }, ctx).ok).toBe(true);
  });
});

describe("top-k scales with the group", () => {
  it("allows 'among the strongest' for the top quarter of a long list, not beyond", () => {
    const long = Array.from({ length: 28 }, (_, i) => tv(`Show ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ""}`, 1 - i / 100));
    const aud = { ...audience, partners: { ...audience.partners, tv_show: long } } as AudienceMap;
    const f = long.map((s) => ({ ...facts[0], id: `x-${s.name}`, kind: "affinity" as const, subject: { name: s.name, type: "tv_show" } }));
    const c = makeContext(f, comps, brief);
    c.scores = buildScoreScope(aud, [], comps);
    expect(checkComparativeClaim(`${long[4].name} is among the strongest affinity signals.`, c)).toBeNull(); // rank 5 of 28, k = 7
    expect(checkComparativeClaim(`${long[10].name} is among the strongest affinity signals.`, c)?.reason).toMatch(/ranks 11 of 28/);
    expect(checkComparativeClaim(`${long[1].name} has the strongest affinity.`, c)?.reason).toMatch(/is the highest/);
  });
});
