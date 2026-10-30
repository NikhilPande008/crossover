// Evidence thresholds, calibrated from the first live probe (2026-10-25, Hereditary):
// top-20 entity affinities sit in a narrow 0.83–0.98 band (books lowest), tag affinities
// 0.99–1.0, heatmap affinity is a 0–1 rank. Absolute affinity therefore barely separates
// results; agreement between comps carries the signal. Re-check after more live runs.

export const THRESHOLDS = {
  /** Minimum affinity for a partner/market to count as a signal (top results are all above ~0.83). */
  affinityFloor: 0.8,
  /** Affinity treated as "strong and specific" for a single comp (roughly the top few per domain). */
  strongAffinity: 0.96,
  /** Minimum items above the floor for a domain to be considered researched. */
  minItemsPerDomain: 4,
  /** Audience-affinity overlap (Jaccard) below which comps are treated as two audiences. Provisional. */
  splitOverlap: 0.15,
  /** Delta below which a compared tag counts as shared. */
  sharedTagDelta: 0.12,
  /** Concepts sharing more than this fraction of partners+markets are near-duplicates. */
  maxConceptSimilarity: 0.6,
  /** Share of dropped sentences that triggers one regeneration. */
  maxDroppedShare: 0.2,
  /** Popularity penalty weight. 0 until test case 2 shows popular entities dominate. */
  popularityLambda: 0,
};
