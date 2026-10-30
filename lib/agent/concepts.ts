// Concept candidates, deterministic templates, LLM-draft mapping and constraint
// enforcement. Partner and market names always come from facts, never from the LLM:
// the LLM picks candidate keys, code resolves them.

import { z } from "zod";
import type { AudienceMap, Brief, Comp, Concept, Domain, Fact, Lever, RankedMarket, RankedPartner } from "@/lib/types";
import { REGIONS } from "@/lib/geo/cities";
import { conceptConfidence, conceptSimilarity } from "@/lib/score";
import { THRESHOLDS } from "@/lib/thresholds";
import { checkConstraints, partnerExcluded, type Refinements } from "@/lib/validate/constraints";
import { partnerDomains } from "./assess";

export type Candidates = {
  markets: (RankedMarket & { key: string })[];
  partners: (RankedPartner & { key: string })[];
  /** How many partner candidates each constraint removed, most first. */
  removals: { constraint: string; kind: "exclusion" | "not-a-fit"; count: number }[];
};

export function buildCandidates(audience: AudienceMap, brief: Brief, facts: Fact[], ref: Refinements): Candidates {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const countries = new Set(brief.regions.map((r) => REGIONS[r]?.country));
  const markets = audience.markets.filter((m) => countries.has(m.country as never)).slice(0, 10).map((m, i) => ({ ...m, key: `M${i + 1}` }));
  const partners: Candidates["partners"] = [];
  const removed = new Map<string, { kind: "exclusion" | "not-a-fit"; count: number }>();
  const bump = (constraint: string, kind: "exclusion" | "not-a-fit") => removed.set(constraint, { kind, count: (removed.get(constraint)?.count ?? 0) + 1 });
  let k = 0;
  for (const d of partnerDomains(brief).concat(["book"])) {
    const ok = (audience.partners[d] ?? []).filter((p) => {
      const ex = partnerExcluded(p.name, p.factIds, byId, brief.exclusions);
      if (ex) bump(ex, "exclusion");
      const nf = ref.excludedPartners.find((x) => x.toLowerCase() === p.name.toLowerCase());
      if (nf) bump(nf, "not-a-fit");
      return !ex && !nf;
    });
    for (const p of ok.slice(0, 6)) partners.push({ ...p, key: `P${++k}` });
  }
  const removals = [...removed.entries()].map(([constraint, v]) => ({ constraint, ...v })).sort((a, b) => b.count - a.count);
  return { markets, partners, removals };
}

export function candidatesSummary(c: Candidates, comps: Comp[]): string {
  const cn = (id: string) => comps.find((x) => x.entityId === id)?.name ?? id;
  const per = (r: Record<string, number>) =>
    Object.entries(r)
      .map(([id, v]) => `${cn(id)}=${v}`)
      .join(", ");
  return [
    "MARKETS (key, city, score, per-comp percentile, facts):",
    ...c.markets.map((m) => `${m.key} ${m.name} score=${m.score} [${per(m.perComp)}] ${m.factIds.join(",")}`),
    "",
    "PARTNERS (key, domain, name, score, per-comp affinity, facts):",
    ...c.partners.map((p) => `${p.key} ${p.domain} ${JSON.stringify(p.name)} score=${p.score} [${per(p.perComp)}] ${p.factIds.join(",")}`),
  ].join("\n");
}

// ---------- LLM output schemas ----------

export const ConceptDraft = z.object({
  lever: z.enum(["market", "partner", "crossover"]),
  name: z.string().describe("Short concept name, no numbers"),
  leadCompIds: z.array(z.string()),
  marketKeys: z.array(z.string()).describe("Keys like M1 from the MARKETS list, 3 to 5"),
  partnerKeys: z.array(z.string()).describe("Keys like P1 from the PARTNERS list, 4 to 6"),
  creativeAngle: z.object({ text: z.string(), factIds: z.array(z.string()) }),
  risks: z.array(z.string()),
  hypotheses: z.array(z.string()),
});
export const ConceptsOut = z.object({ concepts: z.array(ConceptDraft) });
export type ConceptDraftT = z.infer<typeof ConceptDraft>;

