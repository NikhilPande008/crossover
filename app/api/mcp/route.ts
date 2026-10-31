// Minimal MCP server (Streamable HTTP, JSON responses only) over the existing pipeline.
//   plan_release   resolve comps, run the planner, store the run, return the brief and its link
//   compare_comps  one audience or two, per comp pair, for a stored run
//   score_partners partners with lift vs a typical audience, and those left out as generic
// Same quota floor and per-visitor caps as the web app. Stateless: no sessions, no streaming.

import { z } from "zod";
import { BriefSchema } from "@/lib/validate/input";
import { resolveComps, bestCandidate, TYPES_FOR_FORMAT } from "@/lib/agent/resolve";
import { runPlan } from "@/lib/agent/loop";
import { QlooClient, belowQuotaFloor } from "@/lib/qloo/client";
import { allowHit, capLimit, clientIp, getRun, saveRun } from "@/lib/runs";
import { isCloseMatch } from "@/lib/match";
import { config } from "@/lib/config";
import { liftPoints, referenceLabel } from "@/lib/labels";
import type { Comp, RunResult } from "@/lib/types";

export const maxDuration = 120;

const PROTOCOL = "2025-06-18";
const RunIdArg = { type: "object", properties: { runId: { type: "string", description: "runId returned by plan_release" } }, required: ["runId"] } as const;

const TOOLS = [
  {
    name: "plan_release",
    description: "Plan a release campaign from 2-4 comparable titles using Qloo's taste graph. Takes 20-60 s. Returns the recommended concept, lead comp, partners with lift, markets, and a share link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        format: { type: "string", enum: ["film", "series", "album", "tour", "special"] },
        logline: { type: "string" },
        comps: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 },
        regions: { type: "array", items: { type: "string", enum: ["US", "GB"] }, minItems: 1, maxItems: 2 },
        budget: { type: "string", enum: ["S", "M", "L"] },
        exclusions: { type: "array", items: { type: "string" } },
      },
      required: ["title", "format", "comps"],
    },
  },
  { name: "compare_comps", description: "One audience or two: Qloo cross-affinity verdict for each comp pair in a planned run.", inputSchema: RunIdArg },
  { name: "score_partners", description: "Partners for a planned run with lift vs a typical audience, plus partners left out as generic.", inputSchema: RunIdArg },
];

