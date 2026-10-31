// Comp audit: which comp to lead with, and whether a title the comps' fans love should be
// added or a weakly anchored comp dropped. Code computes a default from the cross-affinity
// and similar-titles evidence; the research agent may override it (recommend_comps), but
// only with titles from that evidence.

import type { AudienceMap, Comp, CompAdvice, Fact } from "@/lib/types";
import { THRESHOLDS } from "@/lib/thresholds";
import type { Reference } from "@/lib/qloo/baselines";
import type { CompAdviceDraft } from "./tools";

const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n * 100))}`;

/** Mean mutual lift of a comp with the others: how central it is to the comp set. */
function centrality(audience: AudienceMap, c: Comp): number | undefined {
  const ls = audience.overlaps.filter((o) => o.a === c.entityId || o.b === c.entityId).map((o) => o.mutualLift);
  const known = ls.filter((x): x is number => x !== undefined);
  return known.length ? known.reduce((s, x) => s + x, 0) / known.length : undefined;
}

export function codeAdvice(audience: AudienceMap, comps: Comp[], facts: Fact[], ref: Reference): CompAdvice | undefined {
  if (comps.length < 2) return undefined;
  const scored = comps.map((c) => ({ c, v: centrality(audience, c) }));
  if (scored.every((x) => x.v === undefined)) return undefined;
  const lead = [...scored].sort((a, b) => (b.v ?? -1) - (a.v ?? -1))[0];
  const others = comps.filter((c) => c !== lead.c);
  const leadReason =
    `${lead.c.name} is the comp the others' fans like most (mean lift ${pct(lead.v ?? 0)} points over a typical audience)` +
    (others.length ? `, so it anchors ${others.map((c) => c.name).join(" and ")} best.` : ".");

  // Drop: with three or more comps, one whose fans barely like any other comp.
  let drop: CompAdvice["drop"];
  if (comps.length >= 3) {
    const weakest = [...scored].sort((a, b) => (a.v ?? 1) - (b.v ?? 1))[0];
    const pairs = audience.overlaps.filter((o) => o.a === weakest.c.entityId || o.b === weakest.c.entityId);
    if (weakest.c !== lead.c && pairs.length && pairs.every((o) => (o.mutualLift ?? 1) < THRESHOLDS.adjacentLift))
      drop = {
        compId: weakest.c.entityId,
        reason: `${weakest.c.name}'s fans and the other comps' fans barely overlap (mutual lift under ${Math.round(THRESHOLDS.adjacentLift * 100)} points for every pair), so it pulls the plan toward a different audience.`,
        factIds: pairs.flatMap((o) => o.factIds.slice(0, 2)),
      };
  }

  // Add: a title in at least two comps' "fans also love" lists (or the top one for a single list), not a comp or reference title.
  const skip = new Set([...comps.map((c) => c.entityId), ...ref.audience.map((r) => r.entityId), ...ref.controls.map((r) => r.entityId)]);
  const sim = facts.filter((f) => f.kind === "similar" && f.subject?.entityId && !skip.has(f.subject.entityId) && !f.detail?.via);
  const byId = new Map<string, Fact[]>();
  for (const f of sim) byId.set(f.subject!.entityId!, [...(byId.get(f.subject!.entityId!) ?? []), f]);
  const ranked = [...byId.values()]
    .filter((fs) => Number(fs[0].detail?.popularity ?? 1) >= 0.5)
    .map((fs) => ({ fs, n: new Set(fs.map((f) => f.compIds[0])).size, best: Math.min(...fs.map((f) => Number(f.detail?.rank ?? 99))) }))
    .sort((a, b) => b.n - a.n || a.best - b.best);
  const top = ranked.find((r) => r.n >= Math.min(2, comps.length));
  let add: CompAdvice["add"];
  if (top) {
    const f = top.fs[0];
    const where = top.fs
      .map((x) => `#${x.detail?.rank} for ${comps.find((c) => c.entityId === x.compIds[0])?.name} fans`)
      .slice(0, 3)
      .join(", ");
    add = { name: f.subject!.name, entityId: f.subject!.entityId!, type: comps[0].type, factIds: top.fs.map((x) => x.id), reason: `${f.subject!.name} ranks ${where}; consider it as a comp.` };
  }
  return { lead: lead.c.entityId, leadReason, add, drop, by: "code" };
}

/** Merge the agent's verdict into the code default. The agent's add must be a title from the evidence. */
export function mergeAdvice(code: CompAdvice | undefined, agent: CompAdviceDraft | undefined, comps: Comp[], facts: Fact[], reasonOk: (t: string) => boolean): CompAdvice | undefined {
  if (!agent) return code;
  const leadComp = comps.find((c) => c.entityId === agent.lead);
  if (!leadComp) return code;
  const sim = agent.add ? facts.filter((f) => f.kind === "similar" && f.subject?.name.toLowerCase() === agent.add!.toLowerCase()) : [];
  const add: CompAdvice["add"] = sim.length
    ? { name: sim[0].subject!.name, entityId: sim[0].subject!.entityId!, type: comps[0].type, factIds: sim.map((f) => f.id), reason: code?.add && code.add.entityId === sim[0].subject!.entityId ? code.add.reason : `${sim[0].subject!.name} is in the comps' similar-titles evidence.` }
    : agent.add
      ? undefined
      : code?.add;
  const dropComp = comps.find((c) => c.entityId === agent.drop);
  const reason = agent.reason && reasonOk(agent.reason) ? agent.reason : code?.leadReason ?? `Lead with ${leadComp.name}.`;
  return {
    lead: leadComp.entityId,
    leadReason: reason,
    add,
    drop: dropComp ? { compId: dropComp.entityId, reason: code?.drop?.compId === dropComp.entityId ? code.drop.reason : reason, factIds: code?.drop?.factIds ?? [] } : undefined,
    by: "agent",
  };
}
