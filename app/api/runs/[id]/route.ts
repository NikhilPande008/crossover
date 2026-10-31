// A stored run, for shared brief links (/r/{id}) and for resuming after a dropped stream.

import { forClient, getRun } from "@/lib/runs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return Response.json({ error: "Run not found. Runs are kept for 30 days when the durable store is configured." }, { status: 404 });
  return Response.json(forClient(run), { headers: { "cache-control": "private, max-age=60" } });
}
