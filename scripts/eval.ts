// Arm-vs-arm evaluation (docs/eval.md): the six fixed briefs, each run through a deployed
// Crossover (arm C, /api/plan) and the same model with no Qloo tools (arm A, /api/baseline).
//
//   npm run eval                      # against the live demo
//   EVAL_BASE_URL=http://localhost:3004 npm run eval
//   npm run eval -- --reps=3 --swaps --refine 1 3 5     # run 2: variance, comp sensitivity, refinements
//
// --reps=N   repeat each brief N times; reports run-to-run partner overlap (Jaccard).
// --swaps    swap each comp once (re-plan with priorRunId, as the UI does); reports how much of
//            the recommended concept changed, whether the lead changed, and Qloo calls per swap.
// --refine   exclude the recommended concept's top partner and pin the #8 market; pass when both
//            constraints hold and at least 30% of the recommended concept's items changed.
// Every plan goes through the browser's stream client, so dropped streams are resumed the
// same way and count as completed; the completion rate covers all plans, swaps and refinements.
//
// Raw results contain Qloo data, so they go to .data/eval/ (gitignored). Only the aggregate
// summary printed at the end is meant for docs/eval.md. Costs about 50 Qloo calls per brief.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "@/lib/presets";
import { streamPlan } from "@/lib/client/stream";
import type { BaselineResult, Brief, Comp, RunResult } from "@/lib/types";

const BASE = (process.env.EVAL_BASE_URL ?? "https://crossover-murex.vercel.app").replace(/\/$/, "");
const OUT = join(process.cwd(), ".data", "eval", new Date().toISOString().replace(/[:.]/g, "-"));

// Fixed before the first run (docs/eval.md): 3 presets × 2 constraint sets.
const BRIEFS: { n: number; preset: string; brief: Brief }[] = (() => {
  const p = (id: string) => PRESETS.find((x) => x.id === id)!;
  const as = (id: string) => p(id).brief;
  return [
    { n: 1, preset: "prestige-horror", brief: as("prestige-horror") },
    { n: 2, preset: "prestige-horror", brief: { ...as("prestige-horror"), exclusions: [] } },
    { n: 3, preset: "indie-coming-of-age", brief: as("indie-coming-of-age") },
    { n: 4, preset: "indie-coming-of-age", brief: { ...as("indie-coming-of-age"), exclusions: ["alcohol"] } },
    { n: 5, preset: "dark-comedy-series", brief: as("dark-comedy-series") },
    { n: 6, preset: "dark-comedy-series", brief: { ...as("dark-comedy-series"), exclusions: [] } },
  ];
})();

const ARGS = process.argv.slice(2);
const flag = (name: string) => ARGS.includes(`--${name}`);
const REPS = Math.max(1, Number(ARGS.find((a) => a.startsWith("--reps="))?.slice(7) ?? 1) || 1);

// One replacement per comp for the sensitivity check, fixed before run 2. The preset's own swap
// (lib/presets.ts) is the deliberately different-audience one.
const SWAPS: Record<string, Record<string, string>> = {
  "prestige-horror": { Hereditary: "Apostle", "The Witch": "The Lighthouse", Midsommar: "Lady Bird" },
  "indie-coming-of-age": { "Lady Bird": "Frances Ha", "Eighth Grade": "The Edge of Seventeen", "The Perks of Being a Wallflower": "Booksmart" },
  "dark-comedy-series": { Fleabag: "Catastrophe", Barry: "The Bear", "Russian Doll": "Search Party" },
};

const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function resolve(brief: Brief): Promise<Comp[]> {
  const r = await post("/api/resolve", { comps: brief.comps, format: brief.format });
  const j = await r.json();
  if (!r.ok) throw new Error(`resolve ${r.status}: ${j.error ?? ""}`);
  return (j.resolutions as { query: string; candidates: Comp[] }[]).flatMap((x) => {
    const c = x.candidates.find((c) => c.name.toLowerCase() === x.query.toLowerCase()) ?? x.candidates[0];
    return c ? [{ name: c.name, entityId: c.entityId, type: c.type, year: c.year, descriptor: c.descriptor, genres: c.genres }] : [];
  });
}

/** Plans for every attempt, resumed or not: the reliability numbers. */
const attempts: { kind: "plan" | "swap" | "refine"; ok: boolean; resumed: boolean; wallMs: number; error?: string }[] = [];

