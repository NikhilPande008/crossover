// Decision brief: LLM output schema and the deterministic template used when the
// language model is unavailable.

import { z } from "zod";
import type { AudienceMap, Comp, Concept, DecisionBrief } from "@/lib/types";

export const DISCLAIMER =
  "Qloo affinity describes aggregate taste overlap among audiences. It is not a forecast of box office, streams, ticket sales or campaign performance.";

const Cited = z.object({ text: z.string(), factIds: z.array(z.string()) });
// The recommendation itself is chosen in code (pickRecommended); the model only argues for it.
export const BriefOut = z.object({
  rationale: z.array(Cited),
  whyNotOthers: z.array(Cited),
  tradeoffs: z.array(z.string()),
  testChecklist: z.array(z.string()),
});

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
  const m0 = rec.markets[0];
  // Pinned markets are prepended, so the first market is not necessarily the strongest.
  const rank = new Map(audience.markets.map((m, i) => [m.name, i]));
  const strongest = rec.markets.filter((m) => m.factIds.length && rank.has(m.name)).sort((a, b) => rank.get(a.name)! - rank.get(b.name)!)[0];
  const rationale = [
    p0 && { text: `“${p0.name}” is among the strongest ${p0.domain} affinities for the lead audience.`, factIds: p0.factIds.slice(0, 3) },
    strongest && { text: `${strongest.name} has the strongest fan concentration of this concept's markets.`, factIds: strongest.factIds.slice(0, 3) },
    rec.creativeAngle.factIds.length && { text: rec.creativeAngle.text, factIds: rec.creativeAngle.factIds },
  ].filter(Boolean) as DecisionBrief["rationale"];
  const overlap = audience.overlaps[0];
  return {
    recommendedId: rec.id,
    rationale,
    whyNotOthers: others.map((c) => ({
      text: `${c.name} has ${c.confidence} confidence on the current evidence.`,
      factIds: [...c.partners, ...c.markets].flatMap((x) => x.factIds).slice(0, 2),
    })),
    tradeoffs: [
      rec.lever === "market" ? "Concentrated markets limit reach outside the lead audience's strongholds." : "Broader partner reach may dilute the message for each comp's core fans.",
      overlap && !overlap.similar ? `${comps.find((c) => c.entityId === overlap.a)?.name} and ${comps.find((c) => c.entityId === overlap.b)?.name} look like different audiences, so one plan will not serve both equally.` : "The comps share much of their audience, so concepts differ more in channel than in audience.",
    ].filter(Boolean),
    testChecklist: [
      m0 && rec.markets[1] ? `Run a small paid social test in ${m0.name} against ${rec.markets[1].name} before committing the market budget.` : "Run a small paid social test in the top two markets before committing the market budget.",
      p0 ? `Pitch “${p0.name}” for a pilot integration and measure engagement before a full partnership.` : "Pilot one partnership before committing the rest.",
      "A/B the creative angle in trailer cut-downs against a genre-standard cut.",
      "Check each partner for brand-safety fit with the release's rating and exclusions.",
    ],
    disclaimer: DISCLAIMER,
    writtenBy: "template",
    droppedSentences: 0,
  };
}
