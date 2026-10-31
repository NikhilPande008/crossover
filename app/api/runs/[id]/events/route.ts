// Resume a run's progress stream from event `from` (SSE). Any instance can serve it when the
// durable store is configured, because the run's events and result are stored there.

import { forClient, getRun, readEvents } from "@/lib/runs";

export const maxDuration = 120;

const POLL_MS = 700;
const LIMIT_MS = 110_000;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const from = Math.max(0, Number(new URL(req.url).searchParams.get("from") ?? 0) || 0);
  const first = await readEvents(id, from);
  const done = await getRun(id);
  if (!first.length && !done) return Response.json({ error: "Run not found on this server. Re-run the plan." }, { status: 404 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let n = from;
      let open = true;
      const send = (data: unknown, comment = false) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(comment ? `: ${data}\n\n` : `id: ${n++}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          open = false;
        }
      };
      const t0 = Date.now();
      let batch = first;
      let lastPing = Date.now();
      while (open && Date.now() - t0 < LIMIT_MS) {
        for (const e of batch) {
          if (e.type === "done") {
            const run = await getRun(e.runId);
            send(run ? { type: "result", result: forClient(run) } : { type: "error", message: "The run finished but its result could not be loaded. Please re-run." });
            open = false;
            break;
          }
          if (e.type === "run") {
            n++;
            continue;
          }
          send(e);
          if (e.type === "error") open = false;
        }
        if (!open) break;
        if (req.signal.aborted) break;
        if (Date.now() - lastPing > 10_000) {
          send("ping", true);
          lastPing = Date.now();
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        batch = await readEvents(id, n);
      }
      if (open) send({ type: "error", message: "Lost track of the run. Please try again." });
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
