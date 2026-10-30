// Hard constraint checks, enforced in code rather than by prompt.

import type { Brief, Concept, Fact } from "@/lib/types";
import { CITIES, REGIONS } from "@/lib/geo/cities";

export type Refinements = {
  excludedPartners: string[]; // partner names the user marked "not a fit"
  pinnedMarkets: string[];
};

export type Violation = { conceptId: string; kind: "exclusion" | "region" | "pinned" | "excluded-partner"; item: string; reason: string };

function norm(s: string) {
  return s.toLowerCase().trim();
}

/** True when a partner matches a brief exclusion by name or by any Qloo tag on its facts. */
export function partnerExcluded(name: string, factIds: string[], facts: Map<string, Fact>, exclusions: string[]): string | null {
  const n = norm(name);
  for (const raw of exclusions) {
    const ex = norm(raw).replace(/^no\s+/, "").replace(/\s+brands?$/, "");
    if (!ex) continue;
    if (n.includes(ex)) return raw;
    for (const id of factIds) {
      const tags = String(facts.get(id)?.detail?.tags ?? "")
        .split("|")
        .map(norm);
      if (tags.some((t) => t && (t.includes(ex) || ex.includes(t)))) return raw;
    }
  }
  return null;
}

export function checkConstraints(concept: Concept, brief: Brief, facts: Fact[], ref: Refinements): Violation[] {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out: Violation[] = [];
  const allowedCountries = new Set(brief.regions.map((r) => REGIONS[r]?.country).filter(Boolean));
  for (const p of concept.partners) {
    const hit = partnerExcluded(p.name, p.factIds, byId, brief.exclusions);
    if (hit) out.push({ conceptId: concept.id, kind: "exclusion", item: p.name, reason: `matches exclusion "${hit}"` });
    if (ref.excludedPartners.some((x) => norm(x) === norm(p.name)))
      out.push({ conceptId: concept.id, kind: "excluded-partner", item: p.name, reason: "marked not a fit" });
  }
  for (const m of concept.markets) {
    const country = CITIES.find((c) => c.name === m.name)?.country;
    if (allowedCountries.size && country && !allowedCountries.has(country))
      out.push({ conceptId: concept.id, kind: "region", item: m.name, reason: `outside target regions` });
  }
  for (const pin of ref.pinnedMarkets) {
    if (!concept.markets.some((m) => m.name === pin)) out.push({ conceptId: concept.id, kind: "pinned", item: pin, reason: "pinned market missing" });
  }
  return out;
}
