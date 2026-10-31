// The Crossover agent: plan → research → assess → (recover) → conceive → critique → brief.
// The LLM chooses research calls and writes interpretations; code does retrieval,
// scoring, constraint checks and validation. Hard limits: 6 agent turns,
// QLOO_MAX_CALLS_PER_RUN Qloo calls, 60 s wall clock (RUN_WALL_SECONDS) for starting work,
// and a hard stop for any model call 40 s after that, inside the route's 120 s limit.

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { Brief, Comp, Concept, DecisionBrief, Fact, ProgressEvent, RunResult, TraceEntry } from "@/lib/types";
import { config } from "@/lib/config";
import { FactStore } from "@/lib/facts/store";
import { QlooClient } from "@/lib/qloo/client";
import { getLLM, noteLLM, type LLM } from "@/lib/llm/provider";
import { describeLLMError } from "@/lib/llm/budget";
import { UsageMeter, formatUsage } from "@/lib/llm/usage";
import { buildAudienceMap } from "@/lib/score";
import { THRESHOLDS } from "@/lib/thresholds";
import { makeContext, namedSubjects, stripCitations, validateCited, validateUncited, type GroundingContext } from "@/lib/validate/grounding";
import { buildScoreScope } from "@/lib/validate/comparative";
import type { Refinements } from "@/lib/validate/constraints";
import { assessEvidence, attemptKey, describeGap, gapToCall, type Attempted, type PlannedCall } from "./assess";
import { TOOL_DEFS, runTool, type ToolContext } from "./tools";
import { BRIEF_SYSTEM, CONCEIVE_SYSTEM, RESEARCH_SYSTEM, briefBlock } from "./prompts";
import {
  ConceptsOut,
  buildCandidates,
  candidatesSummary,
  draftToConcept,
  enforceConstraints,
  finalizeConfidence,
  similarPairs,
  templateConcepts,
  type Candidates,
} from "./concepts";
import { BriefOut, explainRecommended, templateBrief, DISCLAIMER } from "./brief";

export type PlanInput = {
  brief: Brief;
  comps: Comp[];
  refinements?: Refinements;
  priorFacts?: Fact[];
  mode?: "live" | "fixture";
  /** Aborted when the requester goes away; the run stops at the next checkpoint. */
  signal?: AbortSignal;
};

export class RunAborted extends Error {
  constructor() {
    super("Run aborted by the client");
  }
}

const MAX_TURNS = 6;
/** How long a model call may run past the wall-clock budget (default 60 + 40 = 100 s, under maxDuration 120). */
const LLM_GRACE_MS = 40_000;

