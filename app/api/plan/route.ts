// Starts a run and streams its progress as Server-Sent Events.
// The run is not tied to this connection: it keeps going after a dropped stream (after()
// keeps the function alive), logs every event under its runId, and stores the result, so
// the browser can resume with GET /api/runs/{id}/events and a shared link can open it later.

import { after } from "next/server";
import { randomUUID } from "node:crypto";
import type { ProgressEvent, RunResult } from "@/lib/types";
import { RunAborted, runPlan } from "@/lib/agent/loop";
import { PlanRequest, EXAMPLE_PLAN_REQUEST } from "@/lib/validate/input";
import { EventLog, allowHit, capLimit, clientIp, forClient, getRun, isRefinementOf, loadRecorded, recordPreset, saveRun } from "@/lib/runs";
import { belowQuotaFloor } from "@/lib/qloo/client";
import { config } from "@/lib/config";
import { matchesPreset } from "@/lib/presets";

export const maxDuration = 120;

/** Hard stop for a run nobody can see any more, inside maxDuration. */
const RUN_LIMIT_MS = 112_000;

export async function POST(req: Request) {
  const parsed = PlanRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues, example: EXAMPLE_PLAN_REQUEST }, { status: 422 });
  const body = parsed.data;
  const prior = body.priorRunId ? await getRun(body.priorRunId) : undefined;
  const compIds = body.comps.map((c) => c.entityId);
  // Classify server-side: a priorRunId with a new comp set is a new run, not a refinement.
  const isRefinement = isRefinementOf(prior, compIds);
  const sameComps = !!prior && isRefinement && prior.comps.length === compIds.length && prior.comps.every((c) => compIds.includes(c.entityId));
  // A preset's recording is written and replayed only for that preset's own, unedited brief.
  const presetId = body.presetId && !isRefinement && matchesPreset(body.presetId, body.brief) ? body.presetId : undefined;

  const runId = randomUUID();
  const events = new EventLog(runId);
  const listeners = new Set<(e: ProgressEvent) => void>();
  const publish = (e: ProgressEvent) => {
    events.push(e);
    for (const l of listeners) l(e);
  };
  publish({ type: "run", runId });


  const enc = new TextEncoder();
  let n = 0;
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        cleanup();
        try {
          controller.close();
        } catch {
          // already closed by a cancelled reader
        }
      };
      const send = (e: ProgressEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`id: ${n++}\ndata: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
        if (e.type === "result" || e.type === "error") close();
      };
      // The run event was published before anyone listened.
      send({ type: "run", runId });
      // SSE comment every 10 s so proxies and browsers don't drop the stream during a long model call.
      const ping = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          open = false;
        }
      }, 10_000);
      listeners.add(send);
      cleanup = () => {
        clearInterval(ping);
        listeners.delete(send);
      };
    },
    cancel() {
      // The browser went away; the run continues and can be resumed from the event log.
      cleanup();
    },
  });

  // Started after the stream subscribes, so no early event is missed.
  const work = (async () => {
    // Live-mode guards: quota floor and per-visitor caps. Presets fall back to recorded live runs.
    let blocked: string | null = null;
    if (config.mode === "live") {
      const bucket = isRefinement ? "refine" : "run";
      if (belowQuotaFloor()) blocked = "Live Qloo quota is at its reserve floor.";
      else if (!(await allowHit(bucket, clientIp(req)))) blocked = `Live ${isRefinement ? "re-plans" : "runs"} are capped at ${capLimit(bucket)} per hour per visitor.`;
    }
    if (blocked) {
      const rec = presetId ? await loadRecorded(presetId) : undefined;
      if (!rec) return publish({ type: "error", message: `${blocked} Try again later, or open a preset to see a recorded live run.` });
      publish({ type: "step", message: `${blocked} Replaying a recorded live run (no Qloo calls made now).`, calls: 0 });
      const replay: RunResult = { ...rec, runId };
      await saveRun(replay);
      return publish({ type: "result", result: forClient(replay) });
    }
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), RUN_LIMIT_MS);
    try {
      const result = await runPlan(
        {
          brief: body.brief,
          comps: body.comps,
          refinements: body.refinements,
          priorFacts: isRefinement ? prior?.facts : undefined,
          prior: prior && isRefinement ? { runId: prior.runId, weights: prior.audience.weights, advice: prior.audience.advice } : undefined,
          refinementOnly: sameComps,
          runId,
          signal: stop.signal,
        },
        publish,
      );
      await saveRun(result);
      if (presetId && body.refinements.excludedPartners.length === 0 && body.refinements.pinnedMarkets.length === 0) await recordPreset(presetId, result);
      publish({ type: "result", result: forClient(result) });
    } catch (e) {
      if (!(e instanceof RunAborted)) console.error("plan failed", e);
      publish({ type: "error", message: e instanceof RunAborted ? "The run took too long and was stopped. Please try again." : "The run failed unexpectedly. Please try again." });
    } finally {
      clearTimeout(timer);
      await events.flush();
    }
  })();
  // Keep the function alive until the run is stored, even if the browser's stream drops.
  after(() => work);

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-run-id": runId },
  });
}
