// Evidence coverage: what code fetches itself, in parallel, before the model makes any
// decision. Each gap maps to one deterministic call; gaps that depend on others (lift
// scoring needs the candidate pool) appear only once their inputs exist.

import type { Brief, Comp, Domain, EntityType, Fact } from "@/lib/types";
import { THRESHOLDS } from "@/lib/thresholds";
import { REGIONS } from "@/lib/geo/cities";
import type { Reference } from "@/lib/qloo/baselines";
import { alias, poolGenres, unscored, type ToolContext } from "./tools";

export type Gap =
  | { kind: "domain-thin"; domain: Domain; count: number }
  | { kind: "missing-affinities"; compId: string; domain: Domain }
  | { kind: "missing-tags"; compId: string }
  | { kind: "missing-markets"; compId: string; region: string }
  | { kind: "missing-baseline-markets"; region: string }
  | { kind: "missing-demographics"; compId: string }
  | { kind: "missing-similar"; compId: string }
  | { kind: "missing-cross"; compId: string; targets: Target[] }
  | { kind: "missing-cross-baseline"; targets: Target[] }
  | { kind: "missing-genre-pool"; domain: Domain; tags: string[] }
  | { kind: "missing-lift"; domain: Domain; count: number };

type Target = { entityId: string; name: string; type: EntityType; control?: boolean };

export type PlannedCall = { tool: string; input: Record<string, unknown> };

export function partnerDomains(brief: Brief): Domain[] {
  const screen: Domain = brief.format === "series" ? "movie" : "tv_show";
  return ["podcast", "artist", screen, "brand"];
}

/** Calls already attempted, even if they returned nothing. */
export type Attempted = Set<string>;
export const attemptKey = (tool: string, input: Record<string, unknown>) =>
  `${tool}:${JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k]) => k !== "reason").sort()))}`;

const has = (facts: Fact[], pred: (f: Fact) => boolean) => facts.some(pred);

export function assessEvidence(
  facts: Fact[],
  comps: Comp[],
  brief: Brief,
  attempted: Attempted,
  extra: { ref: Reference; proposals: ToolContext["proposals"]; store: ToolContext["store"] } = { ref: { audience: [], controls: [] }, proposals: new Map(), store: undefined as never },
): Gap[] {
  const gaps: Gap[] = [];
  const idOf = (c: Comp) => alias(comps.indexOf(c));
  const tried = (tool: string, input: Record<string, unknown>) => attempted.has(attemptKey(tool, input));
  const domains = partnerDomains(brief);
  for (const d of domains) {
    for (const c of comps) {
      const done = tried("audience_affinities", { comps: [idOf(c)], domain: d });
      if (!done && !has(facts, (f) => f.kind === "affinity" && f.subject?.type === d && f.compIds.length === 1 && f.compIds[0] === c.entityId)) gaps.push({ kind: "missing-affinities", compId: c.entityId, domain: d });
    }
    const strong = facts.filter((f) => f.kind === "affinity" && f.subject?.type === d && f.compIds.length > 0 && (f.value as number) >= THRESHOLDS.affinityFloor);
    const unique = new Set(strong.map((f) => f.subject!.name)).size;
    if (unique < THRESHOLDS.minItemsPerDomain) gaps.push({ kind: "domain-thin", domain: d, count: unique });
    const genres = poolGenres(comps);
    if (genres.length && !tried("genre_pool", { domain: d, tags: genres })) gaps.push({ kind: "missing-genre-pool", domain: d, tags: genres });
  }
  for (const c of comps) {
    if (!tried("tags", { comps: [idOf(c)] }) && !has(facts, (f) => f.kind === "tag" && f.compIds.length === 1 && f.compIds[0] === c.entityId)) gaps.push({ kind: "missing-tags", compId: c.entityId });
    for (const region of brief.regions) {
      const done = tried("fan_markets", { comp: idOf(c), region });
      const got = has(facts, (f) => f.kind === "heatmap" && f.compIds[0] === c.entityId && f.request.params["filter.location.query"] === REGIONS[region]?.locationQuery);
      if (!done && !got) gaps.push({ kind: "missing-markets", compId: c.entityId, region });
    }
    if (!tried("demographics", { comp: idOf(c) }) && !has(facts, (f) => f.kind === "demographic" && f.compIds[0] === c.entityId)) gaps.push({ kind: "missing-demographics", compId: c.entityId });
    if (!tried("similar", { comp: idOf(c) }) && !has(facts, (f) => f.kind === "similar" && f.compIds[0] === c.entityId && !f.detail?.via)) gaps.push({ kind: "missing-similar", compId: c.entityId });
  }
  if (extra.ref.audience.length) {
    for (const region of brief.regions) {
      const got = has(facts, (f) => f.kind === "heatmap" && Boolean(f.detail?.baseline) && f.request.params["filter.location.query"] === REGIONS[region]?.locationQuery);
      if (!got && !tried("baseline_markets", { region })) gaps.push({ kind: "missing-baseline-markets", region });
    }
  }
  // One audience or two: every comp (and each control) scored inside every other comp's audience, and inside the reference audience.
  if (comps.length >= 2) {
    const all: Target[] = [...comps.map((c) => ({ entityId: c.entityId, name: c.name, type: c.type })), ...extra.ref.controls.map((r) => ({ ...r, control: true }))];
    for (const c of comps) {
      const targets = all.filter((t) => t.entityId !== c.entityId && !has(facts, (f) => f.kind === "cross" && f.compIds[0] === c.entityId && f.subject?.entityId === t.entityId));
      if (targets.length && !tried("cross", { comp: idOf(c), targets })) gaps.push({ kind: "missing-cross", compId: c.entityId, targets });
    }
    if (extra.ref.audience.length) {
      const targets = all.filter((t) => !has(facts, (f) => f.kind === "cross" && Boolean(f.detail?.baseline) && f.subject?.entityId === t.entityId));
      if (targets.length && !tried("cross", { targets })) gaps.push({ kind: "missing-cross-baseline", targets });
    }
  }
  // Lift scoring waits for the domain's candidate pool (per-comp lists and the genre pool).
  if (extra.store) {
    for (const d of domains) {
      const poolPending = gaps.some((g) => (g.kind === "missing-affinities" || g.kind === "missing-genre-pool") && g.domain === d);
      if (poolPending) continue;
      const todo = unscored(extra.store, comps, d, extra.proposals);
      const n = Math.max(todo.comps.length, extra.ref.audience.length ? todo.baseline.length : 0);
      if (n && !tried("score_pool", { domain: d, n, ids: todo.comps.map((t) => t.entityId).join(",") })) gaps.push({ kind: "missing-lift", domain: d, count: n });
    }
  }
  // A domain is only "thin" once every comp has been tried in it.
  return gaps.filter((g) => g.kind !== "domain-thin" || !gaps.some((x) => x.kind === "missing-affinities" && x.domain === g.domain));
}