export async function runPlan(input: PlanInput, emit: (e: ProgressEvent) => void = () => {}): Promise<RunResult> {
  const t0 = Date.now();
  const deadline = t0 + config.runWallMs();
  const llmDeadline = deadline + LLM_GRACE_MS;
  const { brief, comps } = input;
  const ref: Refinements = input.refinements ?? { excludedPartners: [], pinnedMarkets: [] };
  const checkpoint = () => {
    if (input.signal?.aborted) throw new RunAborted();
  };
  const trace: TraceEntry[] = [];
  const log = (kind: TraceEntry["kind"], message: string, data?: unknown) => {
    const entry = { at: new Date().toISOString(), kind, message, data };
    trace.push(entry);
    emit({ type: "trace", entry });
  };

  const meter = new UsageMeter((r) =>
    log("llm", `${r.phase} · ${r.model} · ${formatUsage({ ...r, inputTokens: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens })} · ${(r.ms / 1000).toFixed(1)} s`, r),
  );
  const client = new QlooClient({
    maxCalls: config.maxCallsPerRun(),
    mode: input.mode,
    signal: input.signal,
    onCall: ({ req, res, error }) => {
      log("qloo", error ? `✗ ${req.path} ${error.status}` : `${res!.cached ? "cache" : res!.synthetic ? "synthetic" : "live"} ${req.path} ${req.params["filter.type"] ?? ""}`.trim(), {
        request: req,
        status: error?.status ?? res?.status,
        ms: res?.ms,
      });
    },
  });
  const step = (message: string) => emit({ type: "step", message, calls: client.calls });

  const store = new FactStore();
  if (input.priorFacts?.length) {
    const ids = new Set(comps.map((c) => c.entityId));
    // Re-used facts were not fetched by this run, so they carry the "recorded" badge.
    const still = input.priorFacts.filter((f) => f.compIds.every((id) => ids.has(id))).map((f) => ({ ...f, recorded: true }));
    store.adopt(still);
    log("decision", `Re-plan: ${still.length} of ${input.priorFacts.length} prior facts still valid for the current comps; re-running only what changed`);
  }

  const ctx: ToolContext = { client, store, comps, regions: brief.regions, excludeIds: [] };
  const attempted: Attempted = new Set();
  let usedFallback = false;

  const exec = async (call: PlannedCall) => {
    checkpoint();
    attempted.add(attemptKey(call.tool, call.input));
    if (String(call.input.reason ?? "").startsWith("Only")) usedFallback = true;
    const out = await runTool(call.tool, call.input, ctx);
    log("tool", `${call.tool}: ${out.label}`, { reason: call.input.reason, input: call.input });
    return out;
  };

  step(`Resolved ${comps.length} comps`);
  const llm = getLLM();
  let llmUsed = false;

  // ---------- research (agent-driven) ----------
  if (llm) {
    try {
      llmUsed = await researchWithLLM(llm, { brief, comps, client, exec, attempted, store, log, step, deadline, checkpoint, meter, signal: input.signal });
      noteLLM(true);
    } catch (e) {
      if (e instanceof RunAborted) throw e;
      noteLLM(false, e);
      log("error", `Research planner unavailable (${describeLLMError(e)}); continuing with the default plan`);
    }
  } else {
    log("plan", "No language model configured: running the default research plan");
  }

  // ---------- assess + coverage fill / recovery (code) ----------
  for (let round = 0; round < 3; round++) {
    const gaps = assessEvidence(store.all(), comps, brief, attempted);
    const calls = dedupe(gaps.map((g) => gapToCall(g, comps))).filter((c) => !attempted.has(attemptKey(c.tool, c.input)));
    if (!calls.length || client.remaining <= 0) break;
    const take = calls.slice(0, Math.max(0, client.remaining));
    log("decision", round === 0 && !llmUsed ? `Default plan: ${take.length} research calls` : `Evidence check found ${gaps.length} gap(s): ${gaps.slice(0, 4).map((g) => describeGap(g, comps)).join("; ")}`);
    step(round === 0 ? "Mapping music, podcast, TV and brand affinities" : "Filling evidence gaps");
    await Promise.all(take.map(exec));
    checkpoint();
    if (Date.now() > deadline - 20_000) {
      log("limit", "Wall-clock limit near; proceeding with the evidence gathered");
      break;
    }
  }
  const remainingGaps = assessEvidence(store.all(), comps, brief, attempted);
  const gapLabels = remainingGaps.map((g) => describeGap(g, comps));
  for (const c of comps) {
    if (!store.all().some((f) => f.kind === "heatmap" && f.compIds[0] === c.entityId)) gapLabels.push(`No location signal for ${c.name}; markets ranked on the other comps`);
  }
  if (client.remaining <= 0) log("limit", `Qloo call budget (${config.maxCallsPerRun()}) reached`);

  // ---------- score ----------
  const facts = store.all();
  const audience = buildAudienceMap(facts, comps, [...new Set(gapLabels)]);
  for (const o of audience.overlaps) {
    const an = comps.find((c) => c.entityId === o.a)?.name;
    const bn = comps.find((c) => c.entityId === o.b)?.name;
    const verdict = o.similar ? "share an audience (bridge them)" : "look like different audiences (pick a lead)";
    log(
      "decision",
      `${an} and ${bn} ${verdict}: ${Math.round(o.themeShare * 100)}% of ${o.themesCompared} themes shared (${o.source === "compare-endpoint" ? "Qloo compare" : "taste tags"}); ${Math.round(o.score * 100)}% of top audience ${o.basis === "audience-affinities" ? "affinities" : "tags"} shared`,
    );
  }
  step(audience.overlaps.length ? "Compared comp audiences" : "Scored markets and partners");

  const cand = buildCandidates(audience, brief, facts, ref);
  for (const r of cand.removals) log("validator", `Constraint "${r.constraint}" removed ${r.count} partner candidate(s)`);
  const gctx = makeContext(facts, comps, brief);

  // ---------- conceive + critique ----------
  checkpoint();
  step("Drafting three campaign concepts");
  let concepts: Concept[] | null = null;
  if (llm && Date.now() < deadline - 10_000) {
    try {
      concepts = await conceiveWithLLM(llm, { meter, deadline: llmDeadline, signal: input.signal }, brief, comps, cand, store, audience.overlaps.map((o) => `${o.a} vs ${o.b}: ${o.similar ? "one audience" : "two audiences"} (theme share ${o.themeShare}); shared themes ${o.shared.join(", ")}`).join("\n"));
      llmUsed = true;
      log("llm", `Drafted ${concepts.length} concepts`);
    } catch (e) {
      noteLLM(false, e);
      if (e instanceof RunAborted || input.signal?.aborted) throw new RunAborted();
      log("error", `Concept writer failed (${describeLLMError(e)}); using templated concepts`);
    }
  }
  const templates = templateConcepts(audience, cand, comps, brief);
  if (!concepts) concepts = templates;
  // Exactly one concept per lever.
  concepts = (["market", "partner", "crossover"] as const).map((lever, i) => {
    const c = concepts!.find((x) => x.lever === lever) ?? templates[i];
    return { ...c, id: `C${i + 1}` };
  });

  const enforceLog: string[] = [];
  concepts = enforceConstraints(concepts, brief, facts, ref, cand, enforceLog);
  for (const l of enforceLog) log("validator", l);
  for (const [, j] of similarPairs(concepts)) {
    log("decision", `${concepts[j].name} is a near-duplicate; replacing it with a different ${concepts[j].lever} lever`);
    concepts[j] = enforceConstraints([{ ...templates[j], id: concepts[j].id }], brief, facts, ref, cand, [])[0];
  }
  // Comparative claims are checked against the run's scores and the concepts' own groups.
  gctx.scores = buildScoreScope(audience, concepts, comps);
  concepts = concepts.map((c, i) => groundConcept(c, templates[i], gctx, log));
  concepts = finalizeConfidence(concepts, facts, comps, usedFallback);

  // ---------- brief ----------
  checkpoint();
  gctx.scores = buildScoreScope(audience, concepts, comps);
  // The recommendation is code's, so the same evidence always gives the same pick; the model only argues for it.
  const picked = explainRecommended(concepts, audience);
  log("decision", `Recommending ${picked.concept.name} (${picked.concept.lever}): ${picked.reason}`);
  step("Writing the decision brief");
  let decision: DecisionBrief | null = null;
  if (llm && llmUsed && Date.now() < deadline - 5_000) {
    for (let attempt = 0; attempt < 2 && !decision; attempt++) {
      // The regeneration gets the same start-by limit as the first attempt.
      if (attempt > 0 && Date.now() >= deadline - 5_000) {
        log("limit", "No time to regenerate the brief; keeping what passed the validator");
        break;
      }
      try {
        const d = await briefWithLLM(llm, { meter, deadline: llmDeadline, signal: input.signal }, brief, comps, concepts, store, picked);
        const grounded = groundBrief(d, picked.concept, gctx, log);
        if (grounded.share > THRESHOLDS.maxDroppedShare && attempt === 0) {
          log("validator", `Validator dropped ${Math.round(grounded.share * 100)}% of brief sentences; regenerating once`);
          continue;
        }
        if (grounded.brief.rationale.length) decision = grounded.brief;
      } catch (e) {
        if (input.signal?.aborted) throw new RunAborted();
        noteLLM(false, e);
        log("error", `Brief writer failed (${describeLLMError(e)}); using templated brief`);
        break;
      }
    }
  }
  if (!decision) decision = templateBrief(concepts, audience, comps);

  const result: RunResult = {
    runId: randomUUID(),
    mode: client.mode,
    brief,
    comps,
    audience,
    concepts,
    decision,
    facts: store.all(),
    trace,
    qlooCalls: client.calls,
    cachedCalls: client.cachedCalls,
    llmUsed,
    ms: Date.now() - t0,
    constraintRemovals: cand.removals,
    llmUsage: meter.summary(),
  };
  if (result.llmUsage.calls) console.info(`[llm-usage] run=${result.runId} ${result.llmUsage.provider} ${result.llmUsage.models.join(",")} ${formatUsage(result.llmUsage)}`);
  step("Done");
  return result;
}

