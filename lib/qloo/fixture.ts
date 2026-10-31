// Synthetic fixture backend. Every entity here is INVENTED and is not Qloo data.
// Responses mimic the response shapes observed from the hackathon host so the rest
// of the pipeline runs unchanged without a key. Values come from a seeded latent
// model so that different comps produce coherently different audiences.

import { CITIES, REGIONS } from "@/lib/geo/cities";
import type { QlooRequest } from "./client";

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIMS = 5;
function latent(key: string): number[] {
  const r = rng(fnv1a(key));
  return Array.from({ length: DIMS }, () => r() * 2 - 1);
}

function dot(a: number[], b: number[]) {
  return a.reduce((s, x, i) => s + x * b[i], 0);
}

function mean(vs: number[][]): number[] {
  return Array.from({ length: DIMS }, (_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
}

function affinity(signal: number[], target: string, salt = ""): number {
  const noise = rng(fnv1a(target + salt))() * 0.08;
  const raw = 0.5 + 0.5 * Math.tanh(dot(signal, latent(target)) * 0.9);
  return Math.round(Math.min(0.99, Math.max(0.01, raw * 0.92 + noise)) * 1000) / 1000;
}

export const SYNTHETIC_POOLS: Record<string, { name: string; tags?: string[] }[]> = {
  "urn:entity:podcast": [
    "Static Between Stations", "The Hollow Hour", "Small Town Ghosts", "Second Act Cinema", "Mixtape Confessions",
    "Late Bloomers", "The Slow Burn Club", "Field Notes on Dread", "Coming Up For Air", "Teenage Archive",
    "The Long Take", "Night Shift Radio", "Folklore Hours", "Kitchen Table Stories", "Basement Tapes Weekly",
    "Margin Notes", "The Rewatch Room", "Unquiet Places",
  ].map((name) => ({ name })),
  "urn:entity:artist": [
    "Marrow Lake", "Juniper Vale", "The Paper Moths", "Ivy Calder", "Night Orchard", "Lowtide Choir", "Sable Hart",
    "Glass Antlers", "Wren & Ash", "Pale Coast", "June Harbor", "The Quiet Arcade", "Velvet Mile", "Oren Blythe",
    "Saint Tamsin", "Copper Fields",
  ].map((name) => ({ name })),
  "urn:entity:tv_show": [
    "Fenwick County", "The Lantern House", "Hometown Static", "Sixth Period", "Blackwater Lane", "The Understudies",
    "Northbound", "Sister Planets", "Low Tide Motel", "The Cartographers", "Grey Fen", "Overtime",
  ].map((name) => ({ name })),
  "urn:entity:movie": [
    "Ember Season", "The Orchard Keeper's Daughter", "Low Light", "Summer of Small Fires", "The Weight of Rooms",
    "Pilgrim Road", "A Quiet Coast", "The Last Drive-In", "Moth Season", "Hollow Ground",
  ].map((name) => ({ name })),
  "urn:entity:book": [
    "A House With Thin Walls", "The Driftwood Year", "Salt and Static", "Letters to the Lake", "The Bone Orchard",
    "Small Hours", "Everything We Kept", "The Fog Index",
  ].map((name) => ({ name })),
  "urn:entity:person": [
    "Dot Halloran", "Benji Akers", "Mara Velez", "Theo Quint", "Priya Lockett", "Sully Barnes", "June Okafor", "Remy Castillo",
    "Hattie Moss", "Ollie Strand",
  ].map((name) => ({ name })),
  "urn:entity:brand": [
    { name: "Thornfield Coffee Co.", tags: ["coffee"] },
    { name: "Lumen Outfitters", tags: ["apparel"] },
    { name: "Parcel & Pine", tags: ["home"] },
    { name: "Kestrel Audio", tags: ["electronics"] },
    { name: "Hollowbrook Cider", tags: ["alcohol"] },
    { name: "Saltmarsh Apparel", tags: ["apparel"] },
    { name: "Arcadia Bookshops", tags: ["books"] },
    { name: "Gridline Sneakers", tags: ["footwear"] },
    { name: "Moth & Flame Candles", tags: ["home"] },
    { name: "Ferrous Brewing", tags: ["alcohol"] },
    { name: "Northwind Rail", tags: ["travel"] },
    { name: "Quillmark Stationery", tags: ["stationery"] },
  ],
};

const SYNTHETIC_TAGS = [
  "slow burn", "coming of age", "folk horror", "grief", "small town", "female friendship", "dark humor", "nostalgia",
  "indie folk", "dread", "family drama", "cult", "awkward comedy", "first love", "ritual", "atmospheric",
  "suburban ennui", "unreliable narrator", "found family", "road trip",
];

const SYNTHETIC_GENRES = ["horror", "comedy", "drama", "coming_of_age", "folk", "satire"];

const AGE_BUCKETS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];

function synId(prefix: string, name: string) {
  return `syn-${prefix}-${fnv1a(name).toString(16)}`;
}

/** Entity IDs for synthetic comps embed their name so the latent model is reproducible. */
function compVectors(ids: string): number[][] {
  return ids
    .split(",")
    .filter(Boolean)
    .map((id) => latent(id));
}

const NOT_FOUND = /fake|made.?up|asdf|qwerty|notarealtitle|xyzzy/i;

export function fixtureResponse(req: QlooRequest): unknown {
  const p = req.params;
  if (req.path === "/search") {
    const q = (p.query ?? "").trim();
    if (!q || NOT_FOUND.test(q) || !/[aeiouy]/i.test(q)) return { results: [] };
    const type = (p.types ?? "urn:entity:movie").split(",")[0];
    const r = rng(fnv1a(q.toLowerCase()));
    const year = 1995 + Math.floor(r() * 29);
    const g1 = SYNTHETIC_GENRES[Math.floor(r() * SYNTHETIC_GENRES.length)];
    const g2 = SYNTHETIC_GENRES[(SYNTHETIC_GENRES.indexOf(g1) + 1) % SYNTHETIC_GENRES.length];
    const tags = [g1, g2].map((g) => ({ tag_id: `urn:tag:genre:media:syn_${g}`, name: g, type: "urn:tag:genre:media" }));
    const base = { types: [type], popularity: Math.round(r() * 1000) / 1000, tags };
    return {
      results: [
        { ...base, entity_id: synId("comp", q.toLowerCase()), name: q, properties: { release_year: year, short_description: "Synthetic fixture entity" } },
        { ...base, entity_id: synId("comp", q.toLowerCase() + " (remake)"), name: `${q} (remake)`, properties: { release_year: year + 17, short_description: "Synthetic fixture entity" } },
        { ...base, entity_id: synId("comp", q.toLowerCase() + " ii"), name: `${q} II`, properties: { release_year: year + 3, short_description: "Synthetic fixture entity" } },
      ].slice(0, Number(p.take ?? 3)),
    };
  }

  if (req.path === "/v2/tags") {
    const q = (p["filter.query"] ?? "").toLowerCase();
    if ((p["filter.tag.types"] ?? "").includes("genre:media"))
      return { results: { tags: SYNTHETIC_GENRES.filter((g) => q.includes(g) || g.includes(q.split(" ")[0] ?? "")).map((g) => ({ id: `urn:tag:genre:media:syn_${g}`, name: g })) } };
    const brandTags = new Set(SYNTHETIC_POOLS["urn:entity:brand"].flatMap((b) => b.tags ?? []));
    const hits = [...brandTags].filter((t) => q.includes(t) || t.includes(q));
    return { results: { tags: (hits.length ? hits : [...brandTags].slice(0, 1)).map((t) => ({ id: `syn-tag-${t}`, name: t })) } };
  }

  if (req.path === "/v2/analysis/compare") {
    // Mirrors the live shape seen 2026-10-25: results.tags = shared tags with a score;
    // results.a / results.b = each side's tags (including the shared ones).
    const aIds = p["a.signal.interests.entities"] ?? "";
    const bIds = p["b.signal.interests.entities"] ?? "";
    const a = mean(compVectors(aIds));
    const b = mean(compVectors(bIds));
    const rows = SYNTHETIC_TAGS.map((t) => ({ t, aa: affinity(a, t, "tag"), bb: affinity(b, t, "tag") }));
    const tag = (r: (typeof rows)[number], query: Record<string, unknown>) => ({ tag_id: `urn:tag:keyword:qloo:syn-${r.t}`, name: r.t, type: "urn:tag", subtype: "urn:tag:keyword:qloo", popularity: 0.5, query });
    const sideA = rows.filter((r) => r.aa >= 0.5);
    const sideB = rows.filter((r) => r.bb >= 0.5);
    const shared = sideA.filter((r) => r.bb >= 0.5).sort((x, y) => Math.min(y.aa, y.bb) - Math.min(x.aa, x.bb));
    const sig = (ids: string) => ids.split(",").filter(Boolean).map((entity_id) => ({ entity_id }));
    return {
      duration: 1,
      results: {
        tags: shared.slice(0, 3).map((r) => tag(r, { score: Math.round(Math.min(r.aa, r.bb) * 1000) / 1000, "a.signal.interests.entities": sig(aIds), "b.signal.interests.entities": sig(bIds) })),
        a: sideA.map((r) => tag(r, { count: "1" })),
        b: sideB.map((r) => tag(r, { count: "1" })),
        matchEntities: [],
      },
    };
  }

  if (req.path === "/v2/insights") {
    const type = p["filter.type"];
    const vecs = [...compVectors(p["signal.interests.entities"] ?? ""), ...compVectors(p["signal.interests.tags"] ?? "")];
    if (!vecs.length) return { success: false, results: {} };
    const signal = mean(vecs);
    const take = Number(p.take ?? 10);

    if (type === "urn:tag") {
      const tags = SYNTHETIC_TAGS.map((t) => ({ tag_id: `urn:tag:keyword:qloo:syn-${t}`, name: t, type: "urn:tag:keyword", query: { affinity: affinity(signal, t, "tag") } }))
        .sort((x, y) => y.query.affinity - x.query.affinity)
        .slice(0, take);
      return { success: true, results: { tags } };
    }

    if (type === "urn:demographics") {
      return {
        success: true,
        results: {
          demographics: vecs.map((_, i) => {
            const id = (p["signal.interests.entities"] ?? "").split(",")[i];
            const age = Object.fromEntries(AGE_BUCKETS.map((bk) => [bk, Math.round((affinity(signal, bk, "age") - 0.5) * 100) / 100]));
            const g = Math.round((affinity(signal, "gender", "g") - 0.5) * 100) / 100;
            return { entity_id: id, query: { age, gender: { male: -g, female: g } } };
          }),
        },
      };
    }

    if (type === "urn:heatmap") {
      const region = Object.values(REGIONS).find((r) => r.locationQuery === p["filter.location.query"]);
      const cities = CITIES.filter((c) => !region || c.country === region.country);
      const cells = cities
        .map((c) => {
          const a = affinity(signal, c.name, "geo");
          return { location: { latitude: c.lat + 0.01, longitude: c.lon - 0.01, geohash: synId("gh", c.name) }, query: { affinity: a, popularity: Math.round(rng(fnv1a(c.name))() * 1000) / 1000 } };
        })
        .sort((x, y) => y.query.affinity - x.query.affinity)
        // affinity_rank is rank-normalised 0..1 (1 = strongest), as in the heatmaps docs.
        .map((cell, i, all) => ({ ...cell, query: { ...cell.query, affinity_rank: Math.round((1 - i / Math.max(1, all.length - 1)) * 1000) / 1000 } }));
      return { success: true, results: { heatmap: cells.slice(0, take) } };
    }

    const pool = SYNTHETIC_POOLS[type];
    if (!pool) return { success: false, error: { message: `Unsupported filter.type ${type}` } };
    // filter.results.entities: score exactly these entities (pool items by ID, anything else by its ID).
    const only = (p["filter.results.entities"] ?? "").split(",").filter(Boolean);
    if (only.length) {
      const byId = new Map(pool.map((e) => [synId(type.split(":").pop()!, e.name), e.name]));
      return {
        success: true,
        results: {
          entities: only.map((id) => ({ entity_id: id, name: byId.get(id) ?? id, types: [type], popularity: 0.5, query: { affinity: affinity(signal, byId.get(id) ?? id) } })),
        },
      };
    }
    const minPop = Number(p["filter.popularity.min"] ?? 0);
    const excluded = new Set((p["filter.exclude.entities"] ?? "").split(",").filter(Boolean));
    const entities = pool
      .map((e) => ({
        entity_id: synId(type.split(":").pop()!, e.name),
        name: e.name,
        types: [type],
        tags: (e.tags ?? []).map((t) => ({ tag_id: `urn:tag:keyword:qloo:syn-${t}`, name: t })),
        popularity: Math.round(rng(fnv1a(e.name + "pop"))() * 1000) / 1000,
        query: { affinity: affinity(signal, e.name) },
      }))
      .filter((e) => !excluded.has(e.entity_id) && e.popularity >= minPop)
      .sort((x, y) => y.query.affinity - x.query.affinity)
      .slice(0, take);
    return { success: true, results: { entities } };
  }

  return { success: false, error: { message: `Unknown fixture path ${req.path}` } };
}
