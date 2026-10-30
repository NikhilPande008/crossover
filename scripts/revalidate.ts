// Re-run the current grounding validator over a saved run: npm run revalidate -- <run.json>
// Prints a verdict for every cited sentence (creative angles, rationale, why-not-others).

import { readFileSync } from "node:fs";
import type { Cited, RunResult } from "@/lib/types";
import { makeContext, validateCited } from "@/lib/validate/grounding";
import { buildScoreScope } from "@/lib/validate/comparative";

const file = process.argv[2];
if (!file) throw new Error("Usage: npm run revalidate -- <run.json>");
const run = JSON.parse(readFileSync(file, "utf8")) as RunResult;
const ctx = makeContext(run.facts, run.comps, run.brief);
ctx.scores = buildScoreScope(run.audience, run.concepts, run.comps);
const byId = new Map(run.facts.map((f) => [f.id, f]));

const items: { where: string; item: Cited }[] = [
  ...run.concepts.map((c) => ({ where: `angle ${c.id}`, item: c.creativeAngle })),
  ...run.decision.rationale.map((r, i) => ({ where: `rationale ${i + 1}`, item: r })),
  ...run.decision.whyNotOthers.map((r, i) => ({ where: `why-not ${i + 1}`, item: r })),
];
let failed = 0;
for (const { where, item } of items) {
  const r = validateCited(item, ctx);
  if (!r.ok) failed++;
  const about = item.factIds.map((id) => `${id}=${byId.get(id)?.subject?.name ?? "?"}`).join(", ");
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${where}: ${item.text}\n      cites: ${about}${r.ok ? "" : `\n      reason: ${r.issue.reason}`}`);
}
console.log(`\n${items.length - failed}/${items.length} cited sentences pass (brief written by: ${run.decision.writtenBy}; dropped during the run: ${run.decision.droppedSentences}).`);
const drops = run.trace.filter((t) => t.kind === "validator" && (t.message.startsWith("Dropped") || t.message.startsWith("Creative angle replaced")));
if (drops.length) console.log(`Validator actions during the run:\n  ${drops.map((t) => t.message).join("\n  ")}`);