function dedupe(calls: PlannedCall[]) {
  const seen = new Set<string>();
  return calls.filter((c) => {
    const k = attemptKey(c.tool, c.input);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- LLM phases ----------

async function researchWithLLM(
  llm: LLM,
  a: {
    brief: Brief;
    comps: Comp[];
    client: QlooClient;
    exec: (c: PlannedCall) => Promise<{ summary: string; isError?: boolean }>;
    attempted: Attempted;
    store: FactStore;
    log: (k: TraceEntry["kind"], m: string, d?: unknown) => void;
    step: (m: string) => void;
    deadline: number;
    checkpoint: () => void;
    meter: UsageMeter;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `${briefBlock(a.brief, a.comps)}\n\nQloo call budget for this run: ${a.client.remaining}. ${a.store.all().length ? `Facts already gathered (re-plan):\n<facts>\n${a.store.summary(undefined, 80)}\n</facts>\nOnly research what is missing.` : ""}\nResearch the comps' audiences.`,
    },
  ];
  let used = false;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    a.checkpoint();
    if (Date.now() > a.deadline - 30_000) {
      a.log("limit", "Leaving research early to stay inside the time limit");
      break;
    }
    // First turn must start researching; later turns may finish in text.
    // Research turns must end by the wall-clock deadline; writing happens after it.
    const r = await llm.toolTurn({ system: RESEARCH_SYSTEM, messages, tools: TOOL_DEFS, effort: "low", requireTool: turn === 0, meter: a.meter, phase: "research", deadline: a.deadline, signal: a.signal });
    used = true;
    if (r.text.trim()) a.log("plan", r.text.trim().slice(0, 400));
    messages.push({ role: "assistant", content: r.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (!r.toolUses.length) break;
    if (turn === 0) a.step("Agent chose its research plan");
    const finish = r.toolUses.find((t) => t.name === "finish_research");
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      r.toolUses.map(async (tu) => {
        if (tu.name === "finish_research") {
          a.log("decision", `Agent finished research: ${String((tu.input as { reason?: string }).reason ?? "")}`);
          return { type: "tool_result" as const, tool_use_id: tu.id, content: "ok" };
        }
        const out = await a.exec({ tool: tu.name, input: tu.input as Record<string, unknown> });
        return { type: "tool_result" as const, tool_use_id: tu.id, content: out.summary, is_error: out.isError };
      }),
    );
    a.step(`Research turn ${turn + 1}: ${a.client.calls} Qloo calls so far`);
    const gaps = assessEvidence(a.store.all(), a.comps, a.brief, a.attempted);
    const note = `Evidence check: ${gaps.length ? gaps.slice(0, 8).map((g) => describeGap(g, a.comps)).join("; ") : "coverage complete"}. Remaining Qloo budget: ${a.client.remaining}.`;
    messages.push({ role: "user", content: [...results, { type: "text", text: note }] });
    if (finish || a.client.remaining <= 0) break;
  }
  return used;
}

type CallOpts = { meter: UsageMeter; deadline: number; signal?: AbortSignal };

async function conceiveWithLLM(llm: LLM, opts: CallOpts, brief: Brief, comps: Comp[], cand: Candidates, store: FactStore, overlaps: string): Promise<Concept[]> {
  const tagFacts = store.summary((f) => f.kind === "tag" || f.kind === "compare" || f.kind === "demographic", 120);
  const user = `${briefBlock(brief, comps)}

<candidates>
${candidatesSummary(cand, comps)}
</candidates>

<facts>
${tagFacts}
</facts>

Comp overlap (0..1):
${overlaps}

Draft the three concepts.`;
  const out = await llm.structured({ system: CONCEIVE_SYSTEM, user, schema: ConceptsOut, effort: "medium", ...opts, phase: "conceive" });
  return out.concepts.slice(0, 3).map((d, i) => draftToConcept(d, i, cand, comps));
}

async function briefWithLLM(llm: LLM, opts: CallOpts, brief: Brief, comps: Comp[], concepts: Concept[], store: FactStore, picked: { concept: Concept; reason: string }) {
  const cited = new Set(concepts.flatMap((c) => [...c.partners, ...c.markets, c.creativeAngle].flatMap((x) => x.factIds)));
  const conceptText = concepts
    .map(
      (c) =>
        `${c.id} lever=${c.lever} name=${JSON.stringify(c.name)} confidence=${c.confidence}\n  markets: ${c.markets.map((m) => `${m.name} (${m.factIds.slice(0, 3).join(",")})`).join("; ")}\n  partners: ${c.partners.map((p) => `${JSON.stringify(p.name)} ${p.domain} (${p.factIds.slice(0, 3).join(",")})`).join("; ")}\n  angle: ${c.creativeAngle.text}\n  risks: ${c.risks.join(" | ")}`,
    )
    .join("\n");
  const user = `${briefBlock(brief, comps)}\n\n<concepts>\n${conceptText}\n</concepts>\n\n<recommended>\n${picked.concept.id} lever=${picked.concept.lever}: ${picked.reason}\n</recommended>\n\n<facts>\n${store.summary((f) => cited.has(f.id), 150)}\n</facts>\n\nWrite the decision brief.`;
  return llm.structured({ system: BRIEF_SYSTEM, user, schema: BriefOut, effort: "medium", ...opts, phase: "brief" });
}

// ---------- grounding ----------

/** The UI shows citations as chips, so drop fact IDs the model wrote into the prose (but keep a name like "F1"). */
const tidy = (t: string, g: GroundingContext) => stripCitations(t, g.known).replace(/\s+([.,;:!?])/g, "$1").trim();

function groundConcept(c: Concept, fallback: Concept, g: GroundingContext, log: (k: TraceEntry["kind"], m: string) => void): Concept {
  let { name, creativeAngle } = c;
  const nameIssue = validateUncited(name, g);
  if (nameIssue) {
    log("validator", `Concept name dropped: ${nameIssue.reason}`);
    name = fallback.name;
  }
  const angle = validateCited(creativeAngle, g);
  if (!angle.ok) {
    log("validator", `Creative angle replaced: ${angle.issue.reason}`);
    creativeAngle = fallback.creativeAngle;
  } else creativeAngle = { text: tidy(creativeAngle.text, g), factIds: angle.factIds };
  const keep = (xs: string[], label: string) =>
    xs.filter((x) => {
      const issue = validateUncited(x, g);
      if (issue) log("validator", `${label} dropped: ${issue.reason}`);
      return !issue;
    }).map((x) => tidy(x, g));
  return { ...c, name, creativeAngle, risks: keep(c.risks, "Risk"), hypotheses: keep(c.hypotheses, "Hypothesis") };
}

function groundBrief(
  d: import("zod").infer<typeof BriefOut>,
  rec: Concept,
  g: GroundingContext,
  log: (k: TraceEntry["kind"], m: string) => void,
): { brief: DecisionBrief; share: number } {
  let total = 0;
  let dropped = 0;
  const cited = (items: { text: string; factIds: string[] }[]) =>
    items.flatMap((it) => {
      total++;
      const r = validateCited(it, g);
      if (!r.ok) {
        dropped++;
        log("validator", `Dropped: ${r.issue.reason} — ${JSON.stringify(it.text.slice(0, 120))}`);
        return [];
      }
      return [{ text: tidy(it.text, g), factIds: r.factIds }];
    });
  // Checklist items test the recommended plan, so the partners and cities they name must be in it.
  const inPlan = new Set([...rec.partners, ...rec.markets].map((x) => x.name.toLowerCase()));
  const outsidePlan = (t: string) => {
    const other = namedSubjects(stripCitations(t, g.known), g).find((s) => !inPlan.has(s.name.toLowerCase()));
    return other ? { text: t, reason: `names "${other.name}", which is not in the recommended concept` } : null;
  };
  const plain = (items: string[], extra?: (t: string) => { text: string; reason: string } | null) =>
    items.filter((t) => {
      total++;
      const issue = validateUncited(t, g) ?? extra?.(t) ?? null;
      if (issue) {
        dropped++;
        log("validator", `Dropped: ${issue.reason} — ${JSON.stringify(t.slice(0, 120))}`);
      }
      return !issue;
    }).map((t) => tidy(t, g));
  const brief: DecisionBrief = {
    recommendedId: rec.id,
    rationale: cited(d.rationale),
    whyNotOthers: cited(d.whyNotOthers),
    tradeoffs: plain(d.tradeoffs),
    testChecklist: plain(d.testChecklist, outsidePlan),
    disclaimer: DISCLAIMER,
    writtenBy: "llm",
    droppedSentences: dropped,
  };
  return { brief, share: total ? dropped / total : 0 };
}
