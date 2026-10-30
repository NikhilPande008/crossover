import { connection } from "next/server";
import { config } from "@/lib/config";
import { quotaStatus, belowQuotaFloor } from "@/lib/qloo/client";
import { llmStatus } from "@/lib/llm/provider";
import { usageTotals } from "@/lib/llm/usage";

export async function GET() {
  await connection(); // always evaluate at request time
  const q = quotaStatus();
  return Response.json({
    mode: config.mode,
    // Which commit this deployment was built from, so a stale production alias is easy to spot.
    build: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    qloo: { baseUrl: config.qlooBaseUrl(), keyConfigured: Boolean(config.qlooKey()), quotaRemaining: q.remaining ?? null, quotaFloor: q.floor, belowFloor: belowQuotaFloor(), liveCallsSinceBoot: q.liveCalls, errorsByStatus: q.errors },
    llm: { ...llmStatus(), usageSinceBoot: usageTotals() },
    limits: { maxCallsPerRun: config.maxCallsPerRun(), liveRunsPerIpHour: config.runsPerIpHour() },
  });
}
