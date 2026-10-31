// Loose zod shapes of Qloo responses. Unverified against official docs: shapes
// follow what 2026 entrants observed on the hackathon host. passthrough() keeps
// unknown fields; anything we read is optional and checked at use.

import { z } from "zod";

const num = z.coerce.number();

export const SearchResponse = z.looseObject({
  results: z
    .array(
      z.looseObject({
        entity_id: z.string(),
        name: z.string(),
        types: z.array(z.string()).optional(),
        type: z.string().optional(),
        popularity: num.optional(),
        tags: z.array(z.looseObject({ tag_id: z.string().optional(), id: z.string().optional() })).optional(),
        properties: z
          .looseObject({
            release_year: num.optional(),
            year: num.optional(),
            short_description: z.string().optional(),
            description: z.string().optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

const Query = z.looseObject({ affinity: num.optional(), affinity_rank: num.optional(), popularity: num.optional() });

export const EntitiesResponse = z.looseObject({
  results: z
    .looseObject({
      entities: z
        .array(
          z.looseObject({
            // The harness accepts either key; affinity may be top-level or under query.
            entity_id: z.string().optional(),
            id: z.string().optional(),
            name: z.string(),
            types: z.array(z.string()).optional(),
            popularity: num.optional(),
            affinity: num.optional(),
            tags: z.array(z.looseObject({ tag_id: z.string().optional(), id: z.string().optional(), name: z.string().optional() })).optional(),
            query: Query.optional(),
          }),
        )
        .default([]),
    })
    .default({ entities: [] }),
});

export const TagsResponse = z.looseObject({
  results: z
    .looseObject({
      tags: z
        .array(
          z.looseObject({
            tag_id: z.string().optional(),
            id: z.string().optional(),
            name: z.string(),
            type: z.string().optional(),
            subtype: z.string().optional(),
            affinity: num.optional(),
            query: Query.optional(),
          }),
        )
        .default([]),
    })
    .default({ tags: [] }),
});

export const DemographicsResponse = z.looseObject({
  results: z
    .looseObject({
      demographics: z
        .array(
          z.looseObject({
            entity_id: z.string().optional(),
            query: z
              .looseObject({
                age: z.record(z.string(), num).optional(),
                gender: z.record(z.string(), num).optional(),
              })
              .optional(),
          }),
        )
        .default([]),
    })
    .default({ demographics: [] }),
});

export const HeatmapResponse = z.looseObject({
  results: z
    .looseObject({
      heatmap: z
        .array(
          z.looseObject({
            location: z.looseObject({ latitude: num, longitude: num, geohash: z.string().optional() }),
            query: Query.optional(),
          }),
        )
        .default([]),
    })
    .default({ heatmap: [] }),
});

// /v2/analysis/compare: `results` is an array whose items are one of several
// undocumented schemas (docs reference Common.yml, UniqueTo*.yml). Parsed tolerantly
// in lib/qloo/compare.ts; confirm the real shape with `npm run api-test`.
export const CompareResponse = z.looseObject({ results: z.unknown() });