export function draftToConcept(d: ConceptDraftT, idx: number, cand: Candidates, comps: Comp[]): Concept {
  const mk = new Map(cand.markets.map((m) => [m.key, m]));
  const pk = new Map(cand.partners.map((p) => [p.key, p]));
  const lead = d.leadCompIds.filter((id) => comps.some((c) => c.entityId === id));
  return {
    id: `C${idx + 1}`,
    lever: d.lever,
    name: d.name.trim() || defaultName(d.lever),
    leadComps: lead.length ? lead : comps.map((c) => c.entityId),
    markets: [...new Set(d.marketKeys)].map((k) => mk.get(k)).filter((m): m is NonNullable<typeof m> => !!m).map((m) => ({ name: m.name, factIds: m.factIds })),
    partners: [...new Set(d.partnerKeys)].map((k) => pk.get(k)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ name: p.name, domain: p.domain, factIds: p.factIds })),
    creativeAngle: d.creativeAngle,
    confidence: "low",
    risks: d.risks,
    hypotheses: d.hypotheses,
  };
}

function defaultName(lever: Lever) {
  return lever === "market" ? "Market-led launch" : lever === "partner" ? "Partner bridge" : "Crossover play";
}

// ---------- deterministic templates ----------

function topBy<T>(xs: T[], f: (x: T) => number, n: number): T[] {
  return [...xs].sort((a, b) => f(b) - f(a)).slice(0, n);
}

export function strongestComp(audience: AudienceMap, comps: Comp[]): Comp {
  const strength = (c: Comp) =>
    Object.values(audience.partners)
      .flat()
      .reduce((s, p) => s + (p.perComp[c.entityId] ?? 0), 0);
  return topBy(comps, strength, 1)[0] ?? comps[0];
}

export function templateConcepts(audience: AudienceMap, cand: Candidates, comps: Comp[], brief: Brief): Concept[] {
  const lead = strongestComp(audience, comps);
  const others = comps.filter((c) => c !== lead);
  const pick = (ps: Candidates["partners"], domains: Domain[], perDomain: number, f: (p: RankedPartner) => number) =>
    domains.flatMap((d) => topBy(ps.filter((p) => p.domain === d), f, perDomain));
  const mf = (m: RankedMarket) => ({ name: m.name, factIds: m.factIds });
  const pf = (p: RankedPartner) => ({ name: p.name, domain: p.domain, factIds: p.factIds });
  const tags = audience.tags;
  const tagFor = (compId?: string) => (compId ? topBy(tags, (t) => t.perComp[compId] ?? 0, 2) : tags.slice(0, 2));
  const angle = (ts: typeof tags, lead: string) => ({
    text: ts.length ? `${lead} around ${ts.map((t) => `“${t.name}”`).join(" and ")}.` : `${lead} on the comps' shared tastes.`,
    factIds: ts.flatMap((t) => t.factIds.slice(0, 1)),
  });
  const [screen] = partnerDomains(brief).filter((d) => d === "tv_show" || d === "movie");

  const marketLed: Concept = {
    id: "C1",
    lever: "market",
    name: `Lead with ${lead.name}'s audience`,
    leadComps: [lead.entityId],
    markets: topBy(cand.markets, (m) => m.perComp[lead.entityId] ?? 0, 5).map(mf),
    partners: pick(cand.partners, ["podcast", "artist", "brand"], 1, (p) => p.perComp[lead.entityId] ?? 0).map(pf),
    creativeAngle: angle(tagFor(lead.entityId), `Position like ${lead.name}`),
    confidence: "low",
    risks: [`Leans on a single comp; fans of ${others.map((c) => c.name).join(" and ") || "the other comps"} may not follow.`],
    hypotheses: [`Concentrating spend where ${lead.name}'s fans cluster may lower cost per engaged viewer.`],
  };
  const bridgeScore = (p: RankedPartner) => Math.min(...comps.map((c) => p.perComp[c.entityId] ?? 0));
  const shared = audience.overlaps.flatMap((o) => o.shared);
  const sharedTags = tags.filter((t) => shared.includes(t.name)).slice(0, 2);
  const partnerLed: Concept = {
    id: "C2",
    lever: "partner",
    name: "Bridge both audiences through shared partners",
    leadComps: comps.map((c) => c.entityId),
    markets: cand.markets.slice(0, 3).map(mf),
    partners: pick(cand.partners, ["podcast", "artist", "brand"], 2, bridgeScore).map(pf),
    creativeAngle: angle(sharedTags.length ? sharedTags : tags.slice(0, 2), "Lead the creative"),
    confidence: "low",
    risks: ["Bridge partners can be broad; message may feel less specific to either fan base."],
    hypotheses: ["Partners loved by every comp's audience may reach both fan bases at once."],
  };
  // The comp least like the lead: lowest overlap with it, whichever side of the pair it is on.
  const overlapWithLead = (c: Comp) =>
    audience.overlaps.find((o) => (o.a === lead.entityId && o.b === c.entityId) || (o.b === lead.entityId && o.a === c.entityId))?.score ?? 0;
  const weakest = others.length ? topBy(others, (c) => -overlapWithLead(c), 1)[0] : lead;
  const adjDomains = [screen, "book"].filter(Boolean) as Domain[];
  const crossover: Concept = {
    id: "C3",
    lever: "crossover",
    name: `Crossover into ${weakest.name}'s fandom`,
    leadComps: [weakest.entityId],
    markets: topBy(
      cand.markets.filter((m) => !marketLed.markets.slice(0, 2).some((x) => x.name === m.name)),
      (m) => m.perComp[weakest.entityId] ?? 0,
      4,
    ).map(mf),
    partners: pick(cand.partners, adjDomains.length ? adjDomains : ["artist"], 2, (p) => p.perComp[weakest.entityId] ?? 0)
      .concat(pick(cand.partners, ["podcast"], 1, (p) => (p.perComp[weakest.entityId] ?? 0) - (p.perComp[lead.entityId] ?? 0)))
      .map(pf),
    creativeAngle: angle(tagFor(weakest.entityId), `Reframe for ${weakest.name} fans`),
    confidence: "low",
    risks: ["Adjacent fandoms convert less reliably than the core audience."],
    hypotheses: [`An adjacent-fandom angle may open an audience the core plan misses.`],
  };
  return [marketLed, partnerLed, crossover];
}

