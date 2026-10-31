// Pure, deterministic scoring over facts. No LLM involvement.

import type { AudienceMap, Comp, Concept, Confidence, Domain, Fact, Overlap, RankedMarket, RankedPartner } from "@/lib/types";
import { THRESHOLDS } from "@/lib/thresholds";
import { CITIES } from "@/lib/geo/cities";

export const DOMAINS: Domain[] = ["podcast", "artist", "tv_show", "movie", "book", "brand"];

export type Weights = Record<string, number>;

function weightOf(weights: Weights | undefined, compId: string) {
  return weights?.[compId] ?? 1;
}

/**
 * Comps a fact is evidence for. Per-comp top results count for their comp; a combined-signal
 * recovery fact counts for every comp in its signal. Pool scoring (detail.scored) and genre-pool
 * facts are not per-comp evidence: they feed the combined and lift scores instead.
 */
function attributions(f: Fact): string[] {
  if (f.detail?.scored || f.detail?.source === "genre") return [];
  return f.compIds;
}

const isScored = (f: Fact) => f.kind === "affinity" && Boolean(f.detail?.scored);

export function rankPartners(facts: Fact[], comps: Comp[], domain: Domain, weights?: Weights, lambda = THRESHOLDS.popularityLambda): RankedPartner[] {
  type Row = RankedPartner & { pop: number; fromComp: boolean; fromGenre: boolean };
  const byKey = new Map<string, Row>();
  const keyOf = (f: Fact) => f.subject!.entityId ?? f.subject!.name;
  for (const f of facts) {
    if ((f.kind !== "affinity" && f.kind !== "baseline") || f.subject?.type !== domain || typeof f.value !== "number") continue;
    const key = keyOf(f);
    const row =
      byKey.get(key) ??
      ({ entityId: f.subject.entityId, name: f.subject.name, domain, score: 0, perComp: {}, factIds: [], pop: Number(f.detail?.popularity ?? 0), fromComp: false, fromGenre: false } as Row);
    if (f.kind === "baseline") row.baseline = f.value;
    else if (isScored(f)) row.combined = f.value;
    else if (f.detail?.source === "genre") row.fromGenre = true;
    else row.fromComp = true;
    for (const c of attributions(f)) row.perComp[c] = Math.max(row.perComp[c] ?? 0, f.value);
    // Baseline facts explain the lift; they are evidence too, so the drawer shows both requests.
    row.factIds.push(f.id);
    byKey.set(key, row);
  }
  const W = comps.reduce((s, c) => s + weightOf(weights, c.entityId), 0) || 1;
  const out = [...byKey.values()]
    // A row with only a baseline or only a genre-signal value says nothing about these comps.
    .filter((r) => r.fromComp || r.combined !== undefined)
    .map(({ pop, fromComp, fromGenre, ...r }) => {
      const mean = comps.reduce((s, c) => s + weightOf(weights, c.entityId) * (r.perComp[c.entityId] ?? 0), 0) / W;
      const lift = r.combined !== undefined && r.baseline !== undefined ? round(r.combined - r.baseline) : undefined;
      const score = r.combined !== undefined ? r.combined + (lift !== undefined ? THRESHOLDS.liftWeight * lift : 0) : mean - lambda * pop;
      return { ...r, lift, score: round(score), source: fromComp ? "comp" : fromGenre ? "genre" : "model" } as RankedPartner;
    });
  return out.sort((a, b) => b.score - a.score);
}

/** Partners with measured lift ≤ 0: these fans like them, but so does everyone. */
export function genericPartners(partners: Record<Domain, RankedPartner[]>): RankedPartner[] {
  return Object.values(partners)
    .flat()
    .filter((p) => p.lift !== undefined && p.lift <= 0)
    .sort((a, b) => (b.combined ?? 0) - (a.combined ?? 0));
}

/** Percentile of each city within each signal's heatmap, per country (heatmap values are normalised per country query). */
function percentiles(fs: Fact[]): Map<string, number> {
  const out = new Map<string, number>();
  const byCountry = new Map<string, Fact[]>();
  for (const f of fs) byCountry.set(String(f.subject?.type), [...(byCountry.get(String(f.subject?.type)) ?? []), f]);
  for (const list of byCountry.values()) {
    const sorted = [...list].sort((a, b) => (a.value as number) - (b.value as number));
    sorted.forEach((f, i) => out.set(f.subject!.name, round(sorted.length > 1 ? i / (sorted.length - 1) : 1)));
  }
  return out;
}

