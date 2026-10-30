// Pure, deterministic scoring over facts. No LLM involvement.

import type { AudienceMap, Comp, Concept, Confidence, Domain, Fact, Overlap, RankedMarket, RankedPartner } from "@/lib/types";
import { THRESHOLDS } from "@/lib/thresholds";
import { CITIES } from "@/lib/geo/cities";

export const DOMAINS: Domain[] = ["podcast", "artist", "tv_show", "movie", "book", "brand"];

export type Weights = Record<string, number>;

function weightOf(weights: Weights | undefined, compId: string) {
  return weights?.[compId] ?? 1;
}

/** Per-comp facts are those with exactly one comp; combined-signal facts are attributed to every comp in the signal. */
function attributions(f: Fact): string[] {
  return f.compIds;
}

export function rankPartners(facts: Fact[], comps: Comp[], domain: Domain, weights?: Weights, lambda = THRESHOLDS.popularityLambda): RankedPartner[] {
  const byKey = new Map<string, RankedPartner & { pop: number }>();
  for (const f of facts) {
    if (f.kind !== "affinity" || f.subject?.type !== domain || typeof f.value !== "number") continue;
    const key = f.subject.entityId ?? f.subject.name;
    const row =
      byKey.get(key) ??
      ({ entityId: f.subject.entityId, name: f.subject.name, domain, score: 0, perComp: {}, factIds: [], pop: Number(f.detail?.popularity ?? 0) } as RankedPartner & { pop: number });
    for (const c of attributions(f)) row.perComp[c] = Math.max(row.perComp[c] ?? 0, f.value);
    row.factIds.push(f.id);
    byKey.set(key, row);
  }
  const C = comps.length || 1;
  const out = [...byKey.values()].map(({ pop, ...r }) => {
    const sum = comps.reduce((s, c) => s + weightOf(weights, c.entityId) * (r.perComp[c.entityId] ?? 0), 0);
    return { ...r, score: round(sum / C - lambda * pop) };
  });
  return out.sort((a, b) => b.score - a.score);
}

export function rankMarkets(facts: Fact[], comps: Comp[], weights?: Weights): RankedMarket[] {
  // Percentile of each city within each comp's heatmap, then weighted mean across comps with heatmap data.
  const perComp = new Map<string, Fact[]>();
  for (const f of facts) {
    if (f.kind !== "heatmap" || typeof f.value !== "number") continue;
    const c = f.compIds[0];
    perComp.set(c, [...(perComp.get(c) ?? []), f]);
  }
  const rows = new Map<string, RankedMarket>();
  for (const [compId, fs] of perComp) {
    const sorted = [...fs].sort((a, b) => (a.value as number) - (b.value as number));
    sorted.forEach((f, i) => {
      const name = f.subject!.name;
      const country = CITIES.find((c) => c.name === name)?.country ?? "";
      const row = rows.get(name) ?? { name, country, score: 0, perComp: {}, factIds: [] };
      row.perComp[compId] = round(sorted.length > 1 ? i / (sorted.length - 1) : 1);
      row.factIds.push(f.id);
      rows.set(name, row);
    });
  }
  const withData = comps.filter((c) => perComp.has(c.entityId));
  const W = withData.reduce((s, c) => s + weightOf(weights, c.entityId), 0) || 1;
  return [...rows.values()]
    .map((r) => ({ ...r, score: round(withData.reduce((s, c) => s + weightOf(weights, c.entityId) * (r.perComp[c.entityId] ?? 0), 0) / W) }))
    .sort((a, b) => b.score - a.score);
}

export function rankTags(facts: Fact[], comps: Comp[]) {
  const rows = new Map<string, { name: string; score: number; perComp: Record<string, number>; factIds: string[] }>();
  for (const f of facts) {
    if (f.kind !== "tag" || typeof f.value !== "number") continue;
    const name = f.subject!.name;
    const row = rows.get(name) ?? { name, score: 0, perComp: {}, factIds: [] };
    for (const c of f.compIds) row.perComp[c] = Math.max(row.perComp[c] ?? 0, f.value);
    row.factIds.push(f.id);
    rows.set(name, row);
  }
  const C = comps.length || 1;
  return [...rows.values()]
    .map((r) => ({ ...r, score: round(comps.reduce((s, c) => s + (r.perComp[c.entityId] ?? 0), 0) / C) }))
    .sort((a, b) => b.score - a.score);
}

