// Typed Qloo capabilities. Each call parses the response loosely and records
// one Fact per returned value, carrying the exact request that produced it.

import type { Comp, Domain, EntityType, Fact } from "@/lib/types";
import type { FactStore } from "@/lib/facts/store";
import { nearestCity, REGIONS } from "@/lib/geo/cities";
import { QlooClient, QlooError, type QlooResponse } from "./client";
import { DOMAIN_URN, ENTITY_TYPE_URN } from "./params";
import { parseCompare } from "./compare";
import { isSensitive } from "@/lib/validate/sensitive";
import { CompareResponse, DemographicsResponse, EntitiesResponse, HeatmapResponse, SearchResponse, TagsResponse } from "./schemas";

export type Candidate = { entityId: string; name: string; type: EntityType; year?: number; descriptor?: string; genres?: string[] };

const URN_TO_TYPE: Record<string, EntityType> = {
  "urn:entity:movie": "movie",
  "urn:entity:tv_show": "tv_show",
  "urn:entity:artist": "artist",
  "urn:entity:book": "book",
  "urn:entity:podcast": "podcast",
  "urn:entity:brand": "brand",
  "urn:entity:person": "person",
};

export async function searchEntities(client: QlooClient, query: string, types: EntityType[], take = 5): Promise<Candidate[]> {
  const res = await client.get("/search", {
    query,
    types: types.map((t) => ENTITY_TYPE_URN[t]).join(","),
    take: String(take),
  });
  const parsed = SearchResponse.safeParse(res.data);
  if (!parsed.success) return [];
  return parsed.data.results.map((r) => {
    const urn = r.types?.find((t) => URN_TO_TYPE[t]) ?? r.type ?? "";
    return {
      entityId: r.entity_id,
      name: r.name,
      type: URN_TO_TYPE[urn] ?? types[0],
      year: r.properties?.release_year ?? r.properties?.year,
      descriptor: clip(r.properties?.short_description ?? r.properties?.description, 280),
      genres: genreTags(r.tags),
    };
  });
}

/** The entity's own media-genre tags (e.g. urn:tag:genre:media:horror), in Qloo's order. */
function genreTags(tags: { tag_id?: string; id?: string }[] | undefined): string[] | undefined {
  const out = (tags ?? []).map((t) => t.tag_id ?? t.id ?? "").filter((id) => /^urn:tag:genre:media:[a-z0-9_]+$/.test(id));
  return out.length ? [...new Set(out)].slice(0, 6) : undefined;
}