async function plan(brief: Brief, comps: Comp[], kind: "plan" | "swap" | "refine" = "plan", extra: Record<string, unknown> = {}): Promise<RunResult> {
  const t = Date.now();
  let result: RunResult | undefined;
  let error: string | undefined;
  let resumed = false;
  const fetchImpl = ((url: string, init?: RequestInit) => fetch(`${BASE}${url}`, init)) as typeof fetch;
  await streamPlan(
    { brief: { ...brief, comps: comps.map((c) => c.name) }, comps, refinements: { excludedPartners: [], pinnedMarkets: [] }, ...extra },
    (e) => {
      if (e.type === "result") result = e.result;
      if (e.type === "error") error = e.message;
      if (e.type === "step" && /reconnecting/.test(e.message)) resumed = true;
    },
    { fetchImpl },
  );
  attempts.push({ kind, ok: !!result, resumed, wallMs: Date.now() - t, error });
  if (!result) throw new Error(`${kind}: ${error ?? "no result"}`);
  return result;
}

async function baseline(run: RunResult): Promise<BaselineResult> {
  const { runId, mode, brief, comps, facts, concepts, audience } = run;
  const r = await post("/api/baseline", {
    runId,
    run: { runId, mode, brief, comps, facts, concepts: concepts.map((c) => ({ partners: c.partners })), audience: { partners: audience.partners, markets: audience.markets } },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`baseline ${r.status}: ${j.error ?? ""}`);
  return j;
}

const pct = (x: number) => Math.round(x * 100);
const excluded = (name: string, exclusions: string[]) => exclusions.some((e) => name.toLowerCase().includes(e.toLowerCase()));
const jaccard = (a: Set<string>, b: Set<string>) => {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

type Row = {
  n: number;
  preset: string;
  exclusions: string[];
  ok: boolean;
  error?: string;
  build?: string;
  c?: { partners: string[]; qlooCalls: number; cachedCalls: number; ms: number; wallMs: number; llmUsed: boolean; briefBy: string; dropped: number; validatorDrops: number; exclusionHits: number; recommended: string };
  a?: { partners: string[]; resolved: number; inEvidence: number; total: number; exclusionHits: number; error?: string; note?: string };
  /** Both arms scored by Qloo lift (same calls, same code). */
  lift?: { model: BaselineResult["modelArm"]; crossover: BaselineResult["crossoverArm"]; genericInRecommended: number; recommendedScored: number };
  reps?: number[];
  swaps?: { from: string; to: string; ok: boolean; changedShare?: number; leadChanged?: boolean; calls?: number; cached?: number; error?: string }[];
  refine?: { excluded: string; pinned: string; ok: boolean; honoured?: boolean; changedShare?: number; pass?: boolean; ms?: number; calls?: number; error?: string };
};

/** Share of the recommended concept's partners and markets that are not in the other run's recommended concept. */
function recChanged(before: RunResult, after: RunResult): number {
  const items = (r: RunResult) => {
    const c = r.concepts.find((x) => x.id === r.decision.recommendedId);
    return new Set([...(c?.partners.map((p) => `p:${p.name}`) ?? []), ...(c?.markets.map((m) => `m:${m.name}`) ?? [])]);
  };
  const a = items(before);
  const b = items(after);
  return a.size ? [...a].filter((x) => !b.has(x)).length / a.size : 0;
}

const recOf = (r: RunResult) => r.concepts.find((c) => c.id === r.decision.recommendedId);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`eval against ${BASE} · build ${health.build} · mode ${health.mode} · model ${health.llm?.model}`);
  const only = ARGS.filter((a) => !a.startsWith("--")).map(Number).filter(Boolean);
  const rows: Row[] = [];
  for (const { n, preset, brief } of BRIEFS.filter((b) => !only.length || only.includes(b.n))) {
    const row: Row = { n, preset, exclusions: brief.exclusions, ok: false, build: health.build };
    try {
      const comps = await resolve(brief);
      const t = Date.now();
      const run = await plan(brief, comps);
      const wallMs = Date.now() - t;
      const partners = [...new Set(run.concepts.flatMap((c) => c.partners.map((p) => p.name)))];
      const rec = run.concepts.find((c) => c.id === run.decision.recommendedId);
      row.c = {
        partners,
        qlooCalls: run.qlooCalls,
        cachedCalls: run.cachedCalls,
        ms: run.ms,
        wallMs,
        llmUsed: run.llmUsed,
        briefBy: run.decision.writtenBy,
        dropped: run.decision.droppedSentences,
        validatorDrops: run.trace.filter((x) => x.kind === "validator" && /^(Dropped|Creative angle replaced|Concept name dropped|Risk dropped|Hypothesis dropped)/.test(x.message)).length,
        exclusionHits: partners.filter((p) => excluded(p, brief.exclusions)).length,
        recommended: rec ? rec.lever : "?",
      };
      writeFileSync(join(OUT, `brief-${n}-crossover.json`), JSON.stringify(run));
      const b = await baseline(run);
      writeFileSync(join(OUT, `brief-${n}-baseline.json`), JSON.stringify(b));
      row.a = {
        partners: b.checks.map((x) => x.name),
        resolved: b.checks.filter((x) => x.resolved).length,
        inEvidence: b.checks.filter((x) => x.inCrossoverEvidence).length,
        total: b.checks.length,
        exclusionHits: b.checks.filter((x) => excluded(x.name, brief.exclusions)).length,
        error: b.error,
        note: b.note,
      };
      const rp = rec?.partners ?? [];
      const liftOf = (name: string) => Object.values(run.audience.partners).flat().find((p) => p.name === name)?.lift;
      const recLifts = rp.map((p) => liftOf(p.name)).filter((x): x is number => x !== undefined);
      row.lift = { model: b.modelArm, crossover: b.crossoverArm, genericInRecommended: recLifts.filter((x) => x <= 0).length, recommendedScored: recLifts.length };
      row.ok = !b.error;

      // Run-to-run variance: the same brief again, partner-list overlap with the first run.
      if (REPS > 1) {
        row.reps = [];
        const first = new Set(partners.map((p) => p.toLowerCase()));
        for (let i = 1; i < REPS; i++) {
          const again = await plan(brief, comps).catch(() => null);
          if (again) row.reps.push(jaccard(first, new Set(again.concepts.flatMap((c) => c.partners.map((p) => p.name.toLowerCase())))));
        }
      }

      // Comp sensitivity: swap each comp once, as the UI does (priorRunId), and diff the plans.
      if (flag("swaps")) {
        row.swaps = [];
        for (const from of comps) {
          const to = SWAPS[preset]?.[from.name];
          if (!to) continue;
          try {
            const [c2] = await resolve({ ...brief, comps: [to] });
            if (!c2) throw new Error(`could not resolve ${to}`);
            const swapped = comps.map((c) => (c.entityId === from.entityId ? c2 : c));
            const after = await plan({ ...brief }, swapped, "swap", { priorRunId: run.runId });
            row.swaps.push({ from: from.name, to: c2.name, ok: true, changedShare: recChanged(run, after), leadChanged: recOf(run)?.lever !== recOf(after)?.lever || recOf(run)?.name !== recOf(after)?.name, calls: after.qlooCalls, cached: after.cachedCalls });
          } catch (e) {
            row.swaps.push({ from: from.name, to, ok: false, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }

      // Refinement responsiveness: exclude the top partner, pin the #8 market.
      if (flag("refine") && rec?.partners[0] && run.audience.markets[7]) {
        const excludedName = rec.partners[0].name;
        const pinned = run.audience.markets[7].name;
        try {
          const after = await plan(brief, comps, "refine", { priorRunId: run.runId, refinements: { excludedPartners: [excludedName], pinnedMarkets: [pinned] } });
          const named = after.concepts.flatMap((c) => c.partners.map((p) => p.name));
          const honoured = !named.includes(excludedName) && after.concepts.every((c) => c.markets.some((m) => m.name === pinned));
          const changedShare = recChanged(run, after);
          row.refine = { excluded: excludedName, pinned, ok: true, honoured, changedShare, pass: honoured && changedShare >= 0.3, ms: after.ms, calls: after.qlooCalls };
        } catch (e) {
          row.refine = { excluded: excludedName, pinned, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
    rows.push(row);
    console.log(
      `brief ${n} ${preset} [${brief.exclusions.join(",") || "no exclusions"}]: ${row.error ? `FAILED ${row.error}` : `C ${row.c!.qlooCalls} calls ${(row.c!.wallMs / 1000).toFixed(1)} s, rec ${row.c!.recommended}, ${row.c!.partners.length} partners; A ${row.a!.total} partners, ${row.a!.resolved} resolve, ${row.a!.inEvidence} in evidence${row.a!.error ? `, error ${row.a!.error}` : ""}`}`,
    );
  }

  // Specificity: partner-list overlap between briefs with different comps (same constraint set).
  const spec = (arm: "a" | "c") => {
    const sets = rows.filter((r) => r.ok && r[arm]).map((r) => ({ n: r.n, preset: r.preset, s: new Set(r[arm]!.partners.map((p) => p.toLowerCase())) }));
    const pairs: number[] = [];
    for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) if (sets[i].preset !== sets[j].preset && sets[i].n % 2 === sets[j].n % 2) pairs.push(jaccard(sets[i].s, sets[j].s));
    return pairs.length ? { mean: pairs.reduce((s, x) => s + x, 0) / pairs.length, pairs: pairs.length } : null;
  };
  const ok = rows.filter((r) => r.ok);
  const sum = (f: (r: Row) => number) => ok.reduce((s, r) => s + f(r), 0);
  const aTotal = sum((r) => r.a!.total);
  const cWall = ok.map((r) => r.c!.wallMs).sort((x, y) => x - y);
  const summary = {
    base: BASE,
    build: health.build,
    model: health.llm?.model,
    ranAt: new Date().toISOString(),
    briefsRun: rows.length,
    briefsCompleted: ok.length,
    failures: rows.filter((r) => !r.ok).map((r) => ({ n: r.n, error: r.error ?? r.a?.error })),
    armA: {
      partnersNamed: aTotal,
      verifiabilityPct: aTotal ? pct(sum((r) => r.a!.resolved) / aTotal) : null,
      groundingPct: aTotal ? pct(sum((r) => r.a!.inEvidence) / aTotal) : null,
      exclusionNameHits: sum((r) => r.a!.exclusionHits),
      specificity: spec("a"),
    },
    reliability: {
      attempts: attempts.length,
      completed: attempts.filter((a) => a.ok).length,
      resumedAfterDrop: attempts.filter((a) => a.resumed).length,
      byKind: (["plan", "swap", "refine"] as const).map((k) => ({ kind: k, attempts: attempts.filter((a) => a.kind === k).length, completed: attempts.filter((a) => a.kind === k && a.ok).length })),
      wallSecondsP95: (() => {
        const xs = attempts.filter((a) => a.ok).map((a) => a.wallMs).sort((x, y) => x - y);
        return xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] / 1000 : null;
      })(),
    },
    lift: {
      modelPositive: sum((r) => r.lift?.model?.positive ?? 0),
      modelScored: sum((r) => r.lift?.model?.scored ?? 0),
      crossoverPositive: sum((r) => r.lift?.crossover?.positive ?? 0),
      crossoverScored: sum((r) => r.lift?.crossover?.scored ?? 0),
      medianLiftPerBrief: ok.map((r) => ({ n: r.n, model: r.lift?.model?.medianLift ?? null, crossover: r.lift?.crossover?.medianLift ?? null })),
      genericRate: (() => {
        const scored = sum((r) => r.lift?.recommendedScored ?? 0);
        return scored ? Math.round((sum((r) => r.lift?.genericInRecommended ?? 0) / scored) * 1000) / 1000 : null;
      })(),
    },
    variance: REPS > 1 ? ok.map((r) => ({ n: r.n, jaccardWithFirst: r.reps })) : undefined,
    sensitivity: flag("swaps")
      ? (() => {
          const sw = ok.flatMap((r) => r.swaps ?? []).filter((x) => x.ok);
          const calls = sw.map((x) => x.calls ?? 0).sort((x, y) => x - y);
          return {
            swaps: sw.length,
            failed: ok.flatMap((r) => r.swaps ?? []).filter((x) => !x.ok).length,
            meanChangedShare: sw.length ? Math.round((sw.reduce((s, x) => s + (x.changedShare ?? 0), 0) / sw.length) * 1000) / 1000 : null,
            leadChanged: sw.filter((x) => x.leadChanged).length,
            medianQlooCallsPerSwap: calls.length ? calls[Math.floor(calls.length / 2)] : null,
          };
        })()
      : undefined,
    refinement: flag("refine")
      ? {
          runs: ok.filter((r) => r.refine?.ok).length,
          passed: ok.filter((r) => r.refine?.pass).length,
          honoured: ok.filter((r) => r.refine?.honoured).length,
          changedShares: ok.map((r) => r.refine?.changedShare ?? null),
          medianSeconds: (() => {
            const xs = ok.map((r) => r.refine?.ms).filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
            return xs.length ? xs[Math.floor(xs.length / 2)] / 1000 : null;
          })(),
        }
      : undefined,
    armC: {
      partnersNamed: sum((r) => r.c!.partners.length),
      exclusionNameHits: sum((r) => r.c!.exclusionHits),
      specificity: spec("c"),
      qlooCallsPerRun: ok.map((r) => r.c!.qlooCalls),
      wallSecondsMedian: cWall.length ? cWall[Math.floor(cWall.length / 2)] / 1000 : null,
      wallSecondsMax: cWall.length ? cWall[cWall.length - 1] / 1000 : null,
      briefsWrittenByModel: ok.filter((r) => r.c!.briefBy === "llm").length,
      validatorDropsTotal: sum((r) => r.c!.validatorDrops),
      recommendedLevers: ok.map((r) => r.c!.recommended),
    },
    perBrief: rows.map((r) => ({ n: r.n, preset: r.preset, exclusions: r.exclusions, ok: r.ok, error: r.error, c: r.c && { ...r.c, partners: r.c.partners.length }, a: r.a && { ...r.a, partners: r.a.partners.length } })),
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nSummary (aggregates only; raw runs in ${OUT}):\n${JSON.stringify({ ...summary, perBrief: undefined }, null, 2)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