// ---------- enforcement ----------

export type EnforceLog = string[];

/** Replace or drop anything violating hard constraints; add pinned markets. */
export function enforceConstraints(concepts: Concept[], brief: Brief, facts: Fact[], ref: Refinements, cand: Candidates, log: EnforceLog): Concept[] {
  return concepts.map((c) => {
    const violations = checkConstraints(c, brief, facts, ref);
    if (!violations.length) return c;
    const bad = new Set(violations.filter((v) => v.kind !== "pinned").map((v) => v.item));
    const partners = c.partners.flatMap((p) => {
      if (!bad.has(p.name)) return [p];
      const repl = cand.partners.find((x) => x.domain === p.domain && !bad.has(x.name) && !c.partners.some((y) => y.name === x.name));
      log.push(`${c.name}: replaced ${JSON.stringify(p.name)} (${violations.find((v) => v.item === p.name)?.reason})${repl ? ` with ${JSON.stringify(repl.name)}` : ""}`);
      return repl ? [{ name: repl.name, domain: repl.domain, factIds: repl.factIds }] : [];
    });
    let markets = c.markets.filter((m) => !bad.has(m.name));
    for (const v of violations.filter((v) => v.kind === "pinned")) {
      const m = cand.markets.find((x) => x.name === v.item);
      markets = [{ name: v.item, factIds: m?.factIds ?? [] }, ...markets].slice(0, 5);
      log.push(`${c.name}: added pinned market ${v.item}`);
    }
    return { ...c, partners, markets };
  });
}

export function finalizeConfidence(concepts: Concept[], facts: Fact[], comps: Comp[], usedFallback: boolean): Concept[] {
  return concepts.map((c) => ({ ...c, confidence: conceptConfidence(c, facts, comps, usedFallback) }));
}

/** Returns index pairs of concepts that are near-duplicates. */
export function similarPairs(concepts: Concept[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < concepts.length; i++)
    for (let j = i + 1; j < concepts.length; j++) if (conceptSimilarity(concepts[i], concepts[j]) > THRESHOLDS.maxConceptSimilarity) out.push([i, j]);
  return out;
}
