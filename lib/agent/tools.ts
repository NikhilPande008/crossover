// Tools: the research agent's (exposed to the model) and the coverage calls code makes
// itself. Each wraps lib/qloo and returns a compact fact summary (never raw Qloo
// responses) to the model. Comps are addressed by short aliases (C1, C2, …) because
// models mangle UUIDs.

import type Anthropic from "@anthropic-ai/sdk";
import type { Comp, Domain, EntityType, Fact } from "@/lib/types";
import type { FactStore } from "@/lib/facts/store";
import { BudgetExhaustedError, QlooClient, QlooError } from "@/lib/qloo/client";
import {
  compareAudiences,
  fetchAffinities,
  fetchBaselineHeatmap,
  fetchCross,
  fetchDemographics,
  fetchGenrePool,
  fetchHeatmap,
  fetchLoglineTitles,
  fetchSimilar,
  fetchTags,
  scoreEntities,
  searchEntities,
} from "@/lib/qloo/api";
import { DOMAIN_URN } from "@/lib/qloo/params";
import type { Reference } from "@/lib/qloo/baselines";
import { REGIONS } from "@/lib/geo/cities";
import { compareGroup } from "@/lib/score";

export const alias = (i: number) => `C${i + 1}`;

const DOMAIN_ENUM = ["artist", "podcast", "tv_show", "movie", "book", "brand"];

