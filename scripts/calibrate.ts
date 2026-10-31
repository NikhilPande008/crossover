// Calibration of the "one audience or two?" verdict (docs/eval.md): hand-labelled film pairs,
// scored by the same code as a run (cross-affinity in each comp's audience minus the reference
// audience, lib/score.ts buildOverlap), with the format's control titles alongside.
//
//   npm run calibrate            # needs QLOO_API_KEY; about 5 Qloo calls per pair
//
// Labels were written before the first calibration run, from how a release marketer would
// group the titles; they are judgement, not ground truth. Raw facts are not saved (Qloo data).

import { QlooClient } from "@/lib/qloo/client";
import { FactStore } from "@/lib/facts/store";
import { fetchCross } from "@/lib/qloo/api";
import { reference } from "@/lib/qloo/baselines";
import { bestCandidate, resolveComps } from "@/lib/agent/resolve";
import { buildOverlap } from "@/lib/score";
import { THRESHOLDS } from "@/lib/thresholds";
import { config } from "@/lib/config";
import { liftPoints } from "@/lib/labels";
import type { Comp, Overlap } from "@/lib/types";

type Label = NonNullable<Overlap["verdict"]>;
const PAIRS: [string, string, Label][] = [
  ["Hereditary", "The Witch", "one"],
  ["Hereditary", "Midsommar", "one"],
  ["Lady Bird", "Eighth Grade", "one"],
  ["Get Out", "Us", "one"],
  ["John Wick", "Mad Max: Fury Road", "one"],
  ["Hereditary", "Lady Bird", "adjacent"],
  ["Barbie", "Oppenheimer", "adjacent"],
  ["The Witch", "Lady Bird", "different"],
  ["Paddington 2", "Hereditary", "different"],
  ["Avengers: Endgame", "Lady Bird", "different"],
];

async function main() {
  if (config.mode !== "live") throw new Error("Calibration needs live Qloo data: set QLOO_API_KEY.");
  const client = new QlooClient({ maxCalls: PAIRS.length * 8 + 10 });
  const rows: { a: string; b: string; label: Label; verdict?: Label; mutual?: number; controls: string }[] = [];
  for (const [na, nb, label] of PAIRS) {
    const [ra, rb] = await resolveComps(client, [na, nb], ["movie"]);
    const a = bestCandidate(ra);
    const b = bestCandidate(rb);
    if (!a || !b) {
      console.log(`skip ${na} / ${nb}: not resolved`);
      continue;
    }
    const comps: Comp[] = [a, b];
    const ref = await reference(client, "film", comps.map((c) => c.entityId));
    const store = new FactStore();
    const controls = ref.controls.map((c) => ({ ...c, control: true }));
    const target = (c: Comp) => ({ entityId: c.entityId, name: c.name, type: c.type });
    await fetchCross(client, store, { comp: a }, [target(b), ...controls]);
    await fetchCross(client, store, { comp: b }, [target(a), ...controls]);
    await fetchCross(client, store, { baselineIds: ref.audience.map((r) => r.entityId) }, [target(a), target(b), ...controls]);
    const o = buildOverlap(store.all(), a.entityId, b.entityId);
    rows.push({
      a: a.name,
      b: b.name,
      label,
      verdict: o.mutualLift !== undefined ? o.verdict : undefined,
      mutual: o.mutualLift,
      controls: (o.controls ?? []).map((c) => `${c.name} ${c.liftInA !== undefined ? liftPoints(c.liftInA) : "?"}/${c.liftInB !== undefined ? liftPoints(c.liftInB) : "?"}`).join(", "),
    });
  }
  const scored = rows.filter((r) => r.verdict);
  const right = scored.filter((r) => r.verdict === r.label).length;
  console.log(`\nThresholds: one ≥ ${THRESHOLDS.oneAudienceLift}, adjacent ≥ ${THRESHOLDS.adjacentLift}. Qloo calls: ${client.calls}\n`);
  console.log("| Pair | Label | Mutual lift | Verdict | Controls (lift in A / in B) |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.a} / ${r.b} | ${r.label} | ${r.mutual !== undefined ? liftPoints(r.mutual) : "—"} | ${r.verdict ?? "no data"}${r.verdict && r.verdict !== r.label ? " ✗" : ""} | ${r.controls} |`);
  console.log(`\nAgreement with labels: ${right} of ${scored.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
