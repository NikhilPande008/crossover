// "Without Qloo" arm: same brief, same model, no tools. Its named partners are
// then fact-checked against Qloo by the same code used everywhere else.

import { z } from "zod";
import type { BaselineCheck, BaselineResult, RunResult } from "@/lib/types";
import { getLLM, noteLLM } from "@/lib/llm/provider";
import { describeLLMError } from "@/lib/llm/budget";
import { UsageMeter, formatUsage } from "@/lib/llm/usage";
import { BASELINE_SYSTEM, briefBlock } from "@/lib/agent/prompts";
import { QlooClient, belowQuotaFloor } from "@/lib/qloo/client";
import { searchEntities } from "@/lib/qloo/api";
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

  // Fact-check: does each partner resolve in Qloo, and is it in Crossover's evidence for these comps?
  // Recorded runs are served precisely when live quota must be protected, so they never
  // trigger fresh Qloo lookups; neither does any run once the quota floor is reached.
  const searchAllowed = run.mode === "fixture" || (run.mode === "live" && !belowQuotaFloor());
  const client = new QlooClient({ maxCalls: searchAllowed ? 24 : 0, mode: run.mode === "fixture" ? "fixture" : "live" });
  const evidence = new Map<string, number>();
  for (const f of run.facts) if (f.kind === "affinity" && typeof f.value === "number") evidence.set((f.subject?.name ?? "").toLowerCase(), Math.max(evidence.get((f.subject?.name ?? "").toLowerCase()) ?? 0, f.value));
  const partners = out.concepts.flatMap((c) => c.partners);
  const unique = [...new Map(partners.map((p) => [p.name.toLowerCase(), p])).values()];
  const checks: BaselineCheck[] = await Promise.all(
    unique.map(async (p) => {
      const key = p.name.toLowerCase();
      const inEvidence = evidence.has(key);
      const type = SEARCHABLE[p.domain];
      let resolved = inEvidence;
      let entityId: string | undefined;
      if (!resolved && type && searchAllowed && client.remaining > 0) {
        const hits = await searchEntities(client, p.name, [type], 3).catch(() => []);
        const hit = hits.find((h) => h.name.toLowerCase() === key);
        resolved = Boolean(hit);
        entityId = hit?.entityId;
      }
      return { name: p.name, domain: p.domain, resolved, entityId, inCrossoverEvidence: inEvidence, affinity: evidence.get(key) };
    }),
  );
  const n = checks.length || 1;
  return {
    concepts: out.concepts.slice(0, 3).map((c) => ({ ...c, partners: c.partners })),
    checks,
    verifiability: checks.filter((c) => c.resolved).length / n,
    grounding: checks.filter((c) => c.inCrossoverEvidence).length / n,
    llmUsage,
    ...(searchAllowed ? {} : { note: "Qloo lookups skipped to protect quota; only matches against this run's evidence were checked." }),
  };
}