/** Tool definitions for the model. Coverage (per-comp affinities, markets, lift scoring) is already done in code. */
export function toolDefs(comps: Comp[]): Anthropic.Beta.BetaTool[] {
  const ids = comps.map((_, i) => alias(i));
  const reason = { type: "string", description: "One short sentence: why, shown to the marketer in the trace" };
  return [
    {
      name: "audience_affinities",
      description: "Cross-domain affinities of the audience of one or more comps, in a domain not yet covered (e.g. book, or the release's own format). One comp per call keeps attribution.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { comps: { type: "array", items: { type: "string", enum: ids } }, domain: { type: "string", enum: DOMAIN_ENUM }, reason },
        required: ["comps", "domain", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "propose_partners",
      description:
        "Suggest specific partners you believe fit this release (real podcasts, artists, TV shows, films, brands). Code resolves each name in Qloo and measures its affinity and lift for the comps' audience; only those that measure well enter the plan.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { domain: { type: "string", enum: DOMAIN_ENUM }, names: { type: "array", items: { type: "string" }, description: "Up to 6 exact names" }, reason },
        required: ["domain", "names", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "titles_for_logline",
      description: "Titles that fit the release's logline: each keyword is matched to a Qloo media-genre tag and popular titles for those tags are returned. Use it to look for a better or missing comp.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { keywords: { type: "array", items: { type: "string" }, description: "1 to 3 genre words from the logline, e.g. folk horror, cults" }, reason },
        required: ["keywords", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "compare_themes",
      description: "Which story themes two comps share and where they diverge (Qloo compare). Useful for the creative angle; it compares titles, not audiences.",
      strict: true,
      input_schema: {
        type: "object",
        properties: { a: { type: "string", enum: ids }, b: { type: "string", enum: ids }, reason },
        required: ["a", "b", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "set_comp_weights",
      description: "Weight the comps for ranking markets and partners (0.5 to 2; 1 = neutral). Upweight the comp closest to the release, downweight a weak anchor. Give the reason.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          weights: { type: "array", items: { type: "object", properties: { comp: { type: "string", enum: ids }, weight: { type: "number" } }, required: ["comp", "weight"], additionalProperties: false } },
          reason,
        },
        required: ["weights", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "recommend_comps",
      description:
        "Your verdict on the comp set: which comp to lead with, optionally one title to add (must be a title from the similar-titles or logline evidence, named exactly) and one comp to drop. Give the reason in one or two sentences, naming only comps and titles from the evidence.",
      strict: true,
      input_schema: {
        type: "object",
        properties: {
          lead: { type: "string", enum: ids },
          add: { type: "string", description: "Exact title to add, or empty" },
          drop: { type: "string", enum: ["", ...ids] },
          reason: { type: "string" },
        },
        required: ["lead", "add", "drop", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "finish_research",
      description: "Call when you have made your decisions (or limits are near). Give the reason.",
      strict: true,
      input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false },
    },
  ];
}

export type CompAdviceDraft = { lead: string; add?: string; drop?: string; reason: string };

export type ToolContext = {
  client: QlooClient;
  store: FactStore;
  comps: Comp[];
  regions: string[];
  excludeIds: string[];
  ref: Reference;
  /** Partners the model proposed, resolved to Qloo entities, per domain. */
  proposals: Map<Domain, { entityId: string; name: string }[]>;
  weights: Record<string, number>;
  advice?: CompAdviceDraft;
};

export type ToolOutcome = { summary: string; facts: Fact[]; isError?: boolean; label: string };

function fmt(facts: Fact[], max = 10) {
  if (!facts.length) return "No Qloo signal (0 results).";
  return facts
    .slice(0, max)
    .map((f) => `${f.id} ${JSON.stringify(f.subject?.name ?? "")} ${typeof f.value === "number" ? f.value : JSON.stringify(f.value)}`)
    .join("\n");
}

/** Comp by alias (C1) or entity ID; tolerates a bare string where an array was expected. */
export function compsFor(refs: unknown, ctx: { comps: Comp[] }): Comp[] {
  const list = Array.isArray(refs) ? refs : typeof refs === "string" && refs ? [refs] : [];
  return list
    .map((r) => {
      const s = String(r).trim();
      const m = /^C(\d)$/i.exec(s);
      return m ? ctx.comps[Number(m[1]) - 1] : ctx.comps.find((c) => c.entityId === s);
    })
    .filter((c): c is Comp => !!c);
}

const DOMAINS = new Set(DOMAIN_ENUM);
const norm = (x: string) => x.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/^the /, "").trim();
/** Strict title match for model-proposed names: same words, or one name contains the other ("Lore" ≠ "Folklore Hours"). */
const sameTitle = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length >= 4 && y.length >= 4 && (` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `)));
};
const name = (c: Comp) => c.name;
const err = (summary: string, label: string): ToolOutcome => ({ summary, facts: [], isError: true, label });

/** Domain to score with filter.results.entities: the pool's entity IDs that lack a comps score or a baseline. */
export function unscored(store: FactStore, comps: Comp[], domain: Domain, proposals: ToolContext["proposals"]) {
  const compKey = comps.map((c) => c.entityId).sort().join(",");
  const facts = store.all().filter((f) => f.subject?.type === domain && f.subject.entityId);
  const pool = new Map<string, string>();
  for (const f of facts) if (f.kind === "affinity" && !f.detail?.scored) pool.set(f.subject!.entityId!, f.subject!.name);
  for (const p of proposals.get(domain) ?? []) pool.set(p.entityId, p.name);
  const scored = new Set(facts.filter((f) => f.kind === "affinity" && f.detail?.scored && [...f.compIds].sort().join(",") === compKey).map((f) => f.subject!.entityId));
  const based = new Set(facts.filter((f) => f.kind === "baseline").map((f) => f.subject!.entityId));
  const toTargets = (pred: (id: string) => boolean) => [...pool.entries()].filter(([id]) => pred(id)).map(([entityId, n]) => ({ entityId, name: n }));
  return { comps: toTargets((id) => !scored.has(id)), baseline: toTargets((id) => !based.has(id)) };
}

/** Genre tags to use as a partner-pool signal: those shared by most comps (from their own Qloo tags), at most two. */
export function poolGenres(comps: Comp[]): string[] {
  const count = new Map<string, number>();
  for (const c of comps) for (const g of new Set(c.genres ?? [])) count.set(g, (count.get(g) ?? 0) + 1);
  const need = comps.length >= 2 ? 2 : 1;
  const shared = [...count.entries()].filter(([, n]) => n >= need).sort((a, b) => b[1] - a[1]);
  const generic = /:(drama|fiction|film|movies?|television|tv|comedy_drama|feature)$/;
  const pick = shared.filter(([g]) => !generic.test(g)).map(([g]) => g);
  return (pick.length ? pick : shared.map(([g]) => g)).slice(0, 2);
}

export async function runTool(toolName: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  if (!input || typeof input !== "object" || "__invalid_arguments" in input) return err("Error: tool arguments were not valid JSON. Call the tool again with valid arguments.", "invalid tool arguments");
  try {
    switch (toolName) {
      // ---- model tools ----
      case "audience_affinities": {
        const comps = compsFor(input.comps ?? input.comp_ids, ctx);
        if (!comps.length) return err("Error: unknown comps. Use the aliases C1, C2, …", "bad comp ids");
        const domain = input.domain as Domain;
        if (!DOMAINS.has(domain)) return err(`Error: domain must be one of ${DOMAIN_ENUM.join(", ")}.`, "bad domain");
        const facts = await fetchAffinities(ctx.client, ctx.store, comps, domain, ctx.excludeIds);
        return { summary: fmt(facts), facts, label: `${domain} affinities for ${comps.map(name).join(" + ")} (${facts.length})` };
      }
      case "propose_partners": {
        const domain = input.domain as Domain;
        if (!DOMAINS.has(domain)) return err(`Error: domain must be one of ${DOMAIN_ENUM.join(", ")}.`, "bad domain");
        const names = (Array.isArray(input.names) ? input.names : []).map(String).filter(Boolean).slice(0, 6);
        const found: { entityId: string; name: string }[] = [];
        const missing: string[] = [];
        await Promise.all(
          names.map(async (n) => {
            const hits = await searchEntities(ctx.client, n, [domain as EntityType], 3).catch(() => []);
            const hit = hits.find((h) => sameTitle(n, h.name));
            if (hit) found.push({ entityId: hit.entityId, name: hit.name });
            else missing.push(n);
          }),
        );
        const list = ctx.proposals.get(domain) ?? [];
        for (const f of found) if (!list.some((x) => x.entityId === f.entityId)) list.push(f);
        ctx.proposals.set(domain, list);
        return {
          summary: `Resolved in Qloo: ${found.map((f) => JSON.stringify(f.name)).join(", ") || "none"}. Not found: ${missing.map((m) => JSON.stringify(m)).join(", ") || "none"}. Code will measure their affinity and lift for these comps.`,
          facts: [],
          label: `proposed ${domain} partners: ${found.length} of ${names.length} found in Qloo`,
        };
      }
      case "titles_for_logline": {
        const keywords = (Array.isArray(input.keywords) ? input.keywords : []).map(String).filter(Boolean).slice(0, 3);
        if (!keywords.length) return err("Error: give 1 to 3 keywords.", "no keywords");
        const { tags, facts } = await fetchLoglineTitles(ctx.client, ctx.store, keywords, ctx.comps[0].type);
        return {
          summary: tags.length ? `Genre tags: ${tags.join(", ")}\n${fmt(facts, 12)}` : "No Qloo genre tag matched those keywords.",
          facts,
          label: `titles for logline (${keywords.join(", ")}): ${facts.length}`,
        };
      }
      case "similar_titles": {
        const [comp] = compsFor(input.comp, ctx);
        if (!comp) return err("Error: unknown comp.", "bad comp id");
        const facts = await fetchSimilar(ctx.client, ctx.store, comp);
        return { summary: fmt(facts, 15), facts, label: `titles ${comp.name} fans love (${facts.length})` };
      }
      case "compare_themes":
      case "compare_audiences": {
        const [a] = compsFor(input.a ?? input.a_id, ctx);
        const [b] = compsFor(input.b ?? input.b_id, ctx);
        if (!a || !b || a === b) return err("Error: give two different comps.", "bad comp id");
        const facts = await compareAudiences(ctx.client, ctx.store, a, b);
        if (!facts) return { summary: "Compare endpoint had no result; themes come from each comp's tags.", facts: [], label: `compare ${a.name} vs ${b.name} (no result)` };
        const shared = facts.filter((f) => compareGroup(f) === "shared").length;
        const line = (f: Fact) => `${f.id} ${JSON.stringify(f.subject?.name ?? "")} ${compareGroup(f) === "shared" ? "shared" : compareGroup(f) === "a" ? `more ${a.name}` : `more ${b.name}`}`;
        return { summary: `${shared} of ${facts.length} themes shared.\n${facts.slice(0, 14).map(line).join("\n")}`, facts, label: `themes ${a.name} vs ${b.name}: ${shared}/${facts.length} shared` };
      }
      case "set_comp_weights": {
        const rows = Array.isArray(input.weights) ? (input.weights as { comp?: unknown; weight?: unknown }[]) : [];
        const set: string[] = [];
        for (const r of rows) {
          const [c] = compsFor(r.comp, ctx);
          const w = Number(r.weight);
          if (!c || !Number.isFinite(w)) continue;
          ctx.weights[c.entityId] = Math.min(2, Math.max(0.5, Math.round(w * 100) / 100));
          set.push(`${c.name} ×${ctx.weights[c.entityId]}`);
        }
        return set.length ? { summary: `Weights set: ${set.join(", ")}`, facts: [], label: `comp weights: ${set.join(", ")}` } : err("Error: no valid weights.", "bad weights");
      }
      case "recommend_comps": {
        const [lead] = compsFor(input.lead, ctx);
        if (!lead) return err("Error: lead must be a comp alias.", "bad lead");
        const [drop] = compsFor(input.drop, ctx);
        const add = String(input.add ?? "").trim();
        if (add) {
          const known = ctx.store.all().some((f) => f.kind === "similar" && f.subject?.name.toLowerCase() === add.toLowerCase());
          if (!known) return err(`Error: "${add}" is not in the similar-titles or logline evidence. Name a title exactly as listed, or leave add empty.`, "add not in evidence");
        }
        ctx.advice = { lead: lead.entityId, add: add || undefined, drop: drop?.entityId, reason: String(input.reason ?? "").slice(0, 400) };
        return { summary: "Recorded.", facts: [], label: `lead with ${lead.name}${add ? `; add ${add}` : ""}${drop ? `; drop ${drop.name}` : ""}` };
      }

      // ---- coverage calls made by code ----
      case "tags": {
        const comps = compsFor(input.comps, ctx);
        const facts = await fetchTags(ctx.client, ctx.store, comps);
        return { summary: fmt(facts, 12), facts, label: `taste tags for ${comps.map(name).join(" + ")} (${facts.length})` };
      }
      case "demographics": {
        const [comp] = compsFor(input.comp, ctx);
        const facts = comp ? await fetchDemographics(ctx.client, ctx.store, comp) : [];
        return { summary: fmt(facts), facts, label: `audience skew for ${comp?.name}` };
      }
      case "fan_markets": {
        const [comp] = compsFor(input.comp, ctx);
        const region = String(input.region);
        if (!comp || !REGIONS[region]) return err("Error: bad comp or region.", "bad input");
        const facts = await fetchHeatmap(ctx.client, ctx.store, comp, region);
        return { summary: fmt(facts, 8), facts, label: `fan markets for ${comp.name} in ${region} (${facts.length} cities)` };
      }
      case "baseline_markets": {
        const region = String(input.region);
        const facts = await fetchBaselineHeatmap(ctx.client, ctx.store, ctx.ref.audience.map((r) => r.entityId), region);
        return { summary: fmt(facts, 8), facts, label: `reference-audience markets in ${region} (${facts.length} cities)` };
      }
      case "genre_pool": {
        const domain = input.domain as Domain;
        const tags = (input.tags as string[]) ?? [];
        const facts = await fetchGenrePool(ctx.client, ctx.store, domain, tags);
        return { summary: fmt(facts), facts, label: `${domain} candidates from the comps' genre (${tags.map((t) => t.split(":").pop()).join(", ")}): ${facts.length}` };
      }
      case "score_pool": {
        const domain = input.domain as Domain;
        const todo = unscored(ctx.store, ctx.comps, domain, ctx.proposals);
        const facts = [
          ...(todo.comps.length
            ? await scoreEntities(ctx.client, ctx.store, { filterType: DOMAIN_URN[domain], signalIds: ctx.comps.map((c) => c.entityId), targets: todo.comps, compIds: ctx.comps.map((c) => c.entityId), role: "comps", subjectType: domain })
            : []),
          ...(todo.baseline.length && ctx.ref.audience.length
            ? await scoreEntities(ctx.client, ctx.store, { filterType: DOMAIN_URN[domain], signalIds: ctx.ref.audience.map((r) => r.entityId), targets: todo.baseline, compIds: [], role: "baseline", subjectType: domain })
            : []),
        ];
        return { summary: fmt(facts), facts, label: `${domain} lift: ${todo.comps.length} candidates scored for the comps and a typical audience` };
      }
      case "similar": {
        const [comp] = compsFor(input.comp, ctx);
        const facts = comp ? await fetchSimilar(ctx.client, ctx.store, comp) : [];
        return { summary: fmt(facts, 15), facts, label: `titles ${comp?.name} fans love (${facts.length})` };
      }
      case "cross": {
        const [comp] = compsFor(input.comp, ctx);
        const targets = (input.targets as { entityId: string; name: string; type: EntityType; control?: boolean }[]) ?? [];
        const facts = await fetchCross(ctx.client, ctx.store, comp ? { comp } : { baselineIds: ctx.ref.audience.map((r) => r.entityId) }, targets);
        return {
          summary: fmt(facts),
          facts,
          label: comp ? `other comps and controls inside ${comp.name}'s audience (${facts.length})` : `comps and controls inside a typical audience (${facts.length})`,
        };
      }
      default:
        return err(`Unknown tool ${toolName}`, `unknown tool ${toolName}`);
    }
  } catch (e) {
    if (e instanceof BudgetExhaustedError) return err("Qloo call budget exhausted. Call finish_research.", "budget exhausted");
    if (e instanceof QlooError) return err(`Qloo error ${e.status}; treat as no signal.`, `Qloo error ${e.status}`);
    throw e;
  }
}
