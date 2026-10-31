// The Crossover agent: coverage → early audience map → agent decisions → (re-score) →
// conceive → critique and repair → brief.
// Code fetches the core Qloo evidence in parallel first (per-comp partners, a genre pool
// scored for lift, markets with over-index, cross-affinity between comps, the titles each
// comp's fans love). The model then makes the marketer's decisions: which comp to lead
// with, which to add or drop, comp weights, partners to measure. Code does retrieval,
// scoring, constraint checks and validation. Hard limits: QLOO_MAX_CALLS_PER_RUN Qloo
// calls, 60 s wall clock (RUN_WALL_SECONDS) for starting work, and a hard stop for any
// model call 40 s after that, inside the route's 120 s limit.

import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { AudienceMap, Brief, Comp, CompAdvice, Concept, DecisionBrief, Fact, ProgressEvent, RunResult, TraceEntry } from "@/lib/types";
import { config } from "@/lib/config";
import { FactStore } from "@/lib/facts/store";
import { QlooClient } from "@/lib/qloo/client";
import { reference, referenceLabel, type Reference } from "@/lib/qloo/baselines";
import { getLLM, noteLLM, type LLM } from "@/lib/llm/provider";
import { describeLLMError } from "@/lib/llm/budget";
import { UsageMeter, formatUsage } from "@/lib/llm/usage";
import { buildAudienceMap } from "@/lib/score";
import { THRESHOLDS } from "@/lib/thresholds";
import { makeContext, namedSubjects, stripCitations, validateCited, validateUncited, type GroundingContext } from "@/lib/validate/grounding";
import { buildScoreScope } from "@/lib/validate/comparative";
import type { Refinements } from "@/lib/validate/constraints";
import { z } from "zod";
import { assessEvidence, attemptKey, describeGap, gapToCall, type Attempted, type PlannedCall } from "./assess";
import { alias, runTool, toolDefs, type ToolContext } from "./tools";
import { BRIEF_SYSTEM, CONCEIVE_SYSTEM, REPAIR_SYSTEM, RESEARCH_SYSTEM, briefBlock } from "./prompts";
import {
  ConceptsOut,
  buildCandidates,
  candidatesSummary,
  critique,
  draftToConcept,
  enforceConstraints,
  finalizeConfidence,
  similarPairs,
  supportedTags,
  templateConcepts,
  type Candidates,
} from "./concepts";
import { BriefOut, explainRecommended, renderTests, templateBrief, DISCLAIMER } from "./brief";
import { codeAdvice, mergeAdvice } from "./advice";

export type PlanInput = {
  brief: Brief;
  comps: Comp[];
  refinements?: Refinements;
  priorFacts?: Fact[];
  /** Decisions of the run being re-planned, re-used when only refinements changed. */
  prior?: { runId?: string; weights?: Record<string, number>; advice?: CompAdvice };
  /** Same comps, only exclusions or pins changed: skip research and re-use the prior decisions. */
  refinementOnly?: boolean;
  mode?: "live" | "fixture";
  /** Run ID chosen by the caller, so progress can be logged under it before the run ends. */
  runId?: string;
  /** Aborted when the run must stop; the run stops at the next checkpoint. */
  signal?: AbortSignal;
};

export class RunAborted extends Error {
  constructor() {
    super("Run aborted by the client");
  }
}

const MAX_TURNS = 3;
/** Entities a checklist note might derive from a partner without any evidence ("Phoebe Bridgers fan podcasts"). */
const INVENTED_RELATED = /\bfan[\s-]*(?:podcasts?|communit(?:y|ies)|clubs?|events?|accounts?|pages?|groups?|forums?|sites?|meetups?)\b/i;
/** How long a model call may run past the wall-clock budget (default 60 + 40 = 100 s, under maxDuration 120). */
const LLM_GRACE_MS = 40_000;

