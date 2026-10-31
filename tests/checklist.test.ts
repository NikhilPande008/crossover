// "Test before you spend" items are typed and rendered by code: they may only use partners and
// markets from the recommended concept, of the right domain, and a note that invents entities is dropped.

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
    if (a.phase === "repair") return { angles: [] } as never;
    return {
      rationale: [{ text: "This plan rests on the comps' shared tastes.", factIds: ["F1"] }],
      whyNotOthers: [],
      tradeoffs: [],
      tests: [
        // Glasgow cannot be in a US-only plan.
        { type: "geo_ab", subjects: ["Glasgow", "Boston"], why: "" },
        // A podcast read needs a podcast partner from the plan.
        { type: "podcast_host_read", subjects: [], why: "" },
        { type: "creative_ab", subjects: [], why: "Pilot reads on fan podcasts first." },
      ],
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
    expect(r.decision.tests?.map((t) => t.type)).toEqual(["creative_ab"]);
    expect(r.decision.testChecklist[0]).toMatch(/^A\/B the trailer cut-downs/);
    // The note invented "fan podcasts", so the test is kept without it.
    expect(r.decision.tests?.[0].why).toBeUndefined();
    expect(r.trace.some((t) => /Test dropped: geo_ab needs 2 markets/.test(t.message))).toBe(true);
    expect(r.trace.some((t) => /Test dropped: podcast_host_read needs 1 podcast partner/.test(t.message))).toBe(true);
  });
});
