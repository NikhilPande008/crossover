// API spike (M1): runs test cases 1–5 against the live hackathon host and writes
// ONLY response shapes and pass/fail results to docs/api-findings.md.
// Never writes raw Qloo response values to disk.
//
//   QLOO_API_KEY=... npm run api-test

import { writeFileSync } from "node:fs";
import { config } from "@/lib/config";
import { QlooClient, QlooError } from "@/lib/qloo/client";
import { searchEntities } from "@/lib/qloo/api";
import { PRESETS } from "@/lib/presets";
import { REGIONS } from "@/lib/geo/cities";
import { nearestCity } from "@/lib/geo/cities";
import { parseCompare } from "@/lib/qloo/compare";

type Row = { test: string; pass: boolean | "n/a"; note: string };
const rows: Row[] = [];
const shapes: Record<string, string> = {};

/** Describe a JSON value's shape without its values. */
function shape(v: unknown, depth = 0): string {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.length ? `[${shape(v[0], depth + 1)}] (len ${v.length})` : "[]";
  if (v && typeof v === "object")
    return `{ ${Object.entries(v as Record<string, unknown>)
      .slice(0, 14)
      .map(([k, x]) => `${k}: ${shape(x, depth + 1)}`)
      .join(", ")} }`;
  return typeof v;
}

async function raw(client: QlooClient, path: string, params: Record<string, string>) {
  try {
    const r = await client.get(path, params);
    return { ok: true as const, data: r.data as Record<string, unknown> };
  } catch (e) {
    return { ok: false as const, status: e instanceof QlooError ? e.status : 0, message: String(e).slice(0, 160) };
  }
}

function entities(d: unknown): { entity_id: string; name: string; affinity?: number; query?: { affinity?: number } }[] {
  return ((d as { results?: { entities?: [] } })?.results?.entities ?? []) as never;
}

function tagNames(d: unknown): string[] {
  return (((d as { results?: { tags?: { name: string }[] } })?.results?.tags ?? []) as { name: string }[]).map((t) => t.name);
}

