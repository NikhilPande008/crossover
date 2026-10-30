import { describe, expect, it } from "vitest";
import { groupFromLabel, parseCompare } from "@/lib/qloo/compare";
import { buildOverlap, compareGroup } from "@/lib/score";
import type { Fact } from "@/lib/types";

describe("groupFromLabel", () => {
  it("maps common label spellings", () => {
    expect(groupFromLabel("Common")).toBe("shared");
    expect(groupFromLabel("unique_to_a")).toBe("a");
    expect(groupFromLabel("UniqueToB")).toBe("b");
    expect(groupFromLabel("groupA")).toBe("a");
    expect(groupFromLabel("tags")).toBeUndefined();
  });
});

describe("parseCompare", () => {
  it("reads labelled group arrays", () => {
    const items = parseCompare([
      { type: "common", tags: [{ tag_id: "t1", name: "dread", query: { affinity: 0.8 } }] },
      { type: "unique_to_a", tags: [{ tag_id: "t2", name: "grief", affinity: 0.7 }] },
      { type: "unique_to_b", tags: [{ tag_id: "t3", name: "first love" }] },
    ]);
    expect(items.map((i) => [i.name, i.group, i.score])).toEqual([
      ["dread", "shared", 0.8],
      ["grief", "a", 0.7],
      ["first love", "b", undefined],
    ]);
  });
  it("reads keyed group objects", () => {
    const items = parseCompare({ common: [{ name: "x", entity_id: "1" }], unique_to_b: [{ name: "y", entity_id: "2" }] });
    expect(items.map((i) => i.group)).toEqual(["shared", "b"]);
  });
  it("reads per-item a/b scores as a delta", () => {
    const [i] = parseCompare([{ name: "dread", tag_id: "t", query: { a: { affinity: 0.9 }, b: { affinity: 0.4 } } }]);
    expect(i).toMatchObject({ group: "a", delta: 0.5 });
  });
  it("returns nothing for unrecognised shapes instead of guessing", () => {
    expect(parseCompare([{ name: "dread", tag_id: "t", query: { affinity: 0.9 } }])).toEqual([]);
    expect(parseCompare(null)).toEqual([]);
  });
});

describe("live compare shape (2026-10-25)", () => {
  it("treats results.tags as shared and a/b lists as each side, without double counting", () => {
    const both = { "a.signal.interests.entities": [{ entity_id: "A" }], "b.signal.interests.entities": [{ entity_id: "B" }] };
    const items = parseCompare({
      tags: [{ tag_id: "t1", name: "Drama", type: "urn:tag", entity_id: "x", query: { score: 0.73, ...both } }],
      a: [
        { tag_id: "t2", name: "Grief", entity_id: "x", query: { count: "1" } },
        { tag_id: "t1", name: "Drama", entity_id: "x", query: { count: "1" } },
      ],
      b: [{ tag_id: "t3", name: "Comedy", entity_id: "x", query: { count: "1" } }],
      matchEntities: [],
    });
    expect(items.map((i) => [i.name, i.group, i.score])).toEqual([
      ["Drama", "shared", 0.73],
      ["Grief", "a", undefined],
      ["Comedy", "b", undefined],
    ]);
  });
});

describe("buildOverlap", () => {
  const fact = (id: string, kind: Fact["kind"], comps: string[], name: string, value: number, detail?: Fact["detail"]): Fact => ({
    id,
    kind,
    compIds: comps,
    subject: { entityId: `e-${name}`, name },
    value,
    detail,
    request: { path: "/v2/insights", params: {} },
    retrievedAt: "",
    recorded: false,
    synthetic: false,
  });
  it("scores audience overlap from per-comp affinities and takes themes from compare", () => {
    const facts = [
      fact("F1", "affinity", ["a"], "Podcast X", 0.95),
      fact("F2", "affinity", ["b"], "Podcast X", 0.93),
      fact("F3", "affinity", ["a"], "Artist Y", 0.92),
      fact("F4", "affinity", ["b"], "Brand Z", 0.91),
      fact("F5", "compare", ["a", "b"], "Drama", 0.73, { group: "shared" }),
      fact("F6", "compare", ["a", "b"], "Grief", 1, { group: "a" }),
    ];
    const o = buildOverlap(facts, "a", "b");
    expect(o).toMatchObject({ score: 0.333, basis: "audience-affinities", compared: 3, sharedAudience: ["Podcast X"], shared: ["Drama"], onlyA: ["Grief"], onlyB: [], source: "compare-endpoint" });
    expect(o.factIds).toEqual(expect.arrayContaining(["F1", "F2", "F5"]));
  });
  it("falls back to tags when there are no per-comp affinities", () => {
    const facts = [fact("T1", "tag", ["a"], "dread", 0.99), fact("T2", "tag", ["b"], "dread", 0.99), fact("T3", "tag", ["a"], "grief", 0.99)];
    expect(buildOverlap(facts, "a", "b")).toMatchObject({ basis: "taste-tags", score: 0.5, shared: ["dread"], onlyA: ["grief"], source: "estimated-from-tags" });
  });
  it("decides one audience or two from the compare theme share, in either pair order", () => {
    const themes = (shared: number, onlyA: number, onlyB: number, order: string[]) => [
      ...Array.from({ length: shared }, (_, i) => fact(`S${i}`, "compare", order, `s${i}`, 1, { group: "shared" })),
      ...Array.from({ length: onlyA }, (_, i) => fact(`A${i}`, "compare", order, `a${i}`, 1, { group: "a" })),
      ...Array.from({ length: onlyB }, (_, i) => fact(`B${i}`, "compare", order, `b${i}`, 1, { group: "b" })),
    ];
    // Live shapes: Hereditary/The Witch 10 of 60 themes shared; Hereditary/Lady Bird 2 of 63.
    expect(buildOverlap(themes(10, 27, 23, ["a", "b"]), "a", "b")).toMatchObject({ themeShare: 0.167, themesCompared: 60, similar: true });
    expect(buildOverlap(themes(2, 30, 31, ["a", "b"]), "a", "b")).toMatchObject({ themeShare: 0.032, similar: false });
    const flipped = buildOverlap(themes(10, 27, 3, ["b", "a"]), "a", "b");
    expect(flipped).toMatchObject({ similar: true, onlyA: ["b0", "b1", "b2"] });
  });
  it("still classifies explicit groups", () => {
    expect(compareGroup(fact("F", "compare", ["a", "b"], "x", 1, { group: "b" }))).toBe("b");
  });
});
