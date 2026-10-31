// Lift scoring (partners, markets) and the cross-affinity verdict, on numbers from the
// 2026-10-31 live probes (horror comps vs Barbie + Endgame fans).

import { beforeEach, describe, expect, it } from "vitest";
import type { Comp, Fact } from "@/lib/types";
import { buildAudienceMap, buildOverlap, rankMarkets, rankPartners } from "@/lib/score";
import { EventLog, allowHit, capLimit, readEvents } from "@/lib/runs";
import { resetKvMemory } from "@/lib/store/kv";

const comps: Comp[] = [
  { name: "Hereditary", entityId: "H", type: "movie" },
  { name: "The Witch", entityId: "W", type: "movie" },
  { name: "Lady Bird", entityId: "L", type: "movie" },
];
let n = 0;
const f = (kind: Fact["kind"], subject: Fact["subject"], value: number, compIds: string[], detail?: Fact["detail"]): Fact => ({
  id: `F${++n}`,
  kind,
  compIds,
  subject,
  value,
  ...(detail ? { detail } : {}),
  request: { path: "/v2/insights", params: {} },
  retrievedAt: "",
  recorded: false,
  synthetic: false,
});
const all = comps.map((c) => c.entityId);

describe("partner lift", () => {
  const p = (id: string, name: string) => ({ entityId: id, name, type: "podcast" });
  const facts = [
    // Tesla: in Hereditary's own top results, but the reference audience likes it more.
    f("affinity", p("t", "Tesla"), 0.923, ["H"]),
    f("affinity", p("t", "Tesla"), 0.923, all, { scored: 1 }),
    f("baseline", p("t", "Tesla"), 0.938, []),
    // The Magnus Archives: from the genre pool, distinctive.
    f("affinity", p("m", "The Magnus Archives"), 0.9, all, { source: "genre" }),
    f("affinity", p("m", "The Magnus Archives"), 0.91, all, { scored: 1 }),
    f("baseline", p("m", "The Magnus Archives"), 0.771, []),
    // A genre-pool item never scored for the comps says nothing about them.
    f("affinity", p("x", "FALLON Jewelry"), 1, all, { source: "genre" }),
  ];

  it("ranks by combined affinity plus lift and drops unscored genre noise", () => {
    const ranked = rankPartners(facts, comps, "podcast");
    expect(ranked.map((r) => r.name)).toEqual(["The Magnus Archives", "Tesla"]);
    expect(ranked[0]).toMatchObject({ lift: 0.139, source: "genre" });
    expect(ranked[1].lift).toBe(-0.015);
  });

  it("keeps generic partners out of the plan and lists them separately", () => {
    const map = buildAudienceMap(facts, comps, []);
    expect(map.partners.podcast.map((r) => r.name)).toEqual(["The Magnus Archives"]);
    expect(map.generic?.map((r) => r.name)).toEqual(["Tesla"]);
  });
});

describe("one audience or two", () => {
  const movie = (id: string, name: string) => ({ entityId: id, name, type: "movie" });
  const facts = [
    f("cross", movie("W", "The Witch"), 0.918, ["H"]),
    f("cross", movie("H", "Hereditary"), 0.9, ["W"]),
    f("cross", movie("W", "The Witch"), 0.708, [], { baseline: 1 }),
    f("cross", movie("H", "Hereditary"), 0.76, [], { baseline: 1 }),
    f("cross", movie("L", "Lady Bird"), 0.852, ["H"]),
    f("cross", movie("H", "Hereditary"), 0.83, ["L"]),
    f("cross", movie("L", "Lady Bird"), 0.792, [], { baseline: 1 }),
    f("cross", movie("P", "Paddington 2"), 0.75, ["H"], { control: 1 }),
    f("cross", movie("P", "Paddington 2"), 0.76, [], { baseline: 1, control: 1 }),
    f("similar", movie("W", "The Witch"), 0.918, ["H"], { rank: 11 }),
  ];

  it("calls Hereditary and The Witch one audience, with rank and controls", () => {
    const o = buildOverlap(facts, "H", "W");
    expect(o).toMatchObject({ verdict: "one", similar: true, liftBinA: 0.21, liftAinB: 0.14, mutualLift: 0.14, rankBinA: 11 });
    expect(o.controls?.[0]).toMatchObject({ name: "Paddington 2", liftInA: -0.01 });
  });

  it("calls Hereditary and Lady Bird adjacent", () => {
    expect(buildOverlap(facts, "H", "L")).toMatchObject({ verdict: "adjacent", mutualLift: 0.06 });
  });

  it("falls back to theme share without cross facts", () => {
    expect(buildOverlap([], "H", "W").verdict).toBe("different");
  });
});

describe("market over-index", () => {
  const city = (name: string, country: string) => ({ name, type: `city:${country}` });
  const heat = (name: string, country: string, compId: string, v: number) => f("heatmap", city(name, country), v, [compId]);
  const base = (name: string, country: string, v: number) => f("heatmap", city(name, country), v, [], { baseline: 1 });
  const facts = [
    // US: Boston high for the comps and for everyone; Portland high only for the comps.
    ...["H", "W"].flatMap((c) => [heat("Boston", "US", c, 0.9), heat("Portland", "US", c, 0.8), heat("Houston", "US", c, 0.1)]),
    base("Boston", "US", 0.95),
    base("Portland", "US", 0.2),
    base("Houston", "US", 0.5),
    // GB values are on their own scale: London's 0.3 is the top of its country.
    ...["H", "W"].flatMap((c) => [heat("London", "GB", c, 0.3), heat("Leeds", "GB", c, 0.05)]),
  ];

  it("ranks cities within their country and scores over-index against the reference audience", () => {
    const ms = rankMarkets(facts, comps.slice(0, 2));
    const by = Object.fromEntries(ms.map((m) => [m.name, m]));
    expect(by.London.concentration).toBe(1);
    expect(by.Portland.overIndex).toBe(0.5);
    expect(by.Boston.overIndex).toBe(0);
    // score = concentration + 0.5 · over-index: Boston keeps the top spot on concentration; its zero over-index shows in the 2×2.
    expect(by.Boston.score).toBe(1);
    expect(by.Portland.score).toBe(0.75);
    expect(by.Boston.population).toBeGreaterThan(1);
  });
});

describe("durable store fallbacks (memory)", () => {
  beforeEach(() => resetKvMemory());

  it("logs events so a stream can resume from an index", async () => {
    const log = new EventLog("run-1");
    log.push({ type: "run", runId: "run-1" });
    log.push({ type: "step", message: "a", calls: 1 });
    log.push({ type: "result", result: { runId: "run-1" } as never });
    await log.flush();
    const events = await readEvents("run-1", 1);
    expect(events).toEqual([{ type: "step", message: "a", calls: 1 }, { type: "done", runId: "run-1" }]);
  });

  it("caps hits per visitor per hour", async () => {
    const limit = capLimit("resolve");
    const now = 3600_000 * 10;
    for (let i = 0; i < limit; i++) expect(await allowHit("resolve", "1.2.3.4", now)).toBe(true);
    expect(await allowHit("resolve", "1.2.3.4", now)).toBe(false);
    expect(await allowHit("resolve", "5.6.7.8", now)).toBe(true);
    expect(await allowHit("resolve", "1.2.3.4", now + 3600_000)).toBe(true);
  });
});