export function rankMarkets(facts: Fact[], comps: Comp[], weights?: Weights): RankedMarket[] {
  const perComp = new Map<string, Fact[]>();
  const baseline: Fact[] = [];
  for (const f of facts) {
    if (f.kind !== "heatmap" || typeof f.value !== "number") continue;
    if (f.detail?.baseline) {
      baseline.push(f);
      continue;
    }
    const c = f.compIds[0];
    if (c) perComp.set(c, [...(perComp.get(c) ?? []), f]);
  }
  const basePct = percentiles(baseline);
  const rows = new Map<string, RankedMarket>();
  for (const [compId, fs] of perComp) {
    const pct = percentiles(fs);
    for (const f of fs) {
      const name = f.subject!.name;
      const city = CITIES.find((c) => c.name === name);
      const row = rows.get(name) ?? { name, country: city?.country ?? "", score: 0, perComp: {}, factIds: [], population: city?.pop };
      row.perComp[compId] = pct.get(name) ?? 0;
      row.factIds.push(f.id);
      rows.set(name, row);
    }
  }
  for (const f of baseline) rows.get(f.subject!.name)?.factIds.push(f.id);
  const withData = comps.filter((c) => perComp.has(c.entityId));
  const W = withData.reduce((s, c) => s + weightOf(weights, c.entityId), 0) || 1;
  return [...rows.values()]
    .map((r) => {
      const concentration = round(withData.reduce((s, c) => s + weightOf(weights, c.entityId) * (r.perComp[c.entityId] ?? 0), 0) / W);
      const b = basePct.get(r.name);
      const overIndex = b !== undefined ? round(concentration - b) : undefined;
      const broad = b !== undefined && withData.length >= 2 && withData.every((c) => (r.perComp[c.entityId] ?? 0) - b >= THRESHOLDS.broadOverIndex);
      const score = round(concentration + (overIndex !== undefined ? THRESHOLDS.marketLiftWeight * overIndex : 0));
      return { ...r, concentration, overIndex, broad, score };
    })
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

function crossValue(facts: Fact[], inAudienceOf: string | null, target: string): number | undefined {
  const f = facts.find(
    (x) => x.kind === "cross" && x.subject?.entityId === target && (inAudienceOf ? x.compIds[0] === inAudienceOf && !x.detail?.baseline : Boolean(x.detail?.baseline)),
  );
  return typeof f?.value === "number" ? f.value : undefined;
}

function crossFacts(facts: Fact[], a: string, b: string) {
  return facts.filter((x) => x.kind === "cross" && ((x.compIds[0] === a && x.subject?.entityId === b) || (x.compIds[0] === b && x.subject?.entityId === a) || (x.detail?.baseline && (x.subject?.entityId === a || x.subject?.entityId === b))));
}

function rankIn(facts: Fact[], audienceOf: string, target: string): number | undefined {
  const f = facts.find((x) => x.kind === "similar" && x.compIds[0] === audienceOf && x.subject?.entityId === target);
  return f ? Number(f.detail?.rank) : undefined;
}

/**
 * One audience or two? Each comp is scored inside the other comp's audience and inside a
 * reference audience (Qloo filter.results.entities); lift = the difference. The verdict uses the
 * smaller lift: one audience (bridge them), adjacent, or different (pick a lead). Control titles
 * scored the same way show what "no shared audience" looks like. Without cross facts (older or
 * synthetic runs) the verdict falls back to the share of themes the titles have in common.
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

  const bInA = crossValue(facts, a, b);
  const aInB = crossValue(facts, b, a);
  const baseA = crossValue(facts, null, a);
  const baseB = crossValue(facts, null, b);
  const liftBinA = bInA !== undefined && baseB !== undefined ? round(bInA - baseB) : undefined;
  const liftAinB = aInB !== undefined && baseA !== undefined ? round(aInB - baseA) : undefined;
  const mutualLift = liftBinA !== undefined && liftAinB !== undefined ? Math.min(liftBinA, liftAinB) : undefined;
  const verdict: Overlap["verdict"] =
    mutualLift !== undefined
      ? mutualLift >= THRESHOLDS.oneAudienceLift
        ? "one"
        : mutualLift >= THRESHOLDS.adjacentLift
          ? "adjacent"
          : "different"
      : themesCompared > 0 && themeShare >= THRESHOLDS.sharedThemes
        ? "one"
        : "different";
  const controlIds = [...new Set(facts.filter((x) => x.kind === "cross" && x.detail?.control).map((x) => x.subject!.entityId!))];
  const controls = controlIds.map((id) => {
    const base = crossValue(facts, null, id);
    const inA = crossValue(facts, a, id);
    const inB = crossValue(facts, b, id);
    return {
      name: facts.find((x) => x.subject?.entityId === id)!.subject!.name,
      liftInA: inA !== undefined && base !== undefined ? round(inA - base) : undefined,
      liftInB: inB !== undefined && base !== undefined ? round(inB - base) : undefined,
    };
  });
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
    similar: verdict === "one",
    verdict,
    liftBinA,
    liftAinB,
    mutualLift,
    rankBinA: rankIn(facts, a, b),
    rankAinB: rankIn(facts, b, a),
    controls,
    factIds: [...crossFacts(facts, a, b).map((f) => f.id), ...sharedKeys.flatMap((k) => [A.get(k)!.id, B.get(k)!.id]), ...(themes?.factIds.slice(0, 6) ?? [])],
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
  const all = Object.fromEntries(DOMAINS.map((d) => [d, rankPartners(facts, comps, d, weights)])) as Record<Domain, RankedPartner[]>;
  const generic = genericPartners(all);
  // Generic partners are kept out of the plan and listed separately with their numbers.
  const partners = Object.fromEntries(DOMAINS.map((d) => [d, all[d].filter((p) => p.lift === undefined || p.lift > 0)])) as Record<Domain, RankedPartner[]>;
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
    generic,
    ...(weights && Object.values(weights).some((w) => w !== 1) ? { weights } : {}),
  };
}

/**
 * Deterministic confidence: never judged by the LLM. Agreement and strength count only
 * per-comp facts: a combined-signal fact (several comps in one request) says nothing about
 * whether the comps agree, so it can make an item "moderate" but never "agreeing" or "strong".
 */
export function conceptConfidence(concept: Pick<Concept, "partners" | "markets">, facts: Fact[], comps: Comp[], usedFallback: boolean): Confidence {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const items = [...concept.partners, ...concept.markets];
  if (!items.length) return "low";
  let strongSpecific = 0;
  let agreeing = 0;
  let moderate = 0;
  for (const it of items) {
    const fs = it.factIds.map((id) => byId.get(id)).filter((f): f is Fact => !!f);
    const above = fs.filter((f) => (f.value as number) >= THRESHOLDS.affinityFloor);
    const single = above.filter((f) => f.compIds.length === 1);
    const agreeingComps = new Set(single.map((f) => f.compIds[0]));
    const maxAff = Math.max(0, ...fs.filter((f) => f.kind !== "heatmap" && f.compIds.length === 1).map((f) => f.value as number));
    // Distinctive: these comps' fans like it clearly more than the reference audience does.
    const scored = fs.find((f) => f.kind === "affinity" && f.detail?.scored);
    const base = fs.find((f) => f.kind === "baseline" || (f.kind === "heatmap" && f.detail?.baseline));
    const distinct = scored && base && f2n(scored.value) - f2n(base.value) >= THRESHOLDS.distinctLift;
    if (agreeingComps.size >= Math.min(3, comps.length) && comps.length >= 2) agreeing++;
    if (maxAff >= THRESHOLDS.strongAffinity || distinct) strongSpecific++;
    if (above.length >= 1) moderate++;
  }
  const n = items.length;
  if (usedFallback && moderate / n < 0.8) return "low";
  if (agreeing / n >= 0.6 || strongSpecific / n >= 0.5) return "high";
  if (moderate / n >= 0.6) return "medium";
  return "low";
}

const f2n = (v: number | string) => (typeof v === "number" ? v : Number(v));

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
