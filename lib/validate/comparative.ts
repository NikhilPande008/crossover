// Comparative-claim check (grounding rule 6). When a cited sentence says a named partner
// or city is higher / stronger / top / more than others (or lower / weaker / last), verify
// the ordering against the run's own scores:
//   markets   mean heatmap percentile across comps (RankedMarket.score)
//   partners  weighted mean affinity across comps, within the partner's domain
// If the sentence names exactly one comp ("for Hereditary's fans"), that comp's own
// per-comp scores are used instead.
//
// Scope is ambiguous in prose ("higher than the other markets": this concept's, or all?),
// so a claim passes if it holds in ANY group that contains the item: the whole run's
// ranking for that kind, or any concept's markets / same-domain partners. It is dropped
// only when it holds in none of them. Items without a score are not judged.

import type { AudienceMap, Comp, Concept } from "@/lib/types";

type Item = { name: string; kind: string; score: number; perComp: Record<string, number> };
type Group = { label: string; kind: string; names: string[] };

export type ScoreScope = {
  items: Map<string, Item>;
  groups: Group[];
  comps: Map<string, string>; // lower-cased comp name → entityId
};

export function buildScoreScope(audience: AudienceMap, concepts: Concept[], comps: Comp[]): ScoreScope {
  const items = new Map<string, Item>();
  const groups: Group[] = [];
  for (const m of audience.markets) items.set(m.name.toLowerCase(), { name: m.name, kind: "market", score: m.score, perComp: m.perComp });
  groups.push({ label: "all markets", kind: "market", names: audience.markets.map((m) => m.name) });
  for (const [domain, ps] of Object.entries(audience.partners)) {
    for (const p of ps) if (!items.has(p.name.toLowerCase())) items.set(p.name.toLowerCase(), { name: p.name, kind: `partner:${domain}`, score: p.score, perComp: p.perComp });
    if (ps.length) groups.push({ label: `all ${domain} partners`, kind: `partner:${domain}`, names: ps.map((p) => p.name) });
  }
  for (const c of concepts) {
    groups.push({ label: `${c.name} markets`, kind: "market", names: c.markets.map((m) => m.name) });
    for (const d of new Set(c.partners.map((p) => p.domain)))
      groups.push({ label: `${c.name} ${d} partners`, kind: `partner:${d}`, names: c.partners.filter((p) => p.domain === d).map((p) => p.name) });
  }
  return { items, groups, comps: new Map(comps.map((c) => [c.name.toLowerCase(), c.entityId])) };
}

const HIGH_SUPER = /\b(highest|strongest|greatest|largest|biggest|best|top|leading|the most)\b/i;
const HIGH_COMP = /\b(higher|stronger|greater|larger|bigger|outranks?|outperforms?|exceeds?|ahead of)\b|\bmore\b[^.;]{0,40}\bthan\b/i;
const LOW_SUPER = /\b(lowest|weakest|smallest|least|bottom)\b/i;
const LOW_COMP = /\b(lower|weaker|smaller|below|behind)\b|\bless\b[^.;]{0,40}\bthan\b/i;
const AMONG = /\b(among|one of)\b/i;
// Only claims about the run's numbers are checked; "the most atmospheric show" is taste, not score.
// Audience-size talk ("risks a smaller niche audience") is not a claim about any named item's score.
const SIZE_PHRASE = /\b(smaller|larger|bigger|narrower|broader|wider)\s+(?:\w+\s+){0,2}(audience|crowd|fan ?base|following|reach|niche|segment)\b/i;
/** The comparative word must sit near a named item to be a claim about it. */
const NEAR_CHARS = 60;
const SCORE_WORDS = /\b(affinit\w*|scores?|signals?|concentration|interest|heatmap|rank\w*|values?|over-?index\w*|popular\w*|fans?|fanbase|audiences?)\b/i;

export type ComparativeIssue = { reason: string };

/**
 * `mentions` are the named subjects in the sentence with their character positions
 * (found by the grounding validator), in order.
 */
