import { z } from "zod";
import { allowHit, clientIp, getRun } from "@/lib/runs";
import { runBaseline } from "@/lib/baseline";
import { config } from "@/lib/config";
import { BriefSchema, CompSchema } from "@/lib/validate/input";
import type { RunResult } from "@/lib/types";

export const maxDuration = 120;

// The client also sends the parts of the run the baseline needs, for when this instance never saw it.
// Client-supplied facts only decide which of the model's partners count as "in evidence" for that viewer.
const SentRun = z.object({
  runId: z.string().max(64),
  mode: z.enum(["live", "fixture", "recorded"]),
  brief: BriefSchema,
  comps: z.array(CompSchema).min(2).max(4),
  facts: z.array(z.object({ kind: z.string(), value: z.unknown(), subject: z.object({ name: z.string() }).passthrough().optional() }).passthrough()).max(800),
});
const Body = z.object({ runId: z.string().max(64), run: SentRun.optional() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 422 });
  const run = getRun(parsed.data.runId) ?? (parsed.data.run as unknown as RunResult | undefined);
  if (!run) return Response.json({ error: "Run not found (the server may have restarted). Re-run the plan." }, { status: 404 });
  // Each baseline spends model credits and up to 24 Qloo lookups.
  if (config.mode === "live" && !allowHit("baseline", clientIp(req)))
    return Response.json({ error: "Too many baseline comparisons from this visitor. Please wait a few minutes." }, { status: 429 });
  return Response.json(await runBaseline(run));
}
