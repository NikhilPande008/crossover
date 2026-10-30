// Allowlisted query parameters per Qloo path / filter.type.
// Qloo has been observed to silently ignore unknown params, so we refuse to send
// anything not listed here. Update after the API spike (docs/api-findings.md).

// Per docs.qloo.com/reference/available-parameters-by-entity-type. feature.explainability
// is not in that table but is sent by Qloo's own harness (recommend workflow).
const COMMON_INSIGHTS = [
  "filter.type",
  "signal.interests.entities",
  "filter.exclude.entities",
  "feature.explainability",
  "take",
  "offset",
];

export const ALLOWED_PARAMS: Record<string, string[]> = {
  "/search": ["query", "types", "take", "page"],
  "/v2/tags": ["filter.query", "filter.tag.types", "take"],
  // Documented at docs.qloo.com/reference/analysis-compare. filter.type does NOT accept urn:tag.
  "/v2/analysis/compare": ["a.signal.interests.entities", "b.signal.interests.entities", "filter.type", "filter.subtype", "model", "take", "offset"],
  "insights:urn:entity:artist": COMMON_INSIGHTS,
  "insights:urn:entity:podcast": COMMON_INSIGHTS,
  "insights:urn:entity:tv_show": COMMON_INSIGHTS,
  "insights:urn:entity:movie": COMMON_INSIGHTS,
  "insights:urn:entity:book": COMMON_INSIGHTS,
  "insights:urn:entity:brand": COMMON_INSIGHTS,
  // The parameter table lists only diversify.*/offset/take for urn:tag, but the taste-analysis
  // guide and the harness use signal.interests.entities and filter.tag.types with it.
  "insights:urn:tag": ["filter.type", "signal.interests.entities", "filter.tag.types", "diversify.by", "diversify.take", "take", "offset"],
  "insights:urn:demographics": ["filter.type", "signal.interests.entities"],
  "insights:urn:heatmap": ["filter.type", "signal.interests.entities", "filter.location.query", "take"],
};

export class DisallowedParamError extends Error {}

/** Throws if any param is not on the allowlist for this path. */
export function assertParams(path: string, params: Record<string, string>): void {
  const key = path === "/v2/insights" ? `insights:${params["filter.type"]}` : path;
  const allowed = ALLOWED_PARAMS[key];
  if (!allowed) throw new DisallowedParamError(`No allowlist for ${key}`);
  for (const k of Object.keys(params)) {
    if (!allowed.includes(k)) throw new DisallowedParamError(`Param ${k} not allowed for ${key}`);
  }
}

export const DOMAIN_URN = {
  artist: "urn:entity:artist",
  podcast: "urn:entity:podcast",
  tv_show: "urn:entity:tv_show",
  movie: "urn:entity:movie",
  book: "urn:entity:book",
  brand: "urn:entity:brand",
} as const;

export const ENTITY_TYPE_URN = DOMAIN_URN;