/** The deterministic call for each gap. */
export function gapToCall(g: Gap, comps: Comp[], store?: ToolContext["store"], proposals?: ToolContext["proposals"]): PlannedCall {
  const a = (id: string) => alias(comps.findIndex((c) => c.entityId === id));
  switch (g.kind) {
    case "missing-affinities":
      return { tool: "audience_affinities", input: { comps: [a(g.compId)], domain: g.domain, reason: "Coverage: per-comp affinities" } };
    case "domain-thin":
      return { tool: "audience_affinities", input: { comps: comps.map((c) => a(c.entityId)), domain: g.domain, reason: `Only ${g.count} strong ${g.domain} results per comp; combining comps into one signal` } };
    case "missing-tags":
      return { tool: "tags", input: { comps: [a(g.compId)], reason: "Coverage: taste tags" } };
    case "missing-markets":
      return { tool: "fan_markets", input: { comp: a(g.compId), region: g.region, reason: "Coverage: fan markets" } };
    case "missing-baseline-markets":
      return { tool: "baseline_markets", input: { region: g.region, reason: "Reference audience's markets, to measure over-index" } };
    case "missing-demographics":
      return { tool: "demographics", input: { comp: a(g.compId), reason: "Coverage: audience skew" } };
    case "missing-similar":
      return { tool: "similar", input: { comp: a(g.compId), reason: "Titles this comp's fans love: comp discovery" } };
    case "missing-cross":
      return { tool: "cross", input: { comp: a(g.compId), targets: g.targets, reason: "One audience or two: the other comps and controls inside this comp's audience" } };
    case "missing-cross-baseline":
      return { tool: "cross", input: { targets: g.targets, reason: "One audience or two: the comps and controls inside a typical audience" } };
    case "missing-genre-pool":
      return { tool: "genre_pool", input: { domain: g.domain, tags: g.tags, reason: "Candidates from the comps' genre, so specific partners are in the pool" } };
    case "missing-lift": {
      const todo = store && proposals ? unscored(store, comps, g.domain, proposals) : { comps: [] };
      return { tool: "score_pool", input: { domain: g.domain, n: g.count, ids: todo.comps.map((t) => t.entityId).join(","), reason: "Lift: candidates scored for the comps and for a typical audience" } };
    }
  }
}

export function describeGap(g: Gap, comps: Comp[]): string {
  const n = (id: string) => comps.find((c) => c.entityId === id)?.name ?? id;
  switch (g.kind) {
    case "domain-thin":
      return `${g.domain}: only ${g.count} results above the affinity floor`;
    case "missing-affinities":
      return `${g.domain} affinities not yet fetched for ${n(g.compId)}`;
    case "missing-tags":
      return `taste tags missing for ${n(g.compId)}`;
    case "missing-markets":
      return `fan markets missing for ${n(g.compId)} in ${g.region}`;
    case "missing-baseline-markets":
      return `reference markets missing in ${g.region}`;
    case "missing-demographics":
      return `demographics missing for ${n(g.compId)}`;
    case "missing-similar":
      return `similar titles missing for ${n(g.compId)}`;
    case "missing-cross":
      return `cross-affinity missing inside ${n(g.compId)}'s audience`;
    case "missing-cross-baseline":
      return `cross-affinity missing for the reference audience`;
    case "missing-genre-pool":
      return `${g.domain} genre candidates not fetched`;
    case "missing-lift":
      return `${g.count} ${g.domain} candidates not yet scored for lift`;
  }
}