const PlanArgs = BriefSchema.extend({ regions: BriefSchema.shape.regions.default(["US"]), budget: BriefSchema.shape.budget.default("M"), exclusions: BriefSchema.shape.exclusions.default([]) });

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const ok = (id: Rpc["id"], result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => Response.json({ jsonrpc: "2.0", id, error: { code, message } });
const text = (id: Rpc["id"], body: string, isError = false) => ok(id, { content: [{ type: "text", text: body }], isError });

function link(req: Request, runId: string) {
  return `${new URL(req.url).origin}/r/${runId}`;
}

function summary(req: Request, r: RunResult): string {
  const rec = r.concepts.find((c) => c.id === r.decision.recommendedId)!;
  const name = (id: string) => r.comps.find((c) => c.entityId === id)?.name ?? id;
  const lift = (n: string) => Object.values(r.audience.partners).flat().find((p) => p.name === n)?.lift;
  return [
    `Run ${r.runId} (${r.mode} data) · ${link(req, r.runId)}`,
    r.audience.advice ? `Lead with ${name(r.audience.advice.lead)}: ${r.audience.advice.leadReason}` : "",
    `Recommended: ${rec.name} (${rec.lever}, ${rec.confidence} confidence)`,
    `Markets: ${rec.markets.map((m) => m.name).join(", ")}`,
    `Partners: ${rec.partners.map((p) => (lift(p.name) !== undefined ? `${p.name} (${liftPoints(lift(p.name)!)})` : p.name)).join(", ")}`,
    `Creative angle: ${rec.creativeAngle.text}`,
    `Tests: ${(r.decision.tests?.map((t) => t.text) ?? r.decision.testChecklist).join(" | ")}`,
    r.decision.disclaimer,
  ]
    .filter(Boolean)
    .join("\n");
}

async function planRelease(req: Request, id: Rpc["id"], args: unknown) {
  const parsed = PlanArgs.safeParse(args);
  if (!parsed.success) return text(id, `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, true);
  if (config.mode === "live") {
    if (belowQuotaFloor()) return text(id, "Live Qloo quota is at its reserve floor. Try later.", true);
    if (!(await allowHit("run", clientIp(req)))) return text(id, `Live runs are capped at ${capLimit("run")} per hour per caller.`, true);
  }
  const brief = parsed.data;
  const resolutions = await resolveComps(new QlooClient({ maxCalls: 6 }), brief.comps, TYPES_FOR_FORMAT[brief.format]);
  const comps: Comp[] = [];
  const missing: string[] = [];
  for (const r of resolutions) {
    const c = bestCandidate(r);
    if (c && isCloseMatch(r.query, c.name) && !comps.some((k) => k.entityId === c.entityId)) comps.push(c);
    else missing.push(r.query);
  }
  if (comps.length < 2) return text(id, `Could not match enough comps in Qloo (not found: ${missing.join(", ")}). Use exact titles.`, true);
  const result = await runPlan({ brief: { ...brief, comps: comps.map((c) => c.name) }, comps, signal: AbortSignal.timeout(110_000) });
  await saveRun(result);
  return text(id, (missing.length ? `Left out (no close match): ${missing.join(", ")}\n` : "") + summary(req, result));
}

async function withRun(id: Rpc["id"], args: unknown, f: (r: RunResult) => string) {
  const runId = z.object({ runId: z.string().max(64) }).safeParse(args);
  if (!runId.success) return text(id, "runId is required.", true);
  const run = await getRun(runId.data.runId);
  return run ? text(id, f(run)) : text(id, "Run not found (runs are kept for 30 days when the durable store is configured).", true);
}

function compare(r: RunResult): string {
  const name = (id: string) => r.comps.find((c) => c.entityId === id)?.name ?? id;
  return r.audience.overlaps
    .map((o) =>
      o.mutualLift !== undefined
        ? `${name(o.a)} / ${name(o.b)}: ${o.verdict} (mutual lift ${liftPoints(o.mutualLift)} points; ${name(o.b)} in ${name(o.a)}'s audience ${liftPoints(o.liftBinA!)}${o.rankBinA ? `, #${o.rankBinA}` : ""}; ${name(o.a)} in ${name(o.b)}'s ${liftPoints(o.liftAinB!)}${o.rankAinB ? `, #${o.rankAinB}` : ""})`
        : `${name(o.a)} / ${name(o.b)}: ${o.verdict ?? (o.similar ? "one" : "different")} (theme share ${Math.round(o.themeShare * 100)}%)`,
    )
    .join("\n");
}

function partners(r: RunResult): string {
  const ref = referenceLabel(r.brief.format);
  const rows = Object.entries(r.audience.partners).flatMap(([d, ps]) => ps.slice(0, 8).map((p) => `${d}\t${p.name}\t${p.lift !== undefined ? liftPoints(p.lift) : "n/a"}`));
  const generic = (r.audience.generic ?? []).slice(0, 15).map((p) => `${p.domain}\t${p.name}\t${p.combined} here vs ${p.baseline} for ${ref}`);
  return [`domain\tpartner\tlift vs ${ref} (points)`, ...rows, "", `Left out as generic (lift ≤ 0):`, ...(generic.length ? generic : ["none measured"])].join("\n");
}

export async function POST(req: Request) {
  const msg = (await req.json().catch(() => null)) as Rpc | null;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(null, -32600, "Invalid request");
  // Notifications get no response body.
  if (msg.id === undefined) return new Response(null, { status: 202 });
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "crossover", version: "0.1.0" } });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      try {
        if (name === "plan_release") return await planRelease(req, msg.id, args);
        if (name === "compare_comps") return await withRun(msg.id, args, compare);
        if (name === "score_partners") return await withRun(msg.id, args, partners);
        return fail(msg.id, -32602, `Unknown tool: ${String(name)}`);
      } catch (e) {
        console.error("mcp tool failed", e);
        return text(msg.id, "The tool failed unexpectedly. Please try again.", true);
      }
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export function GET() {
  return new Response("Crossover MCP endpoint: POST JSON-RPC (initialize, tools/list, tools/call).", { status: 405, headers: { allow: "POST" } });
}