export async function runPlan(input: PlanInput, emit: (e: ProgressEvent) => void = () => {}): Promise<RunResult> {
  const t0 = Date.now();
  const deadline = t0 + config.runWallMs();
  const llmDeadline = deadline + LLM_GRACE_MS;
  const { brief, comps } = input;
  const runId = input.runId ?? randomUUID();
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

  step(`Resolved ${comps.length} comps`);
  const refAudience: Reference = await reference(client, brief.format, comps.map((c) => c.entityId)).catch(() => ({ audience: [], controls: [] }));
  if (refAudience.audience.length)
    log("plan", `Lift is measured against ${referenceLabel(brief.format)} (${refAudience.audience.map((r) => r.name).join(" + ")} fans); controls: ${refAudience.controls.map((r) => r.name).join(", ") || "none"}`);

  const priorWeights = Object.fromEntries(Object.entries(input.prior?.weights ?? {}).filter(([id]) => comps.some((c) => c.entityId === id)));
  const ctx: ToolContext = { client, store, comps, regions: brief.regions, excludeIds: [], ref: refAudience, proposals: new Map(), weights: { ...priorWeights } };
  const attempted: Attempted = new Set();

  const exec = async (call: PlannedCall) => {
    checkpoint();
    attempted.add(attemptKey(call.tool, call.input));
    const out = await runTool(call.tool, call.input, ctx);
    log("tool", `${call.tool}: ${out.label}`, { reason: call.input.reason, input: call.input });
    return out;
  };

  // ---------- coverage (code, parallel) ----------
  const coverage = async (label: string) => {
    for (let round = 0; round < 5; round++) {
      const gaps = assessEvidence(store.all(), comps, brief, attempted, { ref: refAudience, proposals: ctx.proposals, store });
      const calls = dedupe(gaps.map((g) => gapToCall(g, comps, store, ctx.proposals))).filter((c) => !attempted.has(attemptKey(c.tool, c.input)));
      if (!calls.length || client.remaining <= 0) break;
      log("decision", `${label}: ${calls.length} Qloo request group(s)${round ? ` (${gaps.slice(0, 3).map((g) => describeGap(g, comps)).join("; ")})` : ""}`);
      if (round === 0) step(label);
      await Promise.all(calls.map(exec));
      checkpoint();
      if (Date.now() > deadline - 20_000) {
        log("limit", "Wall-clock limit near; proceeding with the evidence gathered");
        break;
      }
    }
  };
  await coverage(input.priorFacts?.length ? "Fetching what changed" : "Mapping partners, markets and comp overlap");

  const gapLabels = () => {
    const out = assessEvidence(store.all(), comps, brief, attempted, { ref: refAudience, proposals: ctx.proposals, store }).map((g) => describeGap(g, comps));
    for (const c of comps) if (!store.all().some((f) => f.kind === "heatmap" && f.compIds[0] === c.entityId)) out.push(`No location signal for ${c.name}; markets ranked on the other comps`);
    return [...new Set(out)];
  };

  // ---------- early result: the audience map, before any writing ----------
  let audience = buildAudienceMap(store.all(), comps, gapLabels(), ctx.weights);
  const defaultAdvice = codeAdvice(audience, comps, store.all(), refAudience);
  audience.advice = input.refinementOnly && input.prior?.advice ? input.prior.advice : defaultAdvice;
  emit({ type: "audience", audience, comps });
  for (const o of audience.overlaps) log("decision", overlapLine(o, comps));
  step("Audience map ready");

  // ---------- agent decisions ----------
  const llm = getLLM();
  let llmUsed = false;
  if (input.refinementOnly) {
    log("decision", "Refinement only: re-using the evidence and the comp decisions of the previous run; no new research");
  } else if (llm && Date.now() < deadline - 25_000) {
    try {
      llmUsed = await researchWithLLM(llm, { brief, comps, client, exec, store, audience, ctx, log, step, deadline, checkpoint, meter, signal: input.signal });
      noteLLM(true);
    } catch (e) {
      if (e instanceof RunAborted) throw e;
      noteLLM(false, e);
      log("error", `Research lead unavailable (${describeLLMError(e)}); using code's comp advice`);
    }
    if (ctx.proposals.size) await coverage("Measuring the agent's partner ideas");
  } else if (!llm) {
    log("plan", "No language model configured: code makes the comp decisions");
  }
  if (client.remaining <= 0) log("limit", `Qloo call budget (${config.maxCallsPerRun()}) reached`);

  // ---------- score ----------
  const facts = store.all();
  audience = buildAudienceMap(facts, comps, gapLabels(), ctx.weights);
  if (input.refinementOnly && input.prior?.advice) audience.advice = input.prior.advice;
  else {
    const gctx0 = makeContext(facts, comps, brief);
    audience.advice = mergeAdvice(codeAdvice(audience, comps, facts, refAudience), ctx.advice, comps, facts, (t) => !validateUncited(t, gctx0));
  }
  logAdvice(audience, comps, log);
  logModelPartners(audience, ctx, log);
  emit({ type: "audience", audience, comps });

  const cand = buildCandidates(audience, brief, facts, ref);
  for (const r of cand.removals) log("validator", `Constraint "${r.constraint}" removed ${r.count} partner candidate(s)`);
  const gctx = makeContext(facts, comps, brief);

  // ---------- conceive ----------
  checkpoint();
  step("Drafting three campaign concepts");
  let concepts: Concept[] | null = null;
  if (llm && Date.now() < deadline - 10_000) {
    try {
      concepts = await conceiveWithLLM(llm, { meter, deadline: llmDeadline, signal: input.signal }, brief, comps, cand, store, audience);
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
    log("critic", `${concepts[j].name} is a near-duplicate; replacing it with a different ${concepts[j].lever} lever`);
    concepts[j] = enforceConstraints([{ ...templates[j], id: concepts[j].id }], brief, facts, ref, cand, [])[0];
  }

  // ---------- critique and repair ----------
  const crit = critique(concepts, cand, audience, comps, facts);
  concepts = crit.concepts;
  for (const n of crit.notes) log("critic", n.message);
  gctx.scores = buildScoreScope(audience, concepts, comps);
  const repairs = new Map(crit.notes.filter((n) => n.repairAngle).map((n) => [n.conceptId, n.repairAngle!]));
  concepts = await groundConcepts(concepts, templates, audience, comps, gctx, repairs, log, llm && llmUsed && Date.now() < deadline ? { llm, opts: { meter, deadline: llmDeadline, signal: input.signal }, brief, store } : null);
  concepts = finalizeConfidence(concepts, facts, comps, false);

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
        const grounded = groundBrief(d, picked.concept, concepts, gctx, log);
        if (grounded.share > THRESHOLDS.maxDroppedShare && attempt === 0) {
          log("validator", `Validator dropped ${Math.round(grounded.share * 100)}% of brief items; regenerating once`);
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
    runId,
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
    ...(input.prior?.runId ? { priorRunId: input.prior.runId } : {}),
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

const pts = (n: number | undefined) => (n === undefined ? "?" : `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n * 100))}`);

function overlapLine(o: AudienceMap["overlaps"][number], comps: Comp[]): string {
  const an = comps.find((c) => c.entityId === o.a)?.name;
  const bn = comps.find((c) => c.entityId === o.b)?.name;
  if (o.mutualLift !== undefined) {
    const verdict = o.verdict === "one" ? "one audience (bridge them)" : o.verdict === "adjacent" ? "adjacent audiences" : "different audiences (pick a lead)";
    return `${an} and ${bn}: ${verdict}. ${bn} inside ${an}'s audience ${pts(o.liftBinA)} points vs a typical audience${o.rankBinA ? ` (#${o.rankBinA} title ${an} fans love)` : ""}; ${an} inside ${bn}'s ${pts(o.liftAinB)}${o.rankAinB ? ` (#${o.rankAinB})` : ""}`;
  }
  return `${an} and ${bn} ${o.similar ? "share an audience" : "look like different audiences"}: ${Math.round(o.themeShare * 100)}% of ${o.themesCompared} themes shared (no cross-affinity measured)`;
}

function logAdvice(audience: AudienceMap, comps: Comp[], log: (k: TraceEntry["kind"], m: string) => void) {
  const a = audience.advice;
  if (!a) return;
  const n = (id: string) => comps.find((c) => c.entityId === id)?.name ?? id;
  log("decision", `Comp audit (${a.by === "agent" ? "agent" : "code"}): lead with ${n(a.lead)}. ${a.leadReason}`);
  if (a.add) log("decision", `Suggested comp: ${a.add.name}. ${a.add.reason}`);
  if (a.drop) log("decision", `Weak anchor: ${n(a.drop.compId)}. ${a.drop.reason}`);
  if (audience.weights) log("decision", `Comp weights: ${Object.entries(audience.weights).map(([id, w]) => `${n(id)} ×${w}`).join(", ")}`);
}

function logModelPartners(audience: AudienceMap, ctx: ToolContext, log: (k: TraceEntry["kind"], m: string) => void) {
  for (const [domain, list] of ctx.proposals) {
    const ranked = audience.partners[domain] ?? [];
    const generic = new Set((audience.generic ?? []).map((p) => p.name));
    const kept = list.filter((p) => ranked.some((r) => r.name === p.name));
    const dropped = list.filter((p) => generic.has(p.name));
    if (kept.length || dropped.length)
      log("critic", `Agent's ${domain} ideas measured in Qloo: kept ${kept.map((p) => p.name).join(", ") || "none"}${dropped.length ? `; dropped as generic ${dropped.map((p) => p.name).join(", ")}` : ""}`);
  }
}

// ---------- LLM phases ----------

function evidenceDigest(audience: AudienceMap, comps: Comp[], store: FactStore): string {
  const n = (id: string) => comps.find((c) => c.entityId === id)?.name ?? id;
  const al = (id: string) => alias(comps.findIndex((c) => c.entityId === id));
  const lines: string[] = [];
  lines.push("ONE AUDIENCE OR TWO (cross-affinity lift vs a typical audience, points):");
  for (const o of audience.overlaps) lines.push(`  ${al(o.a)} ${JSON.stringify(n(o.a))} / ${al(o.b)} ${JSON.stringify(n(o.b))}: ${o.verdict ?? (o.similar ? "one" : "different")}; ${pts(o.liftBinA)} / ${pts(o.liftAinB)}`);
  lines.push("TITLES EACH COMP'S FANS LOVE (rank, name):");
  for (const c of comps) {
    const sim = store.all().filter((f) => f.kind === "similar" && f.compIds[0] === c.entityId).slice(0, 10);
    lines.push(`  ${al(c.entityId)}: ${sim.map((f) => `#${f.detail?.rank} ${JSON.stringify(f.subject?.name)}`).join(", ") || "none"}`);
  }
  lines.push("TOP PARTNERS BY SCORE (lift in points):");
  for (const [d, ps] of Object.entries(audience.partners)) if (ps.length) lines.push(`  ${d}: ${ps.slice(0, 6).map((p) => `${JSON.stringify(p.name)}${p.lift !== undefined ? ` ${pts(p.lift)}` : ""}`).join(", ")}`);
  if (audience.generic?.length) lines.push(`GENERIC (popular with everyone, left out): ${audience.generic.slice(0, 6).map((p) => JSON.stringify(p.name)).join(", ")}`);
  lines.push(`TOP MARKETS: ${audience.markets.slice(0, 6).map((m) => `${m.name}${m.overIndex !== undefined ? ` (over-index ${pts(m.overIndex)})` : ""}`).join(", ")}`);
  const g = [...new Set(comps.flatMap((c) => c.genres ?? []).map((x) => x.split(":").pop()))];
  if (g.length) lines.push(`COMP GENRES: ${g.join(", ")}`);
  if (audience.advice) lines.push(`CODE'S DEFAULT COMP ADVICE: lead ${al(audience.advice.lead)}${audience.advice.add ? `; add ${JSON.stringify(audience.advice.add.name)}` : ""}${audience.advice.drop ? `; drop ${al(audience.advice.drop.compId)}` : ""}`);
  return lines.join("\n");
}

async function researchWithLLM(
  llm: LLM,
  a: {
    brief: Brief;
    comps: Comp[];
    client: QlooClient;
    exec: (c: PlannedCall) => Promise<{ summary: string; isError?: boolean }>;
    store: FactStore;
    audience: AudienceMap;
    ctx: ToolContext;
    log: (k: TraceEntry["kind"], m: string, d?: unknown) => void;
    step: (m: string) => void;
    deadline: number;
    checkpoint: () => void;
    meter: UsageMeter;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const tools = toolDefs(a.comps);
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: `${briefBlock(a.brief, a.comps)}\n\n<evidence>\n${evidenceDigest(a.audience, a.comps, a.store)}\n</evidence>\n\nQloo calls left for your decisions: ${a.client.remaining}. Make your decisions.`,
    },
  ];
  let used = false;
  a.step("Agent is auditing the comps");
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    a.checkpoint();
    if (Date.now() > a.deadline - 25_000) {
      a.log("limit", "Leaving research early to stay inside the time limit");
      break;
    }
    // First turn must act; research turns must end by the wall-clock deadline.
    const r = await llm.toolTurn({ system: RESEARCH_SYSTEM, messages, tools, effort: "low", requireTool: turn === 0, meter: a.meter, phase: "research", deadline: a.deadline, signal: a.signal, maxMs: 20_000 });
    used = true;
    if (r.text.trim()) a.log("plan", r.text.trim().slice(0, 400));
    messages.push({ role: "assistant", content: r.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (!r.toolUses.length) break;
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
    a.step(`Agent decisions, turn ${turn + 1}: ${a.client.calls} Qloo calls so far`);
    const missing = [!a.ctx.advice && "recommend_comps has not been called"].filter(Boolean);
    messages.push({ role: "user", content: [...results, { type: "text", text: `Remaining Qloo calls: ${a.client.remaining}.${missing.length ? ` Still to do: ${missing.join("; ")}.` : ""}` }] });
    if (finish || a.client.remaining <= 0) break;
  }
  return used;
}

type CallOpts = { meter: UsageMeter; deadline: number; signal?: AbortSignal };

async function conceiveWithLLM(llm: LLM, opts: CallOpts, brief: Brief, comps: Comp[], cand: Candidates, store: FactStore, audience: AudienceMap): Promise<Concept[]> {
  const tagFacts = store.summary((f) => f.kind === "tag" || f.kind === "compare" || f.kind === "demographic", 120);
  const supported = supportedTags(audience, comps).map((t) => t.name);
  const overlaps = audience.overlaps
    .map((o) => `${o.a} vs ${o.b}: ${o.verdict ?? (o.similar ? "one" : "different")} audience${o.mutualLift !== undefined ? ` (mutual lift ${o.mutualLift})` : ""}; shared themes ${o.shared.join(", ")}`)
    .join("\n");
  const user = `${briefBlock(brief, comps)}

<candidates>
${candidatesSummary(cand, comps)}
</candidates>

<facts>
${tagFacts}
</facts>

Themes at least two comps share: ${supported.join(", ") || "none"}
${audience.advice ? `Lead comp (from the comp audit): ${comps.find((c) => c.entityId === audience.advice!.lead)?.name}` : ""}

Comp overlap:
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

const RepairOut = z.object({ angles: z.array(z.object({ conceptId: z.string(), text: z.string(), factIds: z.array(z.string()) })) });

// ---------- grounding ----------

/** The UI shows citations as chips, so drop fact IDs the model wrote into the prose (but keep a name like "F1"). */
const tidy = (t: string, g: GroundingContext) => stripCitations(t, g.known).replace(/\s+([.,;:!?])/g, "$1").trim();

/**
 * Repair rather than drop: when a sentence names a market or partner from the concepts but cites
 * only other facts (e.g. tags), attach that item's own facts, so the claim is checked against them.
 */
export function attachNamed(text: string, factIds: string[], items: { name: string; factIds: string[] }[], g: GroundingContext): string[] {
  const clean = stripCitations(text, g.known);
  const named = new Set(namedSubjects(clean, g).map((s) => s.name.toLowerCase()));
  const extra = items.filter((i) => named.has(i.name.toLowerCase())).flatMap((i) => i.factIds.filter((id) => g.facts.get(id)?.kind !== "baseline").slice(0, 2));
  return [...new Set([...factIds, ...extra])];
}

async function groundConcepts(
  concepts: Concept[],
  fallbacks: Concept[],
  audience: AudienceMap,
  comps: Comp[],
  g: GroundingContext,
  criticRepairs: Map<string, string>,
  log: (k: TraceEntry["kind"], m: string) => void,
  repair: { llm: LLM; opts: CallOpts; brief: Brief; store: FactStore } | null,
): Promise<Concept[]> {
  const failed = new Map<string, string>(criticRepairs);
  let out = concepts.map((c) => {
    let { name } = c;
    const nameIssue = validateUncited(name, g);
    if (nameIssue) {
      log("validator", `Concept name dropped: ${nameIssue.reason}`);
      name = fallbacks.find((f) => f.lever === c.lever)?.name ?? name;
    }
    const keep = (xs: string[], label: string) =>
      xs
        .filter((x) => {
          const issue = validateUncited(x, g);
          if (issue) log("validator", `${label} dropped: ${issue.reason}`);
          return !issue;
        })
        .map((x) => tidy(x, g));
    let creativeAngle = { ...c.creativeAngle, factIds: attachNamed(c.creativeAngle.text, c.creativeAngle.factIds, [...c.partners, ...c.markets], g) };
    if (!failed.has(c.id)) {
      const r = validateCited(creativeAngle, g);
      if (!r.ok) failed.set(c.id, r.issue.reason);
      else creativeAngle = { text: tidy(creativeAngle.text, g), factIds: r.factIds };
    }
    return { ...c, name, creativeAngle, risks: keep(c.risks, "Risk"), hypotheses: keep(c.hypotheses, "Hypothesis") };
  });

  // One rewrite for every failed angle, in a single call, with the reason; then the validated template.
  if (failed.size && repair) {
    const allowed = (c: Concept) => {
      const tagIds = supportedTags(audience, comps).flatMap((t) => t.factIds.slice(0, 1));
      return [...new Set([...tagIds, ...c.partners.flatMap((p) => p.factIds.slice(0, 1)), ...c.markets.flatMap((m) => m.factIds.slice(0, 1))])];
    };
    const items = out.filter((c) => failed.has(c.id));
    const user = items
      .map(
        (c) =>
          `<concept id="${c.id}" lever="${c.lever}" name=${JSON.stringify(c.name)}>\nrejected: ${JSON.stringify(c.creativeAngle.text)}\nreason: ${failed.get(c.id)}\nmarkets: ${c.markets.map((m) => m.name).join(", ")}\npartners: ${c.partners.map((p) => p.name).join(", ")}\nallowed facts:\n${repair.store.summary((f) => allowed(c).includes(f.id), 40)}\n</concept>`,
      )
      .join("\n\n");
    try {
      const res = await repair.llm.structured({ system: REPAIR_SYSTEM, user: `${briefBlock(repair.brief, comps)}\n\n${user}\n\nRewrite each angle.`, schema: RepairOut, effort: "low", ...repair.opts, phase: "repair" });
      out = out.map((c) => {
        if (!failed.has(c.id)) return c;
        const r = res.angles.find((x) => x.conceptId === c.id);
        if (!r) return c;
        const ids = attachNamed(r.text, r.factIds.filter((id) => allowed(c).includes(id)), [...c.partners, ...c.markets], g);
        const v = validateCited({ text: r.text, factIds: ids }, g);
        if (!v.ok) {
          log("validator", `Repaired angle for ${c.name} still failed: ${v.issue.reason}`);
          return c;
        }
        log("critic", `Angle for ${c.name} rewritten by the agent (was: ${failed.get(c.id)})`);
        failed.delete(c.id);
        return { ...c, creativeAngle: { text: tidy(r.text, g), factIds: v.factIds } };
      });
    } catch (e) {
      log("error", `Angle repair failed (${describeLLMError(e)})`);
    }
  }
  return out.map((c) => {
    if (!failed.has(c.id)) return c;
    // The template angle is validated too: a tag can carry a sensitive name or an unknown word.
    const fb = fallbacks.find((f) => f.lever === c.lever)?.creativeAngle;
    const v = fb ? validateCited(fb, g) : null;
    if (fb && v?.ok) {
      log("validator", `Creative angle replaced with the evidence template: ${failed.get(c.id)}`);
      return { ...c, creativeAngle: { text: fb.text, factIds: v.factIds } };
    }
    const tag = supportedTags(audience, comps)[0] ?? audience.tags[0];
    log("validator", `Creative angle replaced with a minimal one: ${failed.get(c.id)}`);
    return { ...c, creativeAngle: tag ? { text: `Lead the creative with “${tag.name}”, a theme the comps' fans share.`, factIds: tag.factIds.slice(0, 1) } : { text: "Lead with the comps' shared tastes.", factIds: [] } };
  });
}

function groundBrief(
  d: z.infer<typeof BriefOut>,
  rec: Concept,
  concepts: Concept[],
  g: GroundingContext,
  log: (k: TraceEntry["kind"], m: string) => void,
): { brief: DecisionBrief; share: number } {
  let total = 0;
  let dropped = 0;
  const items = concepts.flatMap((c) => [...c.partners, ...c.markets]);
  const cited = (xs: { text: string; factIds: string[] }[]) =>
    xs.flatMap((it) => {
      total++;
      const r = validateCited({ text: it.text, factIds: attachNamed(it.text, it.factIds, items, g) }, g);
      if (!r.ok) {
        dropped++;
        log("validator", `Dropped: ${r.issue.reason} — ${JSON.stringify(it.text.slice(0, 120))}`);
        return [];
      }
      return [{ text: tidy(it.text, g), factIds: r.factIds }];
    });
  const plain = (xs: string[]) =>
    xs
      .filter((t) => {
        total++;
        const issue = validateUncited(t, g);
        if (issue) {
          dropped++;
          log("validator", `Dropped: ${issue.reason} — ${JSON.stringify(t.slice(0, 120))}`);
        }
        return !issue;
      })
      .map((t) => tidy(t, g));
  // Tests are rendered by code from a type and the recommended concept's own items; the model's
  // "why" is kept only if it passes the validator and names nothing outside the plan.
  const inPlan = new Set([...rec.partners, ...rec.markets].map((x) => x.name.toLowerCase()));
  const whyOk = (t: string) => {
    if (validateUncited(t, g)) return false;
    if (namedSubjects(stripCitations(t, g.known), g).some((s) => !inPlan.has(s.name.toLowerCase()))) return false;
    return !INVENTED_RELATED.test(t);
  };
  const rendered = renderTests(
    d.tests.map((t) => ({ ...t, why: t.why && whyOk(t.why) ? tidy(t.why, g) : undefined })),
    rec,
  );
  total += d.tests.length;
  dropped += rendered.dropped.length;
  for (const x of rendered.dropped) log("validator", `Test dropped: ${x.type} ${x.reason}`);
  const brief: DecisionBrief = {
    recommendedId: rec.id,
    rationale: cited(d.rationale),
    whyNotOthers: cited(d.whyNotOthers),
    tradeoffs: plain(d.tradeoffs),
    testChecklist: rendered.tests.map((t) => t.text),
    tests: rendered.tests,
    disclaimer: DISCLAIMER,
    writtenBy: "llm",
    droppedSentences: dropped,
  };
  return { brief, share: total ? dropped / total : 0 };
}
