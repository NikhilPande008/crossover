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
  /**
   * Share of distinct themes two comps have in common (Qloo compare, else per-comp tags) at or above
   * which they count as one audience. Live 2026-10-30: Hereditary/The Witch 17%, Fleabag/Barry 15%,
   * Fleabag/Russian Doll 16%, Hereditary/Lady Bird 3%. Top-affinity overlap (1–7% for every pair)
   * does not separate similar from dissimilar comps, so it is shown but not used for the verdict.
   */
  sharedThemes: 0.1,
  /** Delta below which a compared tag counts as shared. */
  sharedTagDelta: 0.12,
  /** Concepts sharing more than this fraction of partners+markets are near-duplicates. */
  maxConceptSimilarity: 0.6,
  /** Share of dropped sentences that triggers one regeneration. */
  maxDroppedShare: 0.2,
  /**
   * Popularity penalty weight. Tested on a live run (2026-10-30): brand candidates are all at
   * popularity 0.99–1.00, so λ up to 0.3 leaves Tesla and Apple on top and only promotes items
   * with missing popularity (reported as 0). Kept at 0; fixing brand genericness needs a different candidate pool.
   */
  popularityLambda: 0,
};
