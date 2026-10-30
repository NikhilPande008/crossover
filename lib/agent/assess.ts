// Evidence sufficiency checks (code thresholds) and the default research plan.

import type { Brief, Comp, Domain, Fact } from "@/lib/types";
import { THRESHOLDS } from "@/lib/thresholds";
import { REGIONS } from "@/lib/geo/cities";

export type Gap =
  | { kind: "domain-thin"; domain: Domain; count: number }
  | { kind: "missing-affinities"; compId: string; domain: Domain }
  | { kind: "missing-tags"; compId: string }
  | { kind: "missing-markets"; compId: string; region: string }
  | { kind: "missing-demographics"; compId: string }
  | { kind: "missing-compare"; a: string; b: string };

export type PlannedCall = { tool: string; input: Record<string, unknown> };

export function partnerDomains(brief: Brief): Domain[] {
  const screen: Domain = brief.format === "series" ? "movie" : "tv_show";
  return ["podcast", "artist", screen, "brand"];
}

function hasFact(facts: Fact[], pred: (f: Fact) => boolean) {
  return facts.some(pred);
}

/** Calls the agent has already attempted, even if they returned nothing. */
export type Attempted = Set<string>;
export const attemptKey = (tool: string, input: Record<string, unknown>) =>
  `${tool}:${JSON.stringify(Object.fromEntries(Object.entries(input).filter(([k]) => k !== "reason").sort()))}`;

export function assessEvidence(facts: Fact[], comps: Comp[], brief: Brief, attempted: Attempted): Gap[] {
  const gaps: Gap[] = [];
  for (const d of partnerDomains(brief)) {
    for (const c of comps) {
      const done = attempted.has(attemptKey("audience_affinities", { comp_ids: [c.entityId], domain: d }));
      if (!done && !hasFact(facts, (f) => f.kind === "affinity" && f.subject?.type === d && f.compIds.includes(c.entityId)))
        gaps.push({ kind: "missing-affinities", compId: c.entityId, domain: d });
    }
    const strong = facts.filter((f) => f.kind === "affinity" && f.subject?.type === d && (f.value as number) >= THRESHOLDS.affinityFloor);
    const unique = new Set(strong.map((f) => f.subject!.name)).size;
    if (unique < THRESHOLDS.minItemsPerDomain) gaps.push({ kind: "domain-thin", domain: d, count: unique });
  }
  for (const c of comps) {
    if (!attempted.has(attemptKey("audience_tags", { comp_ids: [c.entityId] })) && !hasFact(facts, (f) => f.kind === "tag" && f.compIds.includes(c.entityId)))
      gaps.push({ kind: "missing-tags", compId: c.entityId });
    for (const region of brief.regions) {
      const done = attempted.has(attemptKey("fan_markets", { comp_id: c.entityId, region }));
      const has = hasFact(facts, (f) => f.kind === "heatmap" && f.compIds[0] === c.entityId && f.request.params["filter.location.query"] === REGIONS[region]?.locationQuery);
      if (!done && !has) gaps.push({ kind: "missing-markets", compId: c.entityId, region });
    }
    if (!attempted.has(attemptKey("audience_demographics", { comp_id: c.entityId })) && !hasFact(facts, (f) => f.kind === "demographic" && f.compIds[0] === c.entityId))
      gaps.push({ kind: "missing-demographics", compId: c.entityId });
  }
  // Every pair for up to three comps (3 calls); with four, the first comp against each other (3 calls, not 6).
  const pairs = comps.length <= 3 ? comps.flatMap((a, i) => comps.slice(i + 1).map((b) => [a, b] as const)) : comps.slice(1).map((b) => [comps[0], b] as const);
  for (const [a, b] of pairs) {
    const done = (x: Comp, y: Comp) =>
      attempted.has(attemptKey("compare_audiences", { a_id: x.entityId, b_id: y.entityId })) || hasFact(facts, (f) => f.kind === "compare" && f.compIds[0] === x.entityId && f.compIds[1] === y.entityId);
    if (!done(a, b) && !done(b, a)) gaps.push({ kind: "missing-compare", a: a.entityId, b: b.entityId });
  }
  // A domain is only "thin" once every comp has been tried in it.
  return gaps.filter((g) => g.kind !== "domain-thin" || !gaps.some((x) => x.kind === "missing-affinities" && x.domain === g.domain));
}

/** Deterministic recovery for each gap: the code-side version of the recovery menu. */
export function gapToCall(g: Gap, comps: Comp[]): PlannedCall {
  const all = comps.map((c) => c.entityId);
  switch (g.kind) {
    case "missing-affinities":
      return { tool: "audience_affinities", input: { comp_ids: [g.compId], domain: g.domain, reason: "Coverage: per-comp affinities" } };
    case "domain-thin":
      return { tool: "audience_affinities", input: { comp_ids: all, domain: g.domain, reason: `Only ${g.count} strong ${g.domain} results per comp; combining comps into one signal` } };
    case "missing-tags":
      return { tool: "audience_tags", input: { comp_ids: [g.compId], reason: "Coverage: taste tags" } };
    case "missing-markets":
      return { tool: "fan_markets", input: { comp_id: g.compId, region: g.region, reason: "Coverage: fan markets" } };
    case "missing-demographics":
      return { tool: "audience_demographics", input: { comp_id: g.compId, reason: "Coverage: audience skew" } };
    case "missing-compare":
      return { tool: "compare_audiences", input: { a_id: g.a, b_id: g.b, reason: "Coverage: one audience or two?" } };
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
    case "missing-demographics":
      return `demographics missing for ${n(g.compId)}`;
    case "missing-compare":
      return `${n(g.a)} vs ${n(g.b)} not compared yet`;
  }
}
