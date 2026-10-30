import { describe, expect, it } from "vitest";
import type { Brief, Comp, Fact } from "@/lib/types";
import { checkEntities, checkNumbers, entityMentions, makeContext, validateCited, validateUncited } from "@/lib/validate/grounding";

const comps: Comp[] = [
  { name: "Hereditary", entityId: "A", type: "movie", year: 2018 },
  { name: "The Witch", entityId: "B", type: "movie", year: 2015 },
];
const brief: Brief = { title: "The Tithe", format: "film", comps: ["Hereditary", "The Witch"], regions: ["US"], budget: "M", exclusions: ["alcohol"] };
const fact = (id: string, name: string, value: number, extra: Partial<Fact> = {}): Fact => ({
  id,
  kind: "affinity",
  compIds: ["A"],
  subject: { name, type: "podcast" },
  value,
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "2026-10-25T00:00:00Z",
  recorded: false,
  synthetic: true,
  ...extra,
});
const facts = [fact("F1", "Static Between Stations", 0.912), fact("F2", "Wren & Ash", 0.74), fact("F3", "Houston", 0.88, { kind: "heatmap", subject: { name: "Houston" } })];
const ctx = makeContext(facts, comps, brief);

describe("numbers", () => {
  it("accepts numbers present in cited facts, including rounded and percent forms", () => {
    expect(checkNumbers("Affinity of 0.91 for the podcast (F1).", ["F1"], ctx)).toBeNull();
    expect(checkNumbers("A 91% affinity (F1).", ["F1"], ctx)).toBeNull();
  });
  it("rejects numbers not in cited facts", () => {
    expect(checkNumbers("Affinity of 0.95 (F1).", ["F1"], ctx)?.reason).toMatch(/0.95/);
    expect(checkNumbers("Reach 3 million fans.", ["F1"], ctx)).not.toBeNull();
  });
  it("ignores fact citation markers themselves", () => {
    expect(checkNumbers("Strong signal (F1, F2).", ["F1"], ctx)).toBeNull();
  });
  it("accepts comp years from the brief context", () => {
    expect(checkNumbers("Fans of the 2018 film.", [], ctx)).toBeNull();
  });
});

describe("entities", () => {
  it("finds capitalised runs and quoted names but not sentence-initial words", () => {
    const m = entityMentions("Leaning into dread works. Fans of “Static Between Stations” also like Wren & Ash.");
    expect(m).toContain("Static Between Stations");
    expect(m).toContain("Wren & Ash");
    expect(m).not.toContain("Leaning");
  });
  it("accepts names from facts, comps, cities and the brief", () => {
    expect(checkEntities("Partner with Static Between Stations in Houston to reach Hereditary fans.", ctx)).toBeNull();
    expect(checkEntities("Position The Tithe like The Witch.", ctx)).toBeNull();
  });
  it("rejects invented partners", () => {
    expect(checkEntities("Sponsor the Last Podcast On The Left for horror fans.", ctx)?.reason).toMatch(/Last Podcast/);
    expect(checkEntities("Partner with Spotify Wrapped.", ctx)).not.toBeNull();
  });
});

describe("validateCited", () => {
  it("requires at least one valid fact id", () => {
    expect(validateCited({ text: "Fans love dread.", factIds: [] }, ctx).ok).toBe(false);
    expect(validateCited({ text: "Fans love dread.", factIds: ["F99"] }, ctx).ok).toBe(false);
    const ok = validateCited({ text: "Static Between Stations is the strongest podcast affinity.", factIds: ["F1", "F99"] }, ctx);
    expect(ok.ok && ok.factIds).toEqual(["F1"]);
  });
  it("blocks sensitive-trait language", () => {
    expect(validateCited({ text: "Target religious viewers.", factIds: ["F1"] }, ctx).ok).toBe(false);
  });
});

describe("validateUncited (hypotheses)", () => {
  it("allows uncited tentative propositions without numbers or new names", () => {
    expect(validateUncited("A podcast-led campaign may reach this audience more cheaply than social video.", ctx)).toBeNull();
  });
  it("rejects hypotheses with invented numbers", () => {
    expect(validateUncited("This could double ROI by 40%.", ctx)).not.toBeNull();
  });
});
