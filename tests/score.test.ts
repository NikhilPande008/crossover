import { describe, expect, it } from "vitest";
import type { Brief, Comp, Concept, Fact } from "@/lib/types";
import { conceptSimilarity, rankMarkets, rankPartners } from "@/lib/score";
import { checkConstraints, partnerExcluded } from "@/lib/validate/constraints";

const comps: Comp[] = [
  { name: "A", entityId: "a", type: "movie" },
  { name: "B", entityId: "b", type: "movie" },
];
let n = 0;
const f = (kind: Fact["kind"], comp: string, name: string, value: number, type = "podcast", detail?: Fact["detail"]): Fact => ({
  id: `F${++n}`,
  kind,
  compIds: [comp],
  subject: { entityId: `id-${name}`, name, type },
  value,
  detail,
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "",
  recorded: false,
  synthetic: true,
});

describe("rankPartners", () => {
  it("averages weighted affinity across comps; missing comps count as zero", () => {
    const facts = [f("affinity", "a", "Shared", 0.8), f("affinity", "b", "Shared", 0.8), f("affinity", "a", "OnlyA", 0.95)];
    const r = rankPartners(facts, comps, "podcast");
    expect(r[0].name).toBe("Shared");
    expect(r[0].score).toBeCloseTo(0.8);
    expect(r[1].score).toBeCloseTo(0.475);
  });
  it("weights a lead comp higher", () => {
    const facts = [f("affinity", "a", "X", 0.9), f("affinity", "b", "Y", 0.9)];
    const r = rankPartners(facts, comps, "podcast", { a: 2, b: 1 });
    expect(r[0].name).toBe("X");
  });
  it("applies the popularity penalty when enabled", () => {
    const facts = [f("affinity", "a", "Popular", 0.9, "podcast", { popularity: 1 }), f("affinity", "a", "Niche", 0.85, "podcast", { popularity: 0 })];
    expect(rankPartners(facts, comps, "podcast", undefined, 0.2)[0].name).toBe("Niche");
  });
});

describe("rankMarkets", () => {
  it("uses per-comp percentiles and averages across comps with location data", () => {
    const facts = [
      f("heatmap", "a", "Houston", 0.9, "city:US"),
      f("heatmap", "a", "Boston", 0.5, "city:US"),
      f("heatmap", "b", "Houston", 0.2, "city:US"),
      f("heatmap", "b", "Boston", 0.7, "city:US"),
    ];
    const r = rankMarkets(facts, comps);
    expect(r.map((m) => m.score)).toEqual([0.5, 0.5]);
    expect(r.every((m) => m.factIds.length === 2)).toBe(true);
  });
});

describe("constraints", () => {
  const brief: Brief = { title: "T", format: "film", comps: ["A", "B"], regions: ["US"], budget: "M", exclusions: ["alcohol"] };
  const cider = f("affinity", "a", "Hollowbrook Cider", 0.8, "brand", { tags: "alcohol" });
  const concept: Concept = {
    id: "C1",
    lever: "partner",
    name: "x",
    leadComps: ["a"],
    markets: [{ name: "London", factIds: [] }],
    partners: [{ name: "Hollowbrook Cider", domain: "brand", factIds: [cider.id] }],
    creativeAngle: { text: "", factIds: [] },
    confidence: "low",
    risks: [],
    hypotheses: [],
  };
  it("matches exclusions through Qloo tags, not just names", () => {
    expect(partnerExcluded("Hollowbrook Cider", [cider.id], new Map([[cider.id, cider]]), ["no alcohol brands"])).toBe("no alcohol brands");
  });
  it("flags exclusions, out-of-region markets and missing pinned markets", () => {
    const v = checkConstraints(concept, brief, [cider], { excludedPartners: [], pinnedMarkets: ["Houston"] });
    expect(v.map((x) => x.kind).sort()).toEqual(["exclusion", "pinned", "region"]);
  });
  it("detects near-duplicate concepts", () => {
    expect(conceptSimilarity(concept, { ...concept, id: "C2" })).toBe(1);
  });
});
