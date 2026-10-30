import { z } from "zod";
import { allowHit, clientIp, getRun } from "@/lib/runs";
import { runBaseline } from "@/lib/baseline";
import { config } from "@/lib/config";

export const maxDuration = 120;

const Body = z.object({ runId: z.string().max(64) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 422 });
  const run = getRun(parsed.data.runId);
  if (!run) return Response.json({ error: "Run not found (the server may have restarted). Re-run the plan." }, { status: 404 });
  // Each baseline spends model credits and up to 24 Qloo lookups.
  if (config.mode === "live" && !allowHit("baseline", clientIp(req)))
    return Response.json({ error: "Too many baseline comparisons from this visitor. Please wait a few minutes." }, { status: 429 });
  return Response.json(await runBaseline(run));
}
