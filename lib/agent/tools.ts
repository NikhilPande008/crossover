// Tools exposed to the research agent. Each wraps lib/qloo and returns a compact
// fact summary (never raw Qloo responses) to the LLM.

import type Anthropic from "@anthropic-ai/sdk";
import type { Comp, Domain, Fact } from "@/lib/types";
import type { FactStore } from "@/lib/facts/store";
import { BudgetExhaustedError, QlooClient, QlooError } from "@/lib/qloo/client";
import { compareAudiences, fetchAffinities, fetchDemographics, fetchHeatmap, fetchTags } from "@/lib/qloo/api";
import { REGIONS } from "@/lib/geo/cities";
import { compareGroup } from "@/lib/score";

export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = [
  {
    name: "audience_affinities",
    description:
      "Cross-domain affinities of the audience defined by one or more comps. Pass one comp for per-comp attribution, or several to combine them into one signal (useful when per-comp results are thin). Returns top entities in the domain with affinity and fact IDs.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        comp_ids: { type: "array", items: { type: "string" }, description: "Entity IDs of confirmed comps" },
        domain: { type: "string", enum: ["artist", "podcast", "tv_show", "movie", "book", "brand"] },
        reason: { type: "string", description: "One short sentence: why this call, shown in the trace" },
      },
      required: ["comp_ids", "domain", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "audience_tags",
    description: "Taste tags (themes, genres, moods) the audience of the given comps over-indexes on. Use for creative-angle evidence.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { comp_ids: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
      required: ["comp_ids", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "audience_demographics",
    description: "Aggregate age and gender skew of one comp's audience. Group-level only.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { comp_id: { type: "string" }, reason: { type: "string" } },
      required: ["comp_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "fan_markets",
    description: "Where one comp's fans concentrate within a country (heatmap), mapped to cities. Region must be one of the brief's regions.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { comp_id: { type: "string" }, region: { type: "string", enum: Object.keys(REGIONS) }, reason: { type: "string" } },
      required: ["comp_id", "region", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_audiences",
    description: "Compare two comps' audiences: which taste tags they share and where they diverge. Tells you whether they are one audience or two.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { a_id: { type: "string" }, b_id: { type: "string" }, reason: { type: "string" } },
      required: ["a_id", "b_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish_research",
    description: "Call when the evidence is sufficient (or limits are near). Give the reason.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
];

export type ToolContext = {
  client: QlooClient;
  store: FactStore;
  comps: Comp[];
  regions: string[];
  excludeIds: string[];
};

export type ToolOutcome = { summary: string; facts: Fact[]; isError?: boolean; label: string };

function fmt(facts: Fact[], max = 10) {
  if (!facts.length) return "No Qloo signal (0 results).";
  return facts
    .slice(0, max)
    .map((f) => `${f.id} ${JSON.stringify(f.subject?.name ?? "")} ${typeof f.value === "number" ? f.value : JSON.stringify(f.value)}`)
    .join("\n");
}

/** Tolerates a bare string where an array was expected (smaller open models do this). */
function compsFor(ids: unknown, ctx: ToolContext): Comp[] {
  const list = Array.isArray(ids) ? ids : typeof ids === "string" ? [ids] : [];
  return list.map((id) => ctx.comps.find((c) => c.entityId === String(id))).filter((c): c is Comp => !!c);
}

const DOMAINS = new Set(["artist", "podcast", "tv_show", "movie", "book", "brand"]);

const name = (c: Comp) => c.name;

export async function runTool(toolName: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!input || typeof input !== "object" || "__invalid_arguments" in input)
    return { summary: "Error: tool arguments were not valid JSON. Call the tool again with valid arguments.", facts: [], isError: true, label: "invalid tool arguments" };
  try {
    switch (toolName) {
      case "audience_affinities": {
        const comps = compsFor(input.comp_ids, ctx);
        if (!comps.length) return { summary: "Error: unknown comp_ids. Use the confirmed comp IDs.", facts: [], isError: true, label: "bad comp ids" };
        const domain = input.domain as Domain;
        if (!DOMAINS.has(domain)) return { summary: `Error: domain must be one of ${[...DOMAINS].join(", ")}.`, facts: [], isError: true, label: "bad domain" };
        const facts = await fetchAffinities(ctx.client, ctx.store, comps, domain, ctx.excludeIds);
        return { summary: fmt(facts), facts, label: `${domain} affinities for ${comps.map(name).join(" + ")} (${facts.length})` };
      }
      case "audience_tags": {
        const comps = compsFor(input.comp_ids, ctx);
        if (!comps.length) return { summary: "Error: unknown comp_ids.", facts: [], isError: true, label: "bad comp ids" };
        const facts = await fetchTags(ctx.client, ctx.store, comps);
        return { summary: fmt(facts, 12), facts, label: `taste tags for ${comps.map(name).join(" + ")} (${facts.length})` };
      }
      case "audience_demographics": {
        const [comp] = compsFor(input.comp_id, ctx);
        if (!comp) return { summary: "Error: unknown comp_id.", facts: [], isError: true, label: "bad comp id" };
        const facts = await fetchDemographics(ctx.client, ctx.store, comp);
        return { summary: fmt(facts), facts, label: `demographic skew for ${comp.name}` };
      }
      case "fan_markets": {
        const [comp] = compsFor(input.comp_id, ctx);
        const region = String(input.region);
        if (!comp) return { summary: "Error: unknown comp_id.", facts: [], isError: true, label: "bad comp id" };
        if (!ctx.regions.includes(region)) return { summary: `Error: region must be one of ${ctx.regions.join(", ")}.`, facts: [], isError: true, label: "bad region" };
        const facts = (await fetchHeatmap(ctx.client, ctx.store, comp, region)).sort((a, b) => (b.value as number) - (a.value as number));
        return { summary: fmt(facts, 8), facts, label: `fan markets for ${comp.name} in ${region} (${facts.length} cities)` };
      }
      case "compare_audiences": {
        const [a] = compsFor(input.a_id, ctx);
        const [b] = compsFor(input.b_id, ctx);
        if (!a || !b) return { summary: "Error: unknown comp id.", facts: [], isError: true, label: "bad comp id" };
        const facts = await compareAudiences(ctx.client, ctx.store, a, b);
        if (!facts) return { summary: "Compare endpoint unavailable; overlap will be estimated from shared tags in code.", facts: [], label: `compare ${a.name} vs ${b.name} (estimated)` };
        const shared = facts.filter((f) => compareGroup(f) === "shared").length;
        const line = (f: Fact) => `${f.id} ${JSON.stringify(f.subject?.name ?? "")} ${compareGroup(f) === "shared" ? "shared" : compareGroup(f) === "a" ? `more ${a.name}` : `more ${b.name}`}`;
        return {
          summary: `${shared} of ${facts.length} tags shared.\n${facts.slice(0, 14).map(line).join("\n")}`,
          facts,
          label: `compared ${a.name} vs ${b.name}: ${shared}/${facts.length} tags shared`,
        };
      }
      default:
        return { summary: `Unknown tool ${toolName}`, facts: [], isError: true, label: `unknown tool ${toolName}` };
    }
  } catch (e) {
    if (e instanceof BudgetExhaustedError) return { summary: "Qloo call budget exhausted. Call finish_research.", facts: [], isError: true, label: "budget exhausted" };
    if (e instanceof QlooError) return { summary: `Qloo error ${e.status}; treat as no signal.`, facts: [], isError: true, label: `Qloo error ${e.status}` };
    throw e;
  }
}
