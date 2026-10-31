import { QlooClient, belowQuotaFloor } from "@/lib/qloo/client";
import { resolveComps, TYPES_FOR_FORMAT } from "@/lib/agent/resolve";
import { ResolveRequest } from "@/lib/validate/input";
import { config } from "@/lib/config";
import { allowHit, clientIp } from "@/lib/runs";

export async function POST(req: Request) {
  const parsed = ResolveRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 422 });
  if (config.mode === "live" && belowQuotaFloor())
    return Response.json({ error: "Live Qloo quota is reserved for judging presets right now. Try a preset." }, { status: 503 });
  if (config.mode === "live" && !(await allowHit(parsed.data.suggest ? "suggest" : "resolve", clientIp(req))))
    return Response.json({ error: "Too many lookups from this visitor. Please wait a few minutes." }, { status: 429 });
  const client = new QlooClient({ maxCalls: 6 });
  const resolutions = await resolveComps(client, parsed.data.comps, TYPES_FOR_FORMAT[parsed.data.format]);
  return Response.json({ mode: client.mode, resolutions });
}
