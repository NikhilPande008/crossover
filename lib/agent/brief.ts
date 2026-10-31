// Decision brief: LLM output schema and the deterministic template used when the
// language model is unavailable.

import { z } from "zod";
import type { AudienceMap, Comp, Concept, DecisionBrief, TestItem, TestType } from "@/lib/types";

export const DISCLAIMER =
  "Qloo affinity describes aggregate taste overlap among audiences. It is not a forecast of box office, streams, ticket sales or campaign performance.";

const Cited = z.object({ text: z.string(), factIds: z.array(z.string()) });
// The recommendation itself is chosen in code (pickRecommended); the model only argues for it.
export const TEST_TYPES = ["geo_ab", "podcast_host_read", "artist_social_collab", "screen_cross_promo", "brand_copromo", "creative_ab"] as const;

// The checklist is typed: the model picks a test type and the plan items it applies to, and
// code writes the sentence, so a test can only name what the recommended plan contains and
// a podcast read can only go to a podcast.
const TestDraft = z.object({
  type: z.enum(TEST_TYPES),
  subjects: z.array(z.string()).describe("Exact names of markets or partners from the recommended concept; empty for creative_ab"),
  why: z.string().describe("One short sentence: what this test tells you before you spend"),
});
export const BriefOut = z.object({
  rationale: z.array(Cited),
  whyNotOthers: z.array(Cited),
  tradeoffs: z.array(z.string()),
  tests: z.array(TestDraft),
});

/** Which partner domain each test type needs (markets for geo_ab, none for creative_ab). */
const NEEDS: Record<TestType, { kind: "market" | "partner" | "none"; domains?: string[]; count: number }> = {
  geo_ab: { kind: "market", count: 2 },
  podcast_host_read: { kind: "partner", domains: ["podcast"], count: 1 },
  artist_social_collab: { kind: "partner", domains: ["artist"], count: 1 },
  screen_cross_promo: { kind: "partner", domains: ["tv_show", "movie"], count: 1 },
  brand_copromo: { kind: "partner", domains: ["brand"], count: 1 },
  creative_ab: { kind: "none", count: 0 },
};

function sentence(type: TestType, s: string[], rec: Concept): string {
  switch (type) {
    case "geo_ab":
      return `Run a small paid-social test in ${s[0]} against ${s[1]}, same creative and budget, before committing the market budget.`;
    case "podcast_host_read":
      return `Buy one host-read spot on “${s[0]}” with a tracked link before committing to a full sponsorship.`;
    case "artist_social_collab":
      return `Pitch ${s[0]} for a single social post or playlist placement and measure response before a larger tie-in.`;
    case "screen_cross_promo":
      return `Target fans of “${s[0]}” in a small paid-social test before pursuing a cross-promotion.`;
    case "brand_copromo":
      return `Approach ${s[0]} about a small co-branded social test before a full co-promotion.`;
    case "creative_ab": {
      const angle = rec.creativeAngle.text.replace(/\.$/, "");
      return `A/B the trailer cut-downs: this angle (${angle.length > 90 ? `${angle.slice(0, 87)}…` : angle}) against a genre-standard cut.`;
    }
  }
}

/**
 * Turn typed test drafts into checklist items. Subjects must be the recommended concept's own
 * markets or partners of the right domain (case-insensitive exact names); anything else drops the test.
 */