/** Which side a compare fact belongs to: an explicit group from Qloo, else from the a − b delta. */
export function compareGroup(f: Fact): "shared" | "a" | "b" {
  const g = f.detail?.group;
  if (g === "shared" || g === "a" || g === "b") {
    if (typeof f.detail?.a === "number" && typeof f.detail?.b === "number") {
      const d = (f.detail.a as number) - (f.detail.b as number);
      return Math.abs(d) < THRESHOLDS.sharedTagDelta ? "shared" : d > 0 ? "a" : "b";
    }
    return g;
  }
  const v = f.value as number;
  return Math.abs(v) < THRESHOLDS.sharedTagDelta ? "shared" : v > 0 ? "a" : "b";
}

/**
 * Shared vs. divergent themes from /v2/analysis/compare. Live shape (2026-10-25):
 * results.tags = top shared tags with a score; results.a / results.b = each side's tags.
 * This compares the titles' characteristics, not their audiences, so it feeds the themes
 * shown to the user and the creative angle, not the overlap score.
 */
function themesFromCompare(facts: Fact[], a: string, b: string) {
  let fs = facts.filter((f) => f.kind === "compare" && f.compIds[0] === a && f.compIds[1] === b);
  // The pair may have been compared the other way round; then Qloo's "a" side is our b.
  const flipped = !fs.length;
  if (flipped) fs = facts.filter((f) => f.kind === "compare" && f.compIds[0] === b && f.compIds[1] === a);
  if (!fs.length) return null;
  const strength = (f: Fact) => (typeof f.value === "number" ? Math.abs(f.value) : 0);
  const pick = (g: "shared" | "a" | "b") => fs.filter((f) => compareGroup(f) === g).sort((x, y) => strength(y) - strength(x));
  return { shared: pick("shared"), onlyA: pick(flipped ? "b" : "a"), onlyB: pick(flipped ? "a" : "b"), factIds: fs.map((f) => f.id) };
}

function perComp(facts: Fact[], c: string, kinds: Fact["kind"][]) {
  const fs = facts.filter((f) => kinds.includes(f.kind) && f.compIds.length === 1 && f.compIds[0] === c && (f.value as number) >= THRESHOLDS.affinityFloor);
  return new Map(fs.map((f) => [f.subject!.entityId ?? f.subject!.name, f]));
}

/**
 * One audience or two? The verdict (`similar`) comes from the share of themes the two
 * titles have in common: Qloo's compare endpoint when available, else each comp's own
 * taste tags. `score` is the Jaccard overlap of the comps' own top audience affinities
 * (falling back to tags); it is shown for context but is low for every pair seen live.
 */
export function buildOverlap(facts: Fact[], a: string, b: string): Overlap {
  let A = perComp(facts, a, ["affinity"]);
  let B = perComp(facts, b, ["affinity"]);
  let basis: Overlap["basis"] = "audience-affinities";
  if (!A.size || !B.size) {
    A = perComp(facts, a, ["tag"]);
    B = perComp(facts, b, ["tag"]);
    basis = "taste-tags";
  }
  const sharedKeys = [...A.keys()].filter((k) => B.has(k));
  const union = new Set([...A.keys(), ...B.keys()]);
  const themes = themesFromCompare(facts, a, b);
  const name = (f: Fact) => f.subject!.name;
  const uniq = (xs: string[]) => [...new Set(xs)];
  const tagsA = perComp(facts, a, ["tag"]);
  const tagsB = perComp(facts, b, ["tag"]);
  // The verdict rests on themes: compare's shared vs one-sided tags, else the per-comp tag lists.
  let themeShared: number;
  let themesCompared: number;
  if (themes) {
    const sharedNames = new Set(themes.shared.map(name));
    const all = new Set([...sharedNames, ...themes.onlyA.map(name), ...themes.onlyB.map(name)]);
    themeShared = sharedNames.size;
    themesCompared = all.size;
  } else {
    themeShared = [...tagsA.keys()].filter((k) => tagsB.has(k)).length;
    themesCompared = new Set([...tagsA.keys(), ...tagsB.keys()]).size;
  }
  const themeShare = round(themesCompared ? themeShared / themesCompared : 0);
  return {
    a,
    b,
    score: round(union.size ? sharedKeys.length / union.size : 0),
    basis,
    compared: union.size,
    sharedAudience: sharedKeys.map((k) => A.get(k)!.subject!.name).slice(0, 6),
    shared: themes ? uniq(themes.shared.map(name)).slice(0, 6) : uniq([...tagsA.values()].filter((f) => tagsB.has(f.subject!.entityId ?? f.subject!.name)).map(name)).slice(0, 6),
    onlyA: themes ? uniq(themes.onlyA.map(name)).slice(0, 5) : uniq([...tagsA.values()].filter((f) => !tagsB.has(f.subject!.entityId ?? f.subject!.name)).map(name)).slice(0, 5),
    onlyB: themes ? uniq(themes.onlyB.map(name)).slice(0, 5) : uniq([...tagsB.values()].filter((f) => !tagsA.has(f.subject!.entityId ?? f.subject!.name)).map(name)).slice(0, 5),
    source: themes ? "compare-endpoint" : "estimated-from-tags",
    themeShare,
    themesCompared,
    similar: themesCompared > 0 && themeShare >= THRESHOLDS.sharedThemes,
    factIds: [...sharedKeys.flatMap((k) => [A.get(k)!.id, B.get(k)!.id]), ...(themes?.factIds.slice(0, 6) ?? [])],
  };
}

