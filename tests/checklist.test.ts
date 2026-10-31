// "Test before you spend" items may only name partners and markets from the recommended concept.

import { describe, expect, it, vi } from "vitest";
import type { LLM } from "@/lib/llm/provider";
import type { Comp } from "@/lib/types";

process.env.CROSSOVER_MODE = "fixture";
process.env.LLM_PROVIDER = "none";

const fake: LLM = {
  provider: "openai",
  model: "fake",
  async toolTurn() {
    return { content: [], toolUses: [], text: "", stopReason: "end_turn" };
  },
  async structured(a) {
    if (a.phase === "conceive") return { concepts: [] } as never;
    return {
      rationale: [{ text: "This plan rests on the comps' shared tastes.", factIds: ["F1"] }],
      whyNotOthers: [],
      tradeoffs: [],
      // Glasgow cannot be in a US-only plan; the second item names nothing and is kept.
      testChecklist: ["Run a small paid social test in Glasgow first.", "Pilot reads on fan podcasts before a full partnership.", "A/B the creative angle in trailer cut-downs."],
    } as never;
  },
};

vi.mock("@/lib/llm/provider", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/provider")>()), getLLM: () => fake }));

describe("decision brief checklist", () => {
  it("drops checklist items that name a market or partner outside the recommended concept", async () => {
    const { runPlan } = await import("@/lib/agent/loop");
    const { PRESETS } = await import("@/lib/presets");
    const { QlooClient } = await import("@/lib/qloo/client");
    const { bestCandidate, resolveComps } = await import("@/lib/agent/resolve");
    const p = PRESETS.find((x) => x.id === "indie-coming-of-age")!;
    const comps = (await resolveComps(new QlooClient({ maxCalls: 10, mode: "fixture" }), p.brief.comps, p.compTypes)).map(bestCandidate).filter((c): c is Comp => !!c);
    const r = await runPlan({ brief: p.brief, comps, mode: "fixture" });
    expect(r.decision.writtenBy).toBe("llm");
    expect(r.decision.testChecklist).toEqual(["A/B the creative angle in trailer cut-downs."]);
    expect(r.trace.some((t) => /names "Glasgow", which is not in the recommended concept/.test(t.message))).toBe(true);
    expect(r.trace.some((t) => /invents "fan podcasts"/.test(t.message))).toBe(true);
  });
});
