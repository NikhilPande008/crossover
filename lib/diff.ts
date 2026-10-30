// Attributable diff between two runs (comp swap / refinement). Client-safe.

import type { RunResult } from "@/lib/types";

export type RunDiff = {
  marketsChanged: number;
  marketsTotal: number;
  partnersChanged: number;
  partnersTotal: number;
  leadBefore: string;
  leadAfter: string;
  leadChanged: boolean;
  added: { kind: "market" | "partner"; name: string; factIds: string[] }[];
  removed: { kind: "market" | "partner"; name: string }[];
  compsBefore: string[];
  compsAfter: string[];
};

function sets(r: RunResult) {
  const markets = new Map<string, string[]>();
  const partners = new Map<string, string[]>();
  for (const c of r.concepts) {
    for (const m of c.markets) markets.set(m.name, m.factIds);
    for (const p of c.partners) partners.set(p.name, p.factIds);
  }
  return { markets, partners };
}

export function diffRuns(before: RunResult, after: RunResult): RunDiff {
  const a = sets(before);
  const b = sets(after);
  const added: RunDiff["added"] = [];
  const removed: RunDiff["removed"] = [];
  for (const [n, ids] of b.markets) if (!a.markets.has(n)) added.push({ kind: "market", name: n, factIds: ids });
  for (const [n, ids] of b.partners) if (!a.partners.has(n)) added.push({ kind: "partner", name: n, factIds: ids });
  for (const n of a.markets.keys()) if (!b.markets.has(n)) removed.push({ kind: "market", name: n });
  for (const n of a.partners.keys()) if (!b.partners.has(n)) removed.push({ kind: "partner", name: n });
  const lead = (r: RunResult) => r.concepts.find((c) => c.id === r.decision.recommendedId);
  const lb = lead(before);
  const la = lead(after);
  return {
    marketsChanged: added.filter((x) => x.kind === "market").length,
    marketsTotal: b.markets.size,
    partnersChanged: added.filter((x) => x.kind === "partner").length,
    partnersTotal: b.partners.size,
    leadBefore: lb ? `${lb.name} (${lb.lever})` : "—",
    leadAfter: la ? `${la.name} (${la.lever})` : "—",
    leadChanged: lb?.lever !== la?.lever || lb?.name !== la?.name,
    added,
    removed,
    compsBefore: before.comps.map((c) => c.name),
    compsAfter: after.comps.map((c) => c.name),
  };
}
