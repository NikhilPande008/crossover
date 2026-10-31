// "Without Qloo" arm: same brief, same model, no tools. Its named partners are
// then fact-checked against Qloo by the same code used everywhere else.

import { z } from "zod";
import type { ArmScore, BaselineCheck, BaselineResult, Domain, RunResult } from "@/lib/types";
import { getLLM, noteLLM } from "@/lib/llm/provider";
import { describeLLMError } from "@/lib/llm/budget";
import { UsageMeter, formatUsage } from "@/lib/llm/usage";
import { BASELINE_SYSTEM, briefBlock } from "@/lib/agent/prompts";
import { QlooClient, belowQuotaFloor } from "@/lib/qloo/client";
import { scoreEntities, searchEntities } from "@/lib/qloo/api";
import { DOMAIN_URN } from "@/lib/qloo/params";
import { reference } from "@/lib/qloo/baselines";
import { FactStore } from "@/lib/facts/store";
import type { EntityType } from "@/lib/types";

const BaselineOut = z.object({
  concepts: z.array(
    z.object({
      name: z.string(),
      markets: z.array(z.string()),
      partners: z.array(z.object({ name: z.string(), domain: z.enum(["podcast", "artist", "tv_show", "movie", "book", "brand"]) })),
      angle: z.string(),
    }),
  ),
});

const SEARCHABLE: Record<string, EntityType> = { podcast: "podcast", artist: "artist", tv_show: "tv_show", movie: "movie", book: "book", brand: "brand" };

export async function runBaseline(run: RunResult): Promise<BaselineResult> {
  const llm = getLLM();
  if (!llm) return { concepts: [], checks: [], verifiability: 0, grounding: 0, error: "Baseline unavailable: no language model configured." };
  let out: z.infer<typeof BaselineOut>;
  const meter = new UsageMeter();
  try {
    out = await llm.structured({
      system: BASELINE_SYSTEM,
      user: `${briefBlock(run.brief, run.comps)}\n\nPropose three campaign concepts.`,
      schema: BaselineOut,
      effort: "medium",
      meter,
      phase: "baseline",
      // Leaves time for the Qloo fact-check inside the route's 120 s limit.
      deadline: Date.now() + 80_000,
    });
  } catch (e) {
    noteLLM(false, e);
    return { concepts: [], checks: [], verifiability: 0, grounding: 0, error: `Baseline unavailable: ${describeLLMError(e)}`, llmUsage: meter.summary() };
  }
  const llmUsage = meter.summary();
  console.info(`[llm-usage] baseline run=${run.runId} ${llmUsage.provider} ${llmUsage.models.join(",")} ${formatUsage(llmUsage)}`);

  // Fact-check: does each partner resolve in Qloo, and how much do these comps' fans like it
  // compared with a typical audience? Crossover's own partners are scored the same way, so the
  // two arms are compared on one scale. Recorded runs are served precisely when live quota must be
  // protected, so they never trigger fresh Qloo lookups; neither does any run below the quota floor.
  const searchAllowed = run.mode === "fixture" || (run.mode === "live" && !belowQuotaFloor());
  const client = new QlooClient({ maxCalls: searchAllowed ? 40 : 0, mode: run.mode === "fixture" ? "fixture" : "live" });
  const evidence = new Map<string, number>();
  for (const f of run.facts) if (f.kind === "affinity" && typeof f.value === "number" && f.compIds.length) evidence.set((f.subject?.name ?? "").toLowerCase(), Math.max(evidence.get((f.subject?.name ?? "").toLowerCase()) ?? 0, f.value));
  const partners = out.concepts.flatMap((c) => c.partners);
  const unique = [...new Map(partners.map((p) => [p.name.toLowerCase(), p])).values()].slice(0, 24);
  const checks: BaselineCheck[] = await Promise.all(
    unique.map(async (p) => {
      const key = p.name.toLowerCase();
      const inEvidence = evidence.has(key);
      const type = SEARCHABLE[p.domain];
      let resolved = false;
      let entityId: string | undefined;
      if (type && searchAllowed && client.remaining > 0) {
        const hits = await searchEntities(client, p.name, [type], 3).catch(() => []);
        const hit = hits.find((h) => h.name.toLowerCase() === key);
        resolved = Boolean(hit);
        entityId = hit?.entityId;
      }
      return { name: p.name, domain: p.domain, resolved: resolved || inEvidence, entityId, inCrossoverEvidence: inEvidence };
    }),
  );

  // Lift for both arms: one comps-audience call and one reference-audience call per domain.
  const crossoverPartners = run.concepts.flatMap((c) => c.partners);
  const runPartner = new Map(Object.values(run.audience.partners).flat().map((p) => [p.name.toLowerCase(), p]));
  let modelArm: ArmScore | undefined;
  let crossoverArm: ArmScore | undefined;
  if (searchAllowed) {
    try {
      const ref = await reference(client, run.brief.format, run.comps.map((c) => c.entityId));
      const store = new FactStore();
      const domains = [...new Set(checks.filter((c) => c.entityId).map((c) => c.domain))] as Domain[];
      for (const d of domains) {
        const targets = checks.filter((c) => c.domain === d && c.entityId).map((c) => ({ entityId: c.entityId!, name: c.name }));
        const args = { filterType: DOMAIN_URN[d], targets, subjectType: d };
        const [comps, base] = await Promise.all([
          scoreEntities(client, store, { ...args, signalIds: run.comps.map((c) => c.entityId), compIds: run.comps.map((c) => c.entityId), role: "comps" }),
          ref.audience.length ? scoreEntities(client, store, { ...args, signalIds: ref.audience.map((r) => r.entityId), compIds: [], role: "baseline" }) : Promise.resolve([]),
        ]);
        for (const c of checks.filter((x) => x.domain === d && x.entityId)) {
          const a = comps.find((f) => f.subject?.entityId === c.entityId)?.value;
          const b = base.find((f) => f.subject?.entityId === c.entityId)?.value;
          if (typeof a === "number") c.affinity = a;
          if (typeof b === "number") c.baseline = b;
          if (typeof a === "number" && typeof b === "number") c.lift = Math.round((a - b) * 1000) / 1000;
        }
      }
      modelArm = arm(checks.map((c) => c.lift));
      crossoverArm = arm([...new Set(crossoverPartners.map((p) => p.name.toLowerCase()))].map((n) => runPartner.get(n)?.lift));
    } catch {
      // Lift scoring is a bonus on top of the existence check; keep the check if it fails.
    }
  }
  const pct = new Map(run.audience.markets.map((m) => [m.name.toLowerCase(), m.concentration ?? m.score]));
  const markets = [...new Set(out.concepts.flatMap((c) => c.markets))].map((name) => ({ name, percentile: pct.get(name.toLowerCase()) }));
  const n = checks.length || 1;
  return {
    concepts: out.concepts.slice(0, 3).map((c) => ({ ...c, partners: c.partners })),
    checks,
    verifiability: checks.filter((c) => c.resolved).length / n,
    grounding: checks.filter((c) => c.inCrossoverEvidence).length / n,
    modelArm,
    crossoverArm,
    markets,
    llmUsage,
    ...(searchAllowed ? {} : { note: "Qloo lookups skipped to protect quota; only matches against this run's evidence were checked." }),
  };
}

function arm(lifts: (number | undefined)[]): ArmScore {
  const xs = lifts.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
  return { scored: xs.length, positive: xs.filter((x) => x > 0).length, medianLift: xs.length ? Math.round(xs[Math.floor(xs.length / 2)] * 1000) / 1000 : null };
}