export function checkComparative(text: string, mentions: { name: string; index: number }[], scope: ScoreScope): ComparativeIssue | null {
  const highSuper = text.match(HIGH_SUPER);
  const highComp = text.match(HIGH_COMP);
  const lowSuper = text.match(LOW_SUPER);
  const lowComp = text.match(LOW_COMP);
  const kw = highComp ?? highSuper ?? lowComp ?? lowSuper;
  if (!kw || kw.index === undefined || !SCORE_WORDS.test(text)) return null;
  const size = text.match(SIZE_PHRASE);
  if (size && size.index !== undefined && kw.index >= size.index && kw.index < size.index + size[0].length) return null;
  if (!mentions.some((m) => Math.abs(m.index - kw.index!) <= NEAR_CHARS)) return null;
  const direction: "high" | "low" = highComp || highSuper ? "high" : "low";
  const pairwise = Boolean(highComp ?? lowComp) && /\bthan\b/i.test(text);

  const scored = mentions.map((m) => ({ ...m, item: scope.items.get(m.name.toLowerCase()) })).filter((m): m is typeof m & { item: Item } => !!m.item);
  if (!scored.length) return null;

  // One named comp narrows the scores to that comp's own audience.
  const namedComps = [...scope.comps.entries()].filter(([n]) => new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text));
  const compId = namedComps.length === 1 ? namedComps[0][1] : undefined;
  const scoreOf = (name: string) => {
    const it = scope.items.get(name.toLowerCase());
    if (!it) return undefined;
    return compId ? (it.perComp[compId] ?? 0) : it.score;
  };

  // Claimants are named before the comparative word; in "X is higher than Y", Y is the target.
  const thanAt = text.search(/\bthan\b/i);
  const claimants = scored.filter((m) => m.index < kw.index!);
  const subjects = claimants.length ? claimants : scored;
  const targets = pairwise && thanAt >= 0 ? scored.filter((m) => m.index > thanAt) : [];
  const better = (a: number, b: number) => (direction === "high" ? a > b : a < b);
  const fmt = (n: number) => n.toFixed(3);

  // Pairwise: every claimant must beat every named target of the same kind.
  if (targets.length) {
    for (const s of subjects.filter((x) => !targets.includes(x)))
      for (const t of targets) {
        if (s.item.kind !== t.item.kind) continue;
        const a = scoreOf(s.name)!;
        const b = scoreOf(t.name)!;
        if (!better(a, b)) return { reason: `says ${s.item.name} is ${direction === "high" ? "higher" : "lower"} than ${t.item.name}, but scores are ${fmt(a)} vs ${fmt(b)}` };
      }
    return null;
  }

  // Versus others / superlative: a single "the highest" must rank first; "among the top" or several
  // names must sit in the top k, where k is the larger of 3 and a quarter of the group.
  const topK = AMONG.test(text) || subjects.length > 1;
  const kFor = (size: number) => (topK ? Math.max(3, subjects.length, Math.ceil(size / 4)) : 1);
  for (const s of subjects) {
    const groups = scope.groups.filter((g) => g.kind === s.item.kind && g.names.length >= 2 && g.names.some((n) => n.toLowerCase() === s.name.toLowerCase()));
    if (!groups.length) continue;
    const verdicts = groups.map((g) => {
      const scores = g.names.map((n) => ({ n, v: scoreOf(n) })).filter((x): x is { n: string; v: number } => x.v !== undefined);
      const mine = scoreOf(s.name)!;
      const rank = 1 + scores.filter((x) => better(x.v, mine)).length;
      return { g, rank, of: scores.length, k: kFor(scores.length) };
    });
    if (!verdicts.some((v) => v.rank <= v.k)) {
      const where = verdicts.map((v) => `${v.rank} of ${v.of} in ${v.g.label}`).join("; ");
      const claim = !topK ? (direction === "high" ? "the highest" : "the lowest") : `among the ${direction === "high" ? "top" : "bottom"} of its group`;
      return { reason: `implies ${s.item.name} is ${claim}, but it ranks ${where}${compId ? " (scores for the named comp)" : ""}` };
    }
  }
  return null;
}