export function renderTests(drafts: { type: TestType; subjects: string[]; why?: string }[], rec: Concept): { tests: TestItem[]; dropped: { type: string; reason: string }[] } {
  const tests: TestItem[] = [];
  const dropped: { type: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const need = NEEDS[d.type];
    if (!need) continue;
    const pool = need.kind === "market" ? rec.markets.map((m) => m.name) : need.kind === "partner" ? rec.partners.filter((p) => need.domains!.includes(p.domain)).map((p) => p.name) : [];
    const subjects = d.subjects.map((x) => pool.find((n) => n.toLowerCase() === x.trim().toLowerCase())).filter((x): x is string => !!x);
    const uniq = [...new Set(subjects)];
    if (uniq.length < need.count) {
      dropped.push({ type: d.type, reason: need.count ? `needs ${need.count} ${need.kind === "market" ? "markets" : `${need.domains!.join("/")} partner`} from the recommended concept` : "invalid" });
      continue;
    }
    const s = uniq.slice(0, Math.max(need.count, 0));
    const key = `${d.type}:${s.join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tests.push({ type: d.type, subjects: s, text: sentence(d.type, s, rec), ...(d.why ? { why: d.why } : {}) });
  }
  return { tests, dropped };
}

/** Deterministic tests for the recommended concept: one per kind of lever it has. */
export function templateTests(rec: Concept): TestItem[] {
  const drafts: { type: TestType; subjects: string[] }[] = [];
  if (rec.markets.length >= 2) drafts.push({ type: "geo_ab", subjects: [rec.markets[0].name, rec.markets[1].name] });
  const first = (domains: string[]) => rec.partners.find((p) => domains.includes(p.domain))?.name;
  const pod = first(["podcast"]);
  if (pod) drafts.push({ type: "podcast_host_read", subjects: [pod] });
  const art = first(["artist"]);
  if (art) drafts.push({ type: "artist_social_collab", subjects: [art] });
  const brand = first(["brand"]);
  if (brand) drafts.push({ type: "brand_copromo", subjects: [brand] });
  drafts.push({ type: "creative_ab", subjects: [] });
  return renderTests(drafts, rec).tests.slice(0, 5);
}

const RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * Deterministic recommendation: highest confidence first; ties go to the bridge (partner-led)
 * concept when most comp pairs share an audience, otherwise to the market-led one; any remaining
 * tie keeps the market, partner, crossover order. The same evidence always gives the same pick.
 */
export function pickRecommended(concepts: Concept[], audience: AudienceMap): Concept {
  return explainRecommended(concepts, audience).concept;
}

export function explainRecommended(concepts: Concept[], audience: AudienceMap): { concept: Concept; reason: string } {
  const similar = audience.overlaps.filter((o) => o.similar).length;
  const prefer = audience.overlaps.length && similar * 2 >= audience.overlaps.length ? "partner" : "market";
  const sorted = [...concepts].sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || Number(b.lever === prefer) - Number(a.lever === prefer));
  const concept = sorted[0];
  const tied = concepts.filter((c) => c.confidence === concept.confidence).length > 1;
  const verdict = `${similar} of ${audience.overlaps.length} comp pairs share an audience`;
  const reason = !tied
    ? `highest confidence (${concept.confidence})`
    : concept.lever === prefer
      ? `tied on ${concept.confidence} confidence; ${verdict}, so the ${prefer === "partner" ? "bridge" : "market-led"} concept leads`
      : `tied on ${concept.confidence} confidence; first in market, partner, crossover order`;
  return { concept, reason };
}

export function templateBrief(concepts: Concept[], audience: AudienceMap, comps: Comp[]): DecisionBrief {
  const rec = pickRecommended(concepts, audience);
  const others = concepts.filter((c) => c !== rec);
  const p0 = rec.partners[0];
  // Pinned markets are prepended, so the first market is not necessarily the strongest.
  const rank = new Map(audience.markets.map((m, i) => [m.name, i]));
  const strongest = rec.markets.filter((m) => m.factIds.length && rank.has(m.name)).sort((a, b) => rank.get(a.name)! - rank.get(b.name)!)[0];
  const rationale = [
    p0 && { text: `“${p0.name}” is among the strongest ${p0.domain} affinities for the lead audience.`, factIds: p0.factIds.slice(0, 3) },
    strongest && { text: `${strongest.name} has the strongest fan concentration of this concept's markets.`, factIds: strongest.factIds.slice(0, 3) },
    rec.creativeAngle.factIds.length && { text: rec.creativeAngle.text, factIds: rec.creativeAngle.factIds },
  ].filter(Boolean) as DecisionBrief["rationale"];
  const overlap = audience.overlaps[0];
  const tests = templateTests(rec);
  return {
    recommendedId: rec.id,
    rationale,
    whyNotOthers: others.map((c) => ({
      text: `${c.name} has ${c.confidence} confidence on the current evidence.`,
      factIds: [...c.partners, ...c.markets].flatMap((x) => x.factIds).slice(0, 2),
    })),
    tradeoffs: [
      rec.lever === "market" ? "Concentrated markets limit reach outside the lead audience's strongholds." : "Broader partner reach may dilute the message for each comp's core fans.",
      overlap && !overlap.similar
        ? `${comps.find((c) => c.entityId === overlap.a)?.name} and ${comps.find((c) => c.entityId === overlap.b)?.name} look like ${overlap.verdict === "adjacent" ? "adjacent" : "different"} audiences, so one plan will not serve both equally.`
        : "The comps share much of their audience, so concepts differ more in channel than in audience.",
    ].filter(Boolean),
    testChecklist: tests.map((t) => t.text),
    tests,
    disclaimer: DISCLAIMER,
    writtenBy: "template",
    droppedSentences: 0,
  };
}
