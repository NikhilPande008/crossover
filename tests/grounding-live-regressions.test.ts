// Sentences quoted in the 2026-10-31 review of live runs, as fixtures. Each one was either
// wrongly dropped by the validator, wrongly let through, or exposed a typed-checklist gap.

import { describe, expect, it } from "vitest";
import type { AudienceMap, Brief, Comp, Concept, Fact, RankedMarket } from "@/lib/types";
import { checkComparativeClaim, makeContext, validateCited } from "@/lib/validate/grounding";
import { buildScoreScope } from "@/lib/validate/comparative";
import { isCreativeTag } from "@/lib/qloo/api";
import { renderTests } from "@/lib/agent/brief";
import { attachNamed } from "@/lib/agent/loop";

const comps: Comp[] = [
  { name: "Hereditary", entityId: "H", type: "movie", year: 2018 },
  { name: "The Witch", entityId: "W", type: "movie", year: 2015 },
  { name: "Fleabag", entityId: "F", type: "tv_show", year: 2016 },
];
const brief: Brief = { title: "The Tithe", format: "film", comps: comps.map((c) => c.name), regions: ["US", "GB"], budget: "M", exclusions: [] };

let n = 0;
const fact = (kind: Fact["kind"], name: string, type: string, value = 0.9, extra: Partial<Fact> = {}): Fact => ({
  id: `F${++n}`,
  kind,
  compIds: ["H"],
  subject: { name, type },
  value,
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "2026-10-31T00:00:00Z",
  recorded: false,
  synthetic: false,
  ...extra,
});

const boston = fact("heatmap", "Boston", "city:US", 0.99);
const portland = fact("heatmap", "Portland", "city:US", 0.95);
const brighton = fact("heatmap", "Brighton", "city:GB", 0.9);
const glass = fact("affinity", "Glass Summer", "artist", 0.91);
const vs = fact("affinity", "Victoria's Secret", "brand", 0.88);
const mitski = fact("affinity", "Mitski", "artist", 0.93);
const magnus = fact("affinity", "The Magnus Archives", "podcast", 0.94);
const dread = fact("tag", "Dread", "tag", 0.8);
const facts = [boston, portland, brighton, glass, vs, mitski, magnus, dread];
const ctx = makeContext(facts, comps, brief);

const market = (f: Fact, score: number): RankedMarket => ({ name: f.subject!.name, country: "US", score, perComp: { H: score }, factIds: [f.id] });
const concept: Concept = {
  id: "C1",
  lever: "market",
  name: "Own the dread",
  leadComps: ["H"],
  markets: [boston, portland].map((f) => ({ name: f.subject!.name, factIds: [f.id] })),
  partners: [
    { name: "Mitski", domain: "artist", factIds: [mitski.id] },
    { name: "The Magnus Archives", domain: "podcast", factIds: [magnus.id] },
    { name: "Victoria's Secret", domain: "brand", factIds: [vs.id] },
  ],
  creativeAngle: { text: "", factIds: [] },
  confidence: "medium",
  risks: [],
  hypotheses: [],
};
ctx.scores = buildScoreScope(
  { markets: [market(boston, 0.98), market(portland, 0.9)], partners: { podcast: [], artist: [], tv_show: [], movie: [], book: [], brand: [] }, tags: [], demographics: [], overlaps: [], gaps: [] } as AudienceMap,
  [concept],
  comps,
);

describe("live regressions: sensitive angles", () => {
  it("never uses a sensitive taste tag as creative-angle evidence", () => {
    expect(isCreativeTag("urn:tag:keyword:media:lesbian", "lesbian")).toBe(false);
    expect(isCreativeTag("urn:tag:keyword:media:friend", "friend")).toBe(true);
  });
  it("rejects the album run's recommended angle", () => {
    const r = validateCited({ text: "Lead the creative around 'friend' and 'lesbian'.", factIds: [dread.id] }, ctx);
    expect(r.ok).toBe(false);
  });
});

describe("live regressions: false positives that replaced good prose", () => {
  it.each([
    ["Expand The Tithe's reach through Boston.", [boston.id]],
    ["Connect Glass Summer with the release's dread.", [glass.id]],
    ["Incorporate Victoria's Secret into a limited capsule.", [vs.id]],
    ["Run a Portland-centric launch week.", [portland.id]],
    ["A Fleabag-themed social cut for Brighton.", [brighton.id]],
  ])("keeps %s", (text, ids) => {
    const r = validateCited({ text, factIds: ids }, ctx);
    expect(r.ok ? null : r.issue.reason).toBeNull();
  });
});

describe("live regressions: rule 4 repair instead of drop", () => {
  it("attaches the concept's own market fact when an angle names it but cites only a tag", () => {
    const text = "Lean on dread in Boston, where these fans gather.";
    expect(validateCited({ text, factIds: [dread.id] }, ctx).ok).toBe(false);
    const ids = attachNamed(text, [dread.id], [...concept.markets, ...concept.partners], ctx);
    expect(ids).toContain(boston.id);
    expect(validateCited({ text, factIds: ids }, ctx).ok).toBe(true);
  });
});

describe("live regressions: comparative claims", () => {
  it("does not read audience-size talk as a ranking claim about Boston", () => {
    expect(checkComparativeClaim("Boston leads fan concentration, though this concept risks a smaller niche audience.", ctx)).toBeNull();
  });
  it("still catches a real false ranking", () => {
    expect(checkComparativeClaim("Portland has the highest fan concentration of all markets.", ctx)?.reason).toMatch(/Portland/);
  });
});

describe("live regressions: unsupported interpretation", () => {
  it("rejects genre-interest claims backed only by fan-concentration facts", () => {
    const r = validateCited({ text: "Target urban markets with strong horror interest like Boston.", factIds: [boston.id] }, ctx);
    expect(r.ok ? null : r.issue.reason).toMatch(/genre or theme interest/);
  });
  it("accepts the same idea phrased as where fans concentrate", () => {
    expect(validateCited({ text: "Hereditary's fans concentrate in Boston.", factIds: [boston.id] }, ctx).ok).toBe(true);
  });
});

describe("live regressions: typed checklist", () => {
  it("drops a podcast read aimed at an artist", () => {
    const { tests, dropped } = renderTests([{ type: "podcast_host_read", subjects: ["Mitski"] }], concept);
    expect(tests).toHaveLength(0);
    expect(dropped[0].reason).toMatch(/podcast/);
  });
  it("drops a test naming partners or cities outside the plan", () => {
    const { tests } = renderTests([{ type: "brand_copromo", subjects: ["Tesla"] }, { type: "geo_ab", subjects: ["Edinburgh", "Brighton"] }], concept);
    expect(tests).toHaveLength(0);
  });
  it("renders a valid podcast read from the plan", () => {
    const { tests } = renderTests([{ type: "podcast_host_read", subjects: ["the magnus archives"], why: "Cheap read on fit" }], concept);
    expect(tests[0].text).toMatch(/The Magnus Archives/);
  });
});
