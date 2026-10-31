// Runs the agent and streams progress as Server-Sent Events.

import type { ProgressEvent, RunResult } from "@/lib/types";
import { RunAborted, runPlan } from "@/lib/agent/loop";
import { PlanRequest, EXAMPLE_PLAN_REQUEST } from "@/lib/validate/input";
import { allowHit, capLimit, clientIp, getRun, isRefinementOf, loadRecorded, recordPreset, saveRun } from "@/lib/runs";
import { belowQuotaFloor } from "@/lib/qloo/client";
import { config } from "@/lib/config";
import { matchesPreset } from "@/lib/presets";

export const maxDuration = 120;

/** Partner tag lists are only needed server-side (exclusion checks) and are over a third of the payload. */
function forClient(r: RunResult): RunResult {
  return {
    ...r,
    facts: r.facts.map((f) => {
      if (!f.detail || !("tags" in f.detail)) return f;
      const { tags: _tags, ...detail } = f.detail;
      void _tags;
      return { ...f, detail };
    }),
  };
}

export async function POST(req: Request) {
  const parsed = PlanRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues, example: EXAMPLE_PLAN_REQUEST }, { status: 422 });
  const body = parsed.data;
  const prior = body.priorRunId ? getRun(body.priorRunId) : undefined;
  // Classify server-side: a priorRunId with a new comp set is a new run, not a refinement.
  const isRefinement = isRefinementOf(
    prior,
    body.comps.map((c) => c.entityId),
  );
  // A preset's recording is written and replayed only for that preset's own, unedited brief.
  const presetId = body.presetId && !isRefinement && matchesPreset(body.presetId, body.brief) ? body.presetId : undefined;

  // Aborts the agent when the browser goes away, so abandoned runs stop spending quota.
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort());
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      // SSE comment every 10 s so proxies and browsers don't drop the stream during a long model call.
      const ping = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(": ping\n\n"));
        } catch {
          open = false;
          abort.abort();
        }
      }, 10_000);
      const send = (e: ProgressEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
          abort.abort();
        }
      };
      try {
        // Live-mode guards: quota floor and per-visitor caps. Presets fall back to recorded live runs.
        let blocked: string | null = null;
        if (config.mode === "live") {
          const bucket = isRefinement ? "refine" : "run";
          if (belowQuotaFloor()) blocked = "Live Qloo quota is at its reserve floor.";
          else if (!allowHit(bucket, clientIp(req)))
            blocked = `Live ${isRefinement ? "re-plans" : "runs"} are capped at ${capLimit(bucket)} per hour per visitor.`;
        }
        if (blocked) {
          const rec = presetId ? loadRecorded(presetId) : undefined;
          if (!rec) {
            send({ type: "error", message: `${blocked} Try again later, or open a preset to see a recorded live run.` });
            return;
          }
          send({ type: "step", message: `${blocked} Replaying a recorded live run (no Qloo calls made now).`, calls: 0 });
          const replay: RunResult = { ...rec, runId: crypto.randomUUID() };
          saveRun(replay);
          send({ type: "result", result: forClient(replay) });
          return;
        }

        const result = await runPlan(
          {
            brief: body.brief,
            comps: body.comps,
            refinements: body.refinements,
            priorFacts: isRefinement ? prior?.facts : undefined,
            signal: abort.signal,
          },
          send,
        );
        saveRun(result);
        if (presetId && body.refinements.excludedPartners.length === 0 && body.refinements.pinnedMarkets.length === 0) recordPreset(presetId, result);
        send({ type: "result", result: forClient(result) });
      } catch (e) {
        if (e instanceof RunAborted) return;
        console.error("plan failed", e);
        send({ type: "error", message: "The run failed unexpectedly. Please try again." });
      } finally {
        clearInterval(ping);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by a cancelled reader
          }
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