async function main() {
  if (config.mode !== "live") throw new Error("Set QLOO_API_KEY (and CROSSOVER_MODE=live) to run the API spike.");
  const client = new QlooClient({ maxCalls: 80, mode: "live" });

  // 1. Comp coverage
  const ids: Record<string, string> = {};
  for (const p of PRESETS) {
    for (const name of [...p.brief.comps, p.swap.to]) {
      const a = await searchEntities(client, name, p.compTypes, 3);
      const hit = a.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (hit) ids[name] = hit.entityId;
      // Notes stay value-free (this file is committed): no Qloo names, years or IDs.
      rows.push({
        test: `1 search "${name}"`,
        pass: Boolean(hit),
        note: hit ? `exact name in top 3 (rank ${a.indexOf(hit) + 1}), type=${hit.type}, year present=${hit.year !== undefined}` : `no exact match among ${a.length} results`,
      });
    }
  }
  const s = await raw(client, "/search", { query: "Hereditary", types: "urn:entity:movie", take: "1" });
  if (s.ok) shapes["/search"] = shape(s.data);

  // 2. Cross-domain affinity is specific, not generic
  const A = ids["Hereditary"];
  const B = ids["Lady Bird"];
  if (A && B) {
    const pa = await raw(client, "/v2/insights", { "filter.type": "urn:entity:podcast", "signal.interests.entities": A, "feature.explainability": "true", take: "10" });
    const pb = await raw(client, "/v2/insights", { "filter.type": "urn:entity:podcast", "signal.interests.entities": B, "feature.explainability": "true", take: "10" });
    if (pa.ok && pb.ok) {
      shapes["/v2/insights podcast"] = shape(pa.data);
      const ea = entities(pa.data).map((e) => e.entity_id);
      const eb = new Set(entities(pb.data).map((e) => e.entity_id));
      const overlap = ea.filter((x) => eb.has(x)).length / Math.max(1, ea.length);
      const explain = JSON.stringify(pa.data).includes("explainability");
      const e0 = entities(pa.data)[0];
      const where = e0 ? (typeof e0.query?.affinity === "number" ? "query.affinity" : typeof e0.affinity === "number" ? "top-level affinity" : "MISSING") : "no results";
      rows.push({ test: "2 podcast specificity (Hereditary vs Lady Bird)", pass: overlap < 0.5, note: `top-10 overlap ${Math.round(overlap * 100)}%, explainability present=${explain}, affinity at ${where}` });
    } else rows.push({ test: "2 podcast specificity", pass: false, note: `error ${!pa.ok ? pa.status : ""} ${!pb.ok ? pb.status : ""}` });
    for (const t of ["urn:entity:artist", "urn:entity:brand", "urn:entity:tv_show", "urn:entity:book", "urn:tag", "urn:demographics"]) {
      const r = await raw(client, "/v2/insights", { "filter.type": t, "signal.interests.entities": A, ...(t === "urn:demographics" ? {} : { take: "5" }) });
      rows.push({ test: `2b filter.type=${t}`, pass: r.ok, note: r.ok ? "ok" : `status ${r.status}` });
      if (r.ok) shapes[`/v2/insights ${t}`] = shape(r.data);
    }
    // The parameter table lists no signal param for urn:tag; check the signal is honoured.
    const ta = await raw(client, "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": A, take: "12" });
    const tb = await raw(client, "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": B, take: "12" });
    if (ta.ok && tb.ok) {
      const na = tagNames(ta.data);
      const nb = new Set(tagNames(tb.data));
      const same = na.filter((n) => nb.has(n)).length;
      const hasAff = JSON.stringify(ta.data).includes('"affinity"');
      rows.push({ test: "2c urn:tag honours signal.interests.entities", pass: na.length > 0 && same < na.length, note: `${same}/${na.length} tags identical across comps; affinity field present=${hasAff}` });
    }
  } else rows.push({ test: "2 podcast specificity", pass: "n/a", note: "comps did not resolve" });

  // 3. Heatmap varies by comp
  for (const region of Object.keys(REGIONS)) {
    if (!A || !B) break;
    const q = REGIONS[region].locationQuery;
    const ha = await raw(client, "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": A, "filter.location.query": q, take: "50" });
    const hb = await raw(client, "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": B, "filter.location.query": q, take: "50" });
    if (!ha.ok || !hb.ok) {
      rows.push({ test: `3 heatmap ${region}`, pass: false, note: `status ${!ha.ok ? ha.status : hb.ok ? "" : hb.status}` });
      continue;
    }
    shapes["/v2/insights heatmap"] = shape(ha.data);
    // The docs only show city names for filter.location.query; check a country resolves.
    const localities = (ha.data as { query?: { localities?: unknown } }).query?.localities;
    const subtypes = [...JSON.stringify(localities ?? null).matchAll(/"subtype":"([^"]+)"/g)].map((m) => m[1]);
    // Value-free note: whether it resolved and to what kind of place, not the place itself.
    rows.push({ test: `3a filter.location.query="${q}" resolves`, pass: localities != null, note: localities != null ? `resolved; subtypes: ${[...new Set(subtypes)].join(", ") || "none listed"}` : "no query.localities in response" });
    const top = (d: unknown) =>
      (((d as { results?: { heatmap?: [] } }).results?.heatmap ?? []) as { location: { latitude: number; longitude: number }; query?: { affinity?: number } }[])
        .sort((x, y) => (y.query?.affinity ?? 0) - (x.query?.affinity ?? 0))
        .map((c) => nearestCity(c.location.latitude, c.location.longitude, REGIONS[region].country)?.name)
        .filter(Boolean)
        .slice(0, 5);
    const ta = top(ha.data);
    const tb = new Set(top(hb.data));
    const cells = ((ha.data as { results?: { heatmap?: [] } }).results?.heatmap ?? []).length;
    rows.push({ test: `3 heatmap ${region}`, pass: ta.filter((x) => tb.has(x)).length <= 3 && ta.length >= 3, note: `${cells} cells; ${ta.length} mapped to cities; top-5 shared ${ta.filter((x) => tb.has(x)).length}` });
  }

  // 4. Parameters honoured
  if (A) {
    const base = await raw(client, "/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": A, take: "5" });
    const first = base.ok ? entities(base.data)[0]?.entity_id : undefined;
    if (first) {
      const ex = await raw(client, "/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": A, "filter.exclude.entities": first, take: "5" });
      rows.push({ test: "4 filter.exclude.entities honoured", pass: ex.ok && !entities(ex.data).some((e) => e.entity_id === first), note: ex.ok ? "" : `status ${ex.status}` });
    }
    // Deliberately invalid param, bypassing our allowlist.
    const url = new URL(config.qlooBaseUrl() + "/v2/insights");
    url.search = new URLSearchParams({ "filter.type": "urn:entity:artist", "signal.interests.entities": A, "filter.bogus_param": "1", take: "3" }).toString();
    const r = await fetch(url, { headers: { "X-Api-Key": config.qlooKey() } });
    rows.push({ test: "4 invalid param", pass: "n/a", note: r.ok ? "silently ignored (200) — allowlist required" : `rejected with ${r.status}` });
  }

  // 5. Compare endpoint
  if (A && B) {
    // Documented path; filter.type does not accept urn:tag, so the default and one entity type are tried.
    for (const extra of [{}, { "filter.type": "urn:entity:artist" }] as Record<string, string>[]) {
      const label = extra["filter.type"] ?? "default type";
      const r = await raw(client, "/v2/analysis/compare", { "a.signal.interests.entities": A, "b.signal.interests.entities": B, take: "20", ...extra });
      const parsedItems = r.ok ? parseCompare((r.data as { results?: unknown }).results).length : 0;
      rows.push({ test: `5 /v2/analysis/compare (${label})`, pass: r.ok && parsedItems > 0, note: r.ok ? `ok; parseCompare recognised ${parsedItems} items` : `status ${r.status}` });
      if (r.ok) shapes[`/v2/analysis/compare ${label}`] = shape(r.data);
    }
  }

  const md = [
    `# Qloo API findings`,
    ``,
    `Run: ${new Date().toISOString()} · host ${config.qlooBaseUrl()} · ${client.calls} calls`,
    ``,
    `Only shapes and pass/fail results are recorded here. No Qloo response values are committed.`,
    ``,
    `## Test results`,
    ``,
    `| Test | Pass | Notes |`,
    `|---|---|---|`,
    ...rows.map((r) => `| ${r.test} | ${r.pass === "n/a" ? "n/a" : r.pass ? "✅" : "❌"} | ${r.note} |`),
    ``,
    `## Response shapes`,
    ``,
    ...Object.entries(shapes).flatMap(([k, v]) => [`**${k}**`, "", "```", v, "```", ""]),
    `## Follow-ups`,
    ``,
    `- Set thresholds in lib/thresholds.ts from observed affinity ranges.`,
    `- If compare shows 0 recognised items, extend lib/qloo/compare.ts to the shape above.`,
    `- If filter.location.query did not resolve for a country, switch heatmaps to per-city queries.`,
    `- Update lib/qloo/params.ts and lib/qloo/schemas.ts to match the shapes above.`,
  ].join("\n");
  writeFileSync("docs/api-findings.md", md);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
