// End-to-end CLI spike: npm run plan -- <preset-id> [--swap] [--save=<file.json>]
// Prints facts, ranked markets and partners, and the three concepts.
// --save writes the full run (it contains Qloo data): only outside the repo or under .data/.

import { PRESETS } from "@/lib/presets";
import { QlooClient } from "@/lib/qloo/client";
import { bestCandidate, resolveComps } from "@/lib/agent/resolve";
import { runPlan } from "@/lib/agent/loop";
import { config } from "@/lib/config";
import { formatUsage } from "@/lib/llm/usage";
import type { Comp } from "@/lib/types";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

function savePath(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith("--save="));
  if (!arg) return undefined;
  const p = resolve(arg.slice("--save=".length));
  const rel = relative(process.cwd(), p);
  const insideRepo = !rel.startsWith("..") && !rel.startsWith("/");
  if (insideRepo && !rel.startsWith(".data/")) throw new Error("--save holds Qloo response data: use a path outside the repo or under .data/ (gitignored).");
  return p;
}

async function main() {
  const id = process.argv[2] ?? PRESETS[0].id;
  const save = savePath();
  const swap = process.argv.includes("--swap");
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown preset ${id}. Options: ${PRESETS.map((p) => p.id).join(", ")}`);
  console.log(`mode=${config.mode} llm=${config.llmEnabled() ? `${config.llmProvider()}:${config.llmModel()}` : "none"} preset=${preset.id}`);

  const resolver = new QlooClient({ maxCalls: 10 });
  const names = swap ? preset.brief.comps.map((c) => (c === preset.swap.from ? preset.swap.to : c)) : preset.brief.comps;
  const res = await resolveComps(resolver, names, preset.compTypes);
  const comps = res.map(bestCandidate).filter((c): c is Comp => !!c);
  for (const r of res) console.log(`  resolve ${JSON.stringify(r.query)} → ${r.candidates.slice(0, 3).map((c) => `${c.name} (${c.year ?? "?"}, ${c.entityId})`).join(" | ") || "NOT FOUND"}`);

  const result = await runPlan({ brief: { ...preset.brief, comps: names }, comps }, (e) => {
    if (e.type === "step") console.log(`· [${e.calls} calls] ${e.message}`);
  });

  console.log(`\nQloo calls: ${result.qlooCalls} (+${result.cachedCalls} cached) · ${result.facts.length} facts · ${result.ms} ms · llm=${result.llmUsed}`);
  if (save) {
    mkdirSync(dirname(save), { recursive: true });
    writeFileSync(save, JSON.stringify(result, null, 2));
    console.log(`Saved run to ${save}`);
  }
  const u = result.llmUsage;
  if (u.calls) {
    console.log(`LLM: ${u.provider} ${u.models.join(", ")} · ${u.calls} calls · ${formatUsage(u)}`);
    for (const p of u.byPhase) console.log(`  ${p.phase.padEnd(9)} ${p.calls} calls · ${formatUsage({ ...p, provider: u.provider })}`);
  }
  console.log("\nTop markets:");
  for (const m of result.audience.markets.slice(0, 6)) console.log(`  ${m.name.padEnd(16)} ${m.score}`);
  console.log("\nTop partners:");
  for (const [d, ps] of Object.entries(result.audience.partners)) if (ps.length) console.log(`  ${d.padEnd(8)} ${ps.slice(0, 3).map((p) => `${p.name} ${p.score}`).join(" · ")}`);
  console.log("\nOverlaps:");
  const cn = (id: string) => result.comps.find((c) => c.entityId === id)?.name ?? id;
  for (const o of result.audience.overlaps)
    console.log(`  ${cn(o.a)} vs ${cn(o.b)}: audience overlap ${o.score} over ${o.compared} (${o.basis}); shared audience: ${o.sharedAudience.join(", ") || "—"}; shared themes (${o.source}): ${o.shared.join(", ") || "—"}`);
  console.log("\nConcepts:");
  for (const c of result.concepts) {
    const rec = c.id === result.decision.recommendedId ? " ★ recommended" : "";
    console.log(`  ${c.id} [${c.lever}/${c.confidence}] ${c.name}${rec}`);
    console.log(`     markets: ${c.markets.map((m) => m.name).join(", ")}`);
    console.log(`     partners: ${c.partners.map((p) => `${p.name} (${p.domain})`).join(", ")}`);
    console.log(`     angle: ${c.creativeAngle.text} [${c.creativeAngle.factIds.join(",")}]`);
  }
  console.log(`\nBrief (${result.decision.writtenBy}, ${result.decision.droppedSentences} dropped):`);
  for (const r of result.decision.rationale) console.log(`  - ${r.text} [${r.factIds.join(",")}]`);
  console.log("Gaps:", result.audience.gaps.join("; ") || "none");
  const validatorDrops = result.trace.filter((t) => t.kind === "validator");
  if (validatorDrops.length) console.log("Validator:", validatorDrops.map((t) => t.message).join("\n  "));
  const notes = result.trace.filter((t) => t.kind === "error" || t.kind === "limit" || t.kind === "plan" || t.kind === "decision");
  if (notes.length) console.log("\nAgent decisions and errors:\n  " + notes.map((t) => `[${t.kind}] ${t.message}`).join("\n  "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