export function demographicSummaries(facts: Fact[], comps: Comp[]) {
  return comps.map((c) => {
    const fs = facts.filter((f) => f.kind === "demographic" && f.compIds[0] === c.entityId);
    return {
      compId: c.entityId,
      summary: fs.length ? fs.map((f) => f.subject!.name).join(", ") : "No Qloo signal",
      factIds: fs.map((f) => f.id),
    };
  });
}

export function buildAudienceMap(facts: Fact[], comps: Comp[], gaps: string[], weights?: Weights): AudienceMap {
  const partners = Object.fromEntries(DOMAINS.map((d) => [d, rankPartners(facts, comps, d, weights)])) as Record<Domain, RankedPartner[]>;
  const overlaps: Overlap[] = [];
  for (let i = 0; i < comps.length; i++)
    for (let j = i + 1; j < comps.length; j++) {
      const a = comps[i].entityId;
      const b = comps[j].entityId;
      overlaps.push(buildOverlap(facts, a, b));
    }
  return {
    partners,
    markets: rankMarkets(facts, comps, weights),
    tags: rankTags(facts, comps),
    demographics: demographicSummaries(facts, comps),
    overlaps,
    gaps,
  };
}

/** Deterministic confidence: never judged by the LLM. */
export function conceptConfidence(concept: Pick<Concept, "partners" | "markets">, facts: Fact[], comps: Comp[], usedFallback: boolean): Confidence {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const items = [...concept.partners, ...concept.markets];
  if (!items.length) return "low";
  let strongSpecific = 0;
  let agreeing = 0;
  let moderate = 0;
  for (const it of items) {
    const fs = it.factIds.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
    const supporting = new Set(fs.filter((f) => (f.value as number) >= THRESHOLDS.affinityFloor).flatMap((f) => f.compIds));
    const maxAff = Math.max(0, ...fs.filter((f) => f.kind !== "heatmap").map((f) => f.value as number));
    if (supporting.size >= Math.min(3, comps.length) && comps.length >= 2) agreeing++;
    if (maxAff >= THRESHOLDS.strongAffinity) strongSpecific++;
    if (supporting.size >= 1) moderate++;
  }
  const n = items.length;
  if (usedFallback && moderate / n < 0.8) return "low";
  if (agreeing / n >= 0.6 || strongSpecific / n >= 0.5) return "high";
  if (moderate / n >= 0.6) return "medium";
  return "low";
}

export function conceptSimilarity(a: Concept, b: Concept): number {
  const setA = new Set([...a.partners.map((p) => "p:" + p.name), ...a.markets.map((m) => "m:" + m.name)]);
  const setB = new Set([...b.partners.map((p) => "p:" + p.name), ...b.markets.map((m) => "m:" + m.name)]);
  const shared = [...setA].filter((x) => setB.has(x)).length;
  const denom = Math.min(setA.size, setB.size) || 1;
  return shared / denom;
}

export function round(n: number, dp = 3) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
