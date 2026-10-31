import { z } from "zod";
import { allowHit, clientIp, getRun } from "@/lib/runs";
import { runBaseline } from "@/lib/baseline";
import { config } from "@/lib/config";
import { BriefSchema, CompSchema } from "@/lib/validate/input";
import type { RunResult } from "@/lib/types";

export const maxDuration = 120;

// The client also sends the parts of the run the baseline needs, for when this instance never saw it.
// Client-supplied facts only decide which of the model's partners count as "in evidence" for that viewer.
// Only the fields the baseline reads are kept; anything else is stripped.
const SentRun = z.object({
  runId: z.string().max(64),
  mode: z.enum(["live", "fixture", "recorded"]),
  brief: BriefSchema,
  comps: z.array(CompSchema).min(2).max(4),
  facts: z.array(z.object({ kind: z.string().max(20), value: z.unknown(), compIds: z.array(z.string().max(200)).max(4).default([]), subject: z.object({ name: z.string().max(300) }).optional() })).max(2500),
  concepts: z.array(z.object({ partners: z.array(z.object({ name: z.string().max(300), domain: z.string().max(20) })).max(10) })).max(3).default([]),
  audience: z
    .object({
      partners: z.record(z.string(), z.array(z.object({ name: z.string().max(300), lift: z.number().optional() }).loose()).max(80)),
      markets: z.array(z.object({ name: z.string().max(80), score: z.number(), concentration: z.number().optional() }).loose()).max(60),
    })
    .loose()
    .default({ partners: {}, markets: [] }),
});
// The sent run is validated only when this instance has no copy, so a bad copy never blocks a known run.
const Body = z.object({ runId: z.string().max(64), run: z.unknown().optional() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 422 });
  let run = await getRun(parsed.data.runId);
  if (!run && parsed.data.run !== undefined) {
    const sent = SentRun.safeParse(parsed.data.run);
    if (!sent.success) return Response.json({ error: "Invalid request" }, { status: 422 });
    // A fixture-mode server never makes live lookups, whatever the client says the run was.
    run = { ...sent.data, mode: config.mode === "fixture" ? "fixture" : sent.data.mode } as unknown as RunResult;
  }
  if (!run) return Response.json({ error: "Run not found (the server may have restarted). Re-run the plan." }, { status: 404 });
  // Each baseline spends model credits and up to 24 Qloo lookups.
  if (config.mode === "live" && !(await allowHit("baseline", clientIp(req))))
    return Response.json({ error: "Too many baseline comparisons from this visitor. Please wait a few minutes." }, { status: 429 });
  return Response.json(await runBaseline(run));
}
