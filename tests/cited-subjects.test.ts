// Rule 4 of the grounding validator: names in a cited sentence must be about its cited facts.

import { describe, expect, it } from "vitest";
import type { Brief, Comp, Fact } from "@/lib/types";
import { checkCitedSubjects, makeContext, validateCited } from "@/lib/validate/grounding";

const comps: Comp[] = [
  { name: "Hereditary", entityId: "A", type: "movie" },
  { name: "The Witch", entityId: "B", type: "movie" },
];
const brief: Brief = { title: "The Tithe", format: "film", comps: ["Hereditary", "The Witch"], regions: ["US", "GB"], budget: "M", exclusions: [] };

const fact = (id: string, name: string, kind: Fact["kind"] = "affinity", type = "tv_show"): Fact => ({
  id,
  kind,
  compIds: ["A"],
  subject: { entityId: `e-${id}`, name, type },
  value: 0.95,
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "",
  recorded: false,
  synthetic: false,
});

const facts = [
  fact("F41", "Midnight Mass"),
  fact("F43", "Chapelwaite"),
  fact("F50", "The Haunting of Hill House"),
  fact("F51", "The Haunting of Bly Manor"),
  fact("F52", "The Midnight Club"),
  fact("F60", "Criminal", "affinity", "podcast"),
  fact("F70", "Swans", "affinity", "artist"),
  fact("F120", "Edinburgh", "heatmap", "city:GB"),
  fact("F141", "Boston", "heatmap", "city:US"),
  fact("T1", "Drama", "tag", "tag"),
];
const ctx = makeContext(facts, comps, brief);

describe("checkCitedSubjects", () => {
  it("accepts a sentence whose named partners are the subjects of its cited facts", () => {
    expect(checkCitedSubjects("Fans of Midnight Mass and Chapelwaite over-index here.", ["F41", "F43"], ctx)).toBeNull();
  });

  it("rejects the last run's pattern: names shows its cited facts are not about", () => {
    const issue = checkCitedSubjects("Strong affinity for The Haunting of Hill House and The Midnight Club.", ["F41", "F43"], ctx);
    expect(issue?.reason).toMatch(/The Haunting of Hill House/);
  });

  it("rejects a sentence when only some named partners are cited", () => {
    expect(checkCitedSubjects("The Haunting of Hill House and The Midnight Club both rank highly.", ["F50"], ctx)?.reason).toMatch(/The Midnight Club/);
  });

  it("checks cities against the sentence's own heatmap facts", () => {
    expect(checkCitedSubjects("Edinburgh shows strong fan concentration.", ["F120"], ctx)).toBeNull();
    expect(checkCitedSubjects("Edinburgh shows strong fan concentration.", ["F141"], ctx)?.reason).toMatch(/Edinburgh/);
    // A reference city with no heatmap fact in the run still needs a citation about it.
    expect(checkCitedSubjects("Austin is a natural fit.", ["F141"], ctx)?.reason).toMatch(/Austin/);
  });

  it("matches the longest name, not a shorter one inside it", () => {
    expect(checkCitedSubjects("The Haunting of Bly Manor leads the TV list.", ["F51"], ctx)).toBeNull();
  });

  it("exempts comps and the release title", () => {
    expect(checkCitedSubjects("Position The Tithe like Hereditary and The Witch.", ["F41"], ctx)).toBeNull();
  });

  it("treats lower-case use of a name as an ordinary word", () => {
    expect(checkCitedSubjects("A criminal edge suits the swans of the genre.", ["F41"], ctx)).toBeNull();
    expect(checkCitedSubjects("Criminal listeners over-index.", ["F41"], ctx)?.reason).toMatch(/Criminal/);
  });

  it("handles possessives and ignores tags and demographics", () => {
    expect(checkCitedSubjects("Swans' listeners love Drama.", ["F70"], ctx)).toBeNull();
  });

  it("is part of validateCited, after the existing checks", () => {
    const r = validateCited({ text: "The Midnight Club is the strongest TV affinity.", factIds: ["F43"] }, ctx);
    expect(r.ok).toBe(false);
    expect(validateCited({ text: "The Midnight Club is the strongest TV affinity.", factIds: ["F52"] }, ctx).ok).toBe(true);
  });
});
