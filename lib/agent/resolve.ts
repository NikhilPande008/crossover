// Comp resolution: comp names → Qloo entity candidates, before any expensive calls.

import type { Comp, EntityType } from "@/lib/types";
import { QlooClient } from "@/lib/qloo/client";
import { searchEntities, type Candidate } from "@/lib/qloo/api";

export type Resolution = { query: string; candidates: Candidate[] };

export const TYPES_FOR_FORMAT: Record<string, EntityType[]> = {
  film: ["movie", "tv_show"],
  series: ["tv_show", "movie"],
  album: ["artist"],
  tour: ["artist", "person"],
  // Comedians are people in Qloo (Ali Wong, John Mulaney); specials are sometimes shows.
  special: ["person", "tv_show"],
};

export async function resolveComps(client: QlooClient, names: string[], types: EntityType[]): Promise<Resolution[]> {
  return Promise.all(
    names.map(async (query) => ({
      query,
      candidates: await searchEntities(client, query, types, 5).catch(() => []),
    })),
  );
}

/** Pick the best candidate: exact (case-insensitive) name match first, else top result. */
export function bestCandidate(r: Resolution): Comp | undefined {
  const exact = r.candidates.find((c) => c.name.toLowerCase() === r.query.toLowerCase());
  const c = exact ?? r.candidates[0];
  return c && { name: c.name, entityId: c.entityId, type: c.type, year: c.year, descriptor: c.descriptor, genres: c.genres };
}
