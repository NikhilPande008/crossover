// Reference audiences and control titles, per release format.
//  - The reference audience ("a typical moviegoer") is the baseline for lift: a partner,
//    city or comp only counts as specific to these comps if their fans like it more than
//    this broad audience does. Probed live 2026-10-31: Hereditary's top brands share 29 of
//    50 with Barbie + Avengers: Endgame fans', so raw affinity is mostly popularity.
//  - Control titles are broad hits scored inside each comp's audience next to the other
//    comps; their lift should sit near zero, which calibrates the one-audience verdict.
// Titles are names only; IDs are resolved through Qloo search and cached.

import type { EntityType, Format } from "@/lib/types";
import type { QlooClient } from "./client";
import { searchEntities } from "./api";
import { kv } from "@/lib/store/kv";

type Ref = { name: string; type: EntityType };

const REFERENCE: Record<Format, { audience: Ref[]; controls: Ref[] }> = {
  film: {
    audience: [
      { name: "Avengers: Endgame", type: "movie" },
      { name: "Barbie", type: "movie" },
    ],
    controls: [
      { name: "Paddington 2", type: "movie" },
      { name: "Top Gun: Maverick", type: "movie" },
    ],
  },
  series: {
    audience: [
      { name: "Friends", type: "tv_show" },
      { name: "The Big Bang Theory", type: "tv_show" },
    ],
    controls: [
      { name: "Grey's Anatomy", type: "tv_show" },
      { name: "Yellowstone", type: "tv_show" },
    ],
  },
  album: {
    audience: [
      { name: "Taylor Swift", type: "artist" },
      { name: "Ed Sheeran", type: "artist" },
    ],
    controls: [
      { name: "Luke Combs", type: "artist" },
      { name: "Bad Bunny", type: "artist" },
    ],
  },
  tour: {
    audience: [
      { name: "Taylor Swift", type: "artist" },
      { name: "Ed Sheeran", type: "artist" },
    ],
    controls: [
      { name: "Luke Combs", type: "artist" },
      { name: "Bad Bunny", type: "artist" },
    ],
  },
  special: {
    audience: [
      { name: "Kevin Hart", type: "person" },
      { name: "Adam Sandler", type: "person" },
    ],
    controls: [
      { name: "Jeff Foxworthy", type: "person" },
      { name: "Gabriel Iglesias", type: "person" },
    ],
  },
};

export type ResolvedRef = { entityId: string; name: string; type: EntityType };
export type Reference = { audience: ResolvedRef[]; controls: ResolvedRef[] };

async function resolve(client: QlooClient, refs: Ref[], mode: string): Promise<ResolvedRef[]> {
  const out: ResolvedRef[] = [];
  for (const r of refs) {
    const key = `ref:${mode}:${r.type}:${r.name}`;
    let hit = await kv.get<ResolvedRef>(key);
    if (!hit) {
      const cands = await searchEntities(client, r.name, [r.type], 3).catch(() => []);
      const c = cands.find((x) => x.name.toLowerCase() === r.name.toLowerCase()) ?? cands[0];
      if (c) {
        hit = { entityId: c.entityId, name: c.name, type: r.type };
        await kv.set(key, hit, 7 * 24 * 3600);
      }
    }
    if (hit) out.push(hit);
  }
  return out;
}

/** The reference audience and controls for a format, excluding any title that is itself a comp. */
export async function reference(client: QlooClient, format: Format, compIds: string[]): Promise<Reference> {
  const ref = REFERENCE[format] ?? REFERENCE.film;
  const [audience, controls] = await Promise.all([resolve(client, ref.audience, client.mode), resolve(client, ref.controls, client.mode)]);
  const notComp = (r: ResolvedRef) => !compIds.includes(r.entityId);
  return { audience: audience.filter(notComp), controls: controls.filter(notComp) };
}

export function referenceLabel(format: Format): string {
  return { film: "a typical moviegoer", series: "a typical TV viewer", album: "a typical music fan", tour: "a typical music fan", special: "a typical comedy fan" }[format] ?? "a typical audience";
}