/** Shorten to at most n characters, at a word boundary. */
function clip(s: string | undefined, n: number): string | undefined {
  if (!s || s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : cut.length).trimEnd()}…`;
}

function base(res: QlooResponse, path: string, params: Record<string, string>, compIds: string[]) {
  return {
    compIds,
    request: { path, params },
    retrievedAt: res.retrievedAt,
    // Served from cache = not fetched now: keep the original timestamp and badge it recorded.
    recorded: res.cached,
    synthetic: res.synthetic,
  };
}

const ids = (comps: Comp[]) => comps.map((c) => c.entityId).join(",");

export async function fetchAffinities(
  client: QlooClient,
  store: FactStore,
  comps: Comp[],
  domain: Domain,
  excludeIds: string[] = [],
  take = 10,
): Promise<Fact[]> {
  const params: Record<string, string> = {
    "filter.type": DOMAIN_URN[domain],
    "signal.interests.entities": ids(comps),
    "feature.explainability": "true",
    take: String(take),
  };
  if (excludeIds.length) params["filter.exclude.entities"] = excludeIds.join(",");
  const res = await client.get("/v2/insights", params);
  const parsed = EntitiesResponse.safeParse(res.data);
  if (!parsed.success) return [];
  const excluded = new Set(excludeIds);
  return parsed.data.results.entities
    .map((e) => ({ ...e, id: e.entity_id ?? e.id, aff: e.affinity ?? e.query?.affinity }))
    .filter((e): e is typeof e & { id: string; aff: number } => typeof e.aff === "number" && !!e.id)
    // Assert filters in code: Qloo may silently ignore params.
    .filter((e) => !excluded.has(e.id))
    .map((e, i) =>
      store.add({
        ...base(res, "/v2/insights", params, comps.map((c) => c.entityId)),
        kind: "affinity",
        subject: { entityId: e.id, name: e.name, type: domain },
        value: e.aff,
        detail: {
          rank: i + 1,
          ...(e.popularity !== undefined ? { popularity: e.popularity } : {}),
          ...(e.tags?.length ? { tags: e.tags.map((t) => t.name ?? "").filter(Boolean).join("|") } : {}),
        },
      }),
    );
}

/**
 * urn:tag insights return tags from every Qloo domain, so a film's audience also gets
 * restaurant genres, credit cards, hotel ratings, book genres ("Classics") and podcast
 * themes ("Brand Building"). Creative angles need story tags: urn:tag:<type>:<media|qloo>:…
 * with a story type. Checked against live Hereditary and Fleabag tag lists (2026-10-30).
 */
// "audience" tags ("Psychological Thriller Fans") describe people, not the story, so they are not angle evidence.
const STORY_TAG_TYPES = new Set(["plot", "style", "motif", "archetype", "character", "mood", "keyword"]);

/** A story tag usable as creative-angle evidence. Tags naming a sensitive trait are never used. */
export function isCreativeTag(tagId: string | undefined, name?: string): boolean {
  const [, , type, domain] = (tagId ?? "").split(":");
  return (domain === "media" || domain === "qloo") && STORY_TAG_TYPES.has(type) && !(name && isSensitive(name));
}

export async function fetchTags(client: QlooClient, store: FactStore, comps: Comp[], take = 12): Promise<Fact[]> {
  // Over-fetch, since most of the list is filtered out (see isCreativeTag).
  const params = { "filter.type": "urn:tag", "signal.interests.entities": ids(comps), take: String(Math.min(50, take * 4)) };
  const res = await client.get("/v2/insights", params);
  const parsed = TagsResponse.safeParse(res.data);
  if (!parsed.success) return [];
  return parsed.data.results.tags
    .map((t) => ({ ...t, aff: t.affinity ?? t.query?.affinity }))
    .filter((t): t is typeof t & { aff: number } => typeof t.aff === "number" && isCreativeTag(t.tag_id ?? t.id, t.name))
    .slice(0, take)
    .map((t, i) =>
      store.add({
        ...base(res, "/v2/insights", params, comps.map((c) => c.entityId)),
        kind: "tag",
        subject: { entityId: t.tag_id ?? t.id, name: t.name.trim(), type: "tag" },
        value: t.aff,
        detail: { rank: i + 1 },
      }),
    );
}

const AGE_LABEL: Record<string, string> = {
  "24_and_younger": "under 25",
  "25_to_29": "25–29",
  "30_to_34": "30–34",
  "35_to_44": "35–44",
  "45_to_54": "45–54",
  "55_and_older": "55+",
};

export async function fetchDemographics(client: QlooClient, store: FactStore, comp: Comp): Promise<Fact[]> {
  const params = { "filter.type": "urn:demographics", "signal.interests.entities": comp.entityId };
  const res = await client.get("/v2/insights", params);
  const parsed = DemographicsResponse.safeParse(res.data);
  if (!parsed.success) return [];
  // One block per signal; match ours by entity_id, falling back to the only block.
  const rows = parsed.data.results.demographics;
  const row = (rows.find((r) => r.entity_id === comp.entityId) ?? rows[0])?.query;
  if (!row) return [];
  const out: Fact[] = [];
  const ages = Object.entries(row.age ?? {}).sort((a, b) => b[1] - a[1]);
  if (ages.length) {
    const [bucket, v] = ages[0];
    out.push(
      store.add({
        ...base(res, "/v2/insights", params, [comp.entityId]),
        kind: "demographic",
        subject: { name: `age ${AGE_LABEL[bucket] ?? bucket}`, type: "age" },
        value: v,
        detail: Object.fromEntries(ages.map(([k, n]) => [k, n])),
      }),
    );
  }
  const genders = Object.entries(row.gender ?? {}).sort((a, b) => b[1] - a[1]);
  if (genders.length) {
    const [g, v] = genders[0];
    out.push(
      store.add({
        ...base(res, "/v2/insights", params, [comp.entityId]),
        kind: "demographic",
        subject: { name: `skews ${g}`, type: "gender" },
        value: v,
      }),
    );
  }
  return out;
}

// Qloo rejects take > 50 ("take must be an integer value between 1 and 50"); a country
// query still returns ~1,000 regional cells at that setting.
export async function fetchHeatmap(client: QlooClient, store: FactStore, comp: Comp, region: string, take = 50): Promise<Fact[]> {
  return heatmapFacts(client, store, comp.entityId, [comp.entityId], region, take);
}

/** Where the reference audience concentrates: the baseline that over-index is measured against. */
export async function fetchBaselineHeatmap(client: QlooClient, store: FactStore, baselineIds: string[], region: string): Promise<Fact[]> {
  return heatmapFacts(client, store, baselineIds.join(","), [], region, 50, true);
}

async function heatmapFacts(client: QlooClient, store: FactStore, signal: string, compIds: string[], region: string, take: number, baseline = false): Promise<Fact[]> {
  const r = REGIONS[region];
  if (!r) return [];
  const params = {
    "filter.type": "urn:heatmap",
    "signal.interests.entities": signal,
    "filter.location.query": r.locationQuery,
    take: String(take),
  };
  const res = await client.get("/v2/insights", params);
  const parsed = HeatmapResponse.safeParse(res.data);
  if (!parsed.success) return [];
  // Cell affinity is itself rank-normalised 0..1 and many cells tie at 1, so a city's
  // score is the mean over the cells near it, not the single best cell.
  const byCity = new Map<string, number[]>();
  for (const cell of parsed.data.results.heatmap) {
    const a = cell.query?.affinity;
    if (typeof a !== "number") continue;
    const city = nearestCity(cell.location.latitude, cell.location.longitude, r.country);
    if (!city) continue;
    byCity.set(city.name, [...(byCity.get(city.name) ?? []), a]);
  }
  return [...byCity.entries()].map(([name, vs]) =>
    store.add({
      ...base(res, "/v2/insights", params, compIds),
      kind: "heatmap",
      subject: { name, type: `city:${r.country}` },
      value: Math.round((vs.reduce((s, v) => s + v, 0) / vs.length) * 1000) / 1000,
      detail: { cells: vs.length, best_cell: Math.max(...vs), ...(baseline ? { baseline: 1 } : {}) },
    }),
  );
}

// ---------- lift scoring, genre pools, cross-comp affinity, similar titles ----------

type Target = { entityId: string; name: string; type?: string };

/**
 * Score named entities for one audience with filter.results.entities (verified live 2026-10-31).
 * `role` decides the fact: "comps" → affinity facts for all comps combined (detail.scored);
 * "baseline" → baseline facts for the reference audience.
 */
export async function scoreEntities(
  client: QlooClient,
  store: FactStore,
  args: { filterType: string; signalIds: string[]; targets: Target[]; compIds: string[]; role: "comps" | "baseline"; subjectType: string },
): Promise<Fact[]> {
  const out: Fact[] = [];
  const unique = [...new Map(args.targets.map((t) => [t.entityId, t])).values()];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const params = {
      "filter.type": args.filterType,
      "signal.interests.entities": args.signalIds.join(","),
      "filter.results.entities": chunk.map((t) => t.entityId).join(","),
      take: String(chunk.length),
    };
    const res = await client.get("/v2/insights", params);
    const parsed = EntitiesResponse.safeParse(res.data);
    if (!parsed.success) continue;
    const byId = new Map(chunk.map((t) => [t.entityId, t]));
    for (const e of parsed.data.results.entities) {
      const id = e.entity_id ?? e.id;
      const aff = e.affinity ?? e.query?.affinity;
      const t = id ? byId.get(id) : undefined;
      if (!t || typeof aff !== "number") continue;
      out.push(
        store.add({
          ...base(res, "/v2/insights", params, args.role === "comps" ? args.compIds : []),
          kind: args.role === "comps" ? "affinity" : "baseline",
          subject: { entityId: t.entityId, name: t.name, type: args.subjectType },
          value: Math.round(aff * 1000) / 1000,
          detail: args.role === "comps" ? { scored: 1 } : { baseline: 1 },
        }),
      );
    }
  }
  return out;
}

/**
 * Partners loved by fans of the comps' genre (signal.interests.tags), above a popularity floor that
 * drops the long-tail noise a tag signal returns. They join the candidate pool and are then scored
 * for the comps' own audience; the genre affinity itself is not evidence about the comps.
 */
export async function fetchGenrePool(client: QlooClient, store: FactStore, domain: Domain, genreTags: string[], take = 15): Promise<Fact[]> {
  if (!genreTags.length) return [];
  const params = {
    "filter.type": DOMAIN_URN[domain],
    "signal.interests.tags": genreTags.join(","),
    "filter.popularity.min": "0.8",
    take: String(take),
  };
  const res = await client.get("/v2/insights", params);
  const parsed = EntitiesResponse.safeParse(res.data);
  if (!parsed.success) return [];
  return parsed.data.results.entities
    .map((e) => ({ ...e, id: e.entity_id ?? e.id, aff: e.affinity ?? e.query?.affinity }))
    .filter((e): e is typeof e & { id: string; aff: number } => typeof e.aff === "number" && !!e.id)
    .map((e, i) =>
      store.add({
        ...base(res, "/v2/insights", params, []),
        kind: "affinity",
        subject: { entityId: e.id, name: e.name, type: domain },
        value: Math.round(e.aff * 1000) / 1000,
        detail: {
          rank: i + 1,
          source: "genre",
          ...(e.tags?.length ? { tags: e.tags.map((t) => t.name ?? "").filter(Boolean).join("|") } : {}),
        },
      }),
    );
}

/** Titles a comp's fans love most (same entity type as the comp), ranked. Feeds comp discovery and "#2 film for X fans". */
export async function fetchSimilar(client: QlooClient, store: FactStore, comp: Comp, take = 25): Promise<Fact[]> {
  const params = { "filter.type": ENTITY_TYPE_URN[comp.type], "signal.interests.entities": comp.entityId, take: String(take) };
  const res = await client.get("/v2/insights", params);
  const parsed = EntitiesResponse.safeParse(res.data);
  if (!parsed.success) return [];
  return parsed.data.results.entities
    .map((e) => ({ ...e, id: e.entity_id ?? e.id, aff: e.affinity ?? e.query?.affinity }))
    .filter((e): e is typeof e & { id: string; aff: number } => typeof e.aff === "number" && !!e.id && e.id !== comp.entityId)
    .map((e, i) =>
      store.add({
        ...base(res, "/v2/insights", params, [comp.entityId]),
        kind: "similar",
        subject: { entityId: e.id, name: e.name, type: comp.type },
        value: Math.round(e.aff * 1000) / 1000,
        detail: { rank: i + 1, ...(e.popularity !== undefined ? { popularity: Math.round(e.popularity * 1000) / 1000 } : {}) },
      }),
    );
}

/**
 * Titles matching the logline: each keyword is looked up as a Qloo media-genre tag, then titles of
 * the comps' type are ranked for that tag signal (popular ones only, to avoid long-tail noise).
 */
export async function fetchLoglineTitles(client: QlooClient, store: FactStore, keywords: string[], type: EntityType, take = 15): Promise<{ tags: string[]; facts: Fact[] }> {
  const tagIds: string[] = [];
  for (const k of keywords.slice(0, 3)) {
    const res = await client.get("/v2/tags", { "filter.query": k, "filter.tag.types": "urn:tag:genre:media", take: "3" });
    const parsed = TagsResponse.safeParse(res.data);
    const hit = parsed.success ? parsed.data.results.tags.find((t) => (t.tag_id ?? t.id ?? "").startsWith("urn:tag:genre:media:")) : undefined;
    const id = hit?.tag_id ?? hit?.id;
    if (id && !tagIds.includes(id)) tagIds.push(id);
  }
  if (!tagIds.length) return { tags: [], facts: [] };
  const params = { "filter.type": ENTITY_TYPE_URN[type], "signal.interests.tags": tagIds.join(","), "filter.popularity.min": "0.7", take: String(take) };
  const res = await client.get("/v2/insights", params);
  const parsed = EntitiesResponse.safeParse(res.data);
  if (!parsed.success) return { tags: tagIds, facts: [] };
  const facts = parsed.data.results.entities
    .map((e) => ({ ...e, id: e.entity_id ?? e.id, aff: e.affinity ?? e.query?.affinity }))
    .filter((e): e is typeof e & { id: string; aff: number } => typeof e.aff === "number" && !!e.id)
    .map((e, i) =>
      store.add({
        ...base(res, "/v2/insights", params, []),
        kind: "similar",
        subject: { entityId: e.id, name: e.name, type },
        value: Math.round(e.aff * 1000) / 1000,
        detail: { rank: i + 1, via: "logline", tags: tagIds.map((t) => t.split(":").pop()).join("|") },
      }),
    );
  return { tags: tagIds, facts };
}

/**
 * One audience or two: score the other comps (and control titles) inside one comp's audience, or
 * inside the reference audience when `signal` is the baseline. Targets are grouped by entity type
 * because filter.type must match them.
 */
export async function fetchCross(client: QlooClient, store: FactStore, signal: { comp?: Comp; baselineIds?: string[] }, targets: (Target & { type: EntityType; control?: boolean })[]): Promise<Fact[]> {
  const out: Fact[] = [];
  const byType = new Map<EntityType, typeof targets>();
  for (const t of targets) byType.set(t.type, [...(byType.get(t.type) ?? []), t]);
  for (const [type, ts] of byType) {
    const params = {
      "filter.type": ENTITY_TYPE_URN[type],
      "signal.interests.entities": signal.comp ? signal.comp.entityId : (signal.baselineIds ?? []).join(","),
      "filter.results.entities": ts.map((t) => t.entityId).join(","),
      take: String(ts.length),
    };
    if (!params["signal.interests.entities"]) continue;
    const res = await client.get("/v2/insights", params);
    const parsed = EntitiesResponse.safeParse(res.data);
    if (!parsed.success) continue;
    const byId = new Map(ts.map((t) => [t.entityId, t]));
    for (const e of parsed.data.results.entities) {
      const t = byId.get(e.entity_id ?? e.id ?? "");
      const aff = e.affinity ?? e.query?.affinity;
      if (!t || typeof aff !== "number") continue;
      out.push(
        store.add({
          ...base(res, "/v2/insights", params, signal.comp ? [signal.comp.entityId] : []),
          kind: "cross",
          subject: { entityId: t.entityId, name: t.name, type },
          value: Math.round(aff * 1000) / 1000,
          detail: { ...(signal.comp ? {} : { baseline: 1 }), ...(t.control ? { control: 1 } : {}) },
        }),
      );
    }
  }
  return out;
}

const COMPARE_PATH = "/v2/analysis/compare";

/**
 * Compare two comps' audiences. Returns null when Qloo has no results for the pair
 * (404 means "No results" on this endpoint) or the response shape is not recognised;
 * the caller then estimates overlap from shared tags. Never disables the endpoint
 * process-wide: one pair's empty result says nothing about the next pair.
 */
export async function compareAudiences(client: QlooClient, store: FactStore, a: Comp, b: Comp): Promise<Fact[] | null> {
  const params = {
    "a.signal.interests.entities": a.entityId,
    "b.signal.interests.entities": b.entityId,
    take: "20",
  };
  let res: QlooResponse;
  try {
    res = await client.get(COMPARE_PATH, params);
  } catch (e) {
    if (e instanceof QlooError && (e.status === 400 || e.status === 404)) return null;
    throw e;
  }
  const parsed = CompareResponse.safeParse(res.data);
  if (!parsed.success) return null;
  const items = parseCompare(parsed.data.results);
  if (!items.length) return null;
  return items.map((it) =>
    store.add({
      ...base(res, COMPARE_PATH, params, [a.entityId, b.entityId]),
      kind: "compare",
      subject: { entityId: it.id, name: it.name.replace(/[\s,;]+$/, "").trim(), type: "tag" },
      // a − b when both scores are known; otherwise the item's own score (or 1) and its group.
      value: it.delta ?? it.score ?? 1,
      detail: {
        group: it.group,
        ...(it.a !== undefined ? { a: it.a } : {}),
        ...(it.b !== undefined ? { b: it.b } : {}),
      },
    }),
  );
}
