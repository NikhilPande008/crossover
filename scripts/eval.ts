// Arm-vs-arm evaluation (docs/eval.md): the six fixed briefs, each run through a deployed
// Crossover (arm C, /api/plan) and the same model with no Qloo tools (arm A, /api/baseline).
//
//   npm run eval                      # against the live demo
//   EVAL_BASE_URL=http://localhost:3004 npm run eval
//
// Raw results contain Qloo data, so they go to .data/eval/ (gitignored). Only the aggregate
// summary printed at the end is meant for docs/eval.md. Costs about 50 Qloo calls per brief.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "@/lib/presets";
import type { BaselineResult, Brief, Comp, ProgressEvent, RunResult } from "@/lib/types";

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

const post = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function resolve(brief: Brief): Promise<Comp[]> {
  const r = await post("/api/resolve", { comps: brief.comps, format: brief.format });
  const j = await r.json();
  if (!r.ok) throw new Error(`resolve ${r.status}: ${j.error ?? ""}`);
  return (j.resolutions as { query: string; candidates: Comp[] }[]).flatMap((x) => {
    const c = x.candidates.find((c) => c.name.toLowerCase() === x.query.toLowerCase()) ?? x.candidates[0];
    return c ? [{ name: c.name, entityId: c.entityId, type: c.type, year: c.year, descriptor: c.descriptor }] : [];
  });
}

async function plan(brief: Brief, comps: Comp[]): Promise<RunResult> {
  const r = await post("/api/plan", { brief: { ...brief, comps: comps.map((c) => c.name) }, comps });
  if (!r.ok || !r.body) throw new Error(`plan ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf
        .slice(0, i)
        .split("\n")
        .find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      if (!line) continue;
      const e = JSON.parse(line.slice(6)) as ProgressEvent;
      if (e.type === "result") return e.result;
      if (e.type === "error") throw new Error(`plan: ${e.message}`);
    }
  }
  throw new Error("plan: stream ended without a result");
}

async function baseline(run: RunResult): Promise<BaselineResult> {
  const { runId, mode, brief, comps, facts } = run;
  const r = await post("/api/baseline", { runId, run: { runId, mode, brief, comps, facts } });
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
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`eval against ${BASE} · build ${health.build} · mode ${health.mode} · model ${health.llm?.model}`);
  const only = process.argv.slice(2).map(Number).filter(Boolean);
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
      row.ok = !b.error;
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
