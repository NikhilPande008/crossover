// The brief is regenerated only if there is still time, and every model call gets a deadline.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLM } from "@/lib/llm/provider";
import type { Comp } from "@/lib/types";

process.env.CROSSOVER_MODE = "fixture";
process.env.LLM_PROVIDER = "none";

let skew = 0;
const deadlines: { phase?: string; deadline?: number }[] = [];
const fake: LLM = {
  provider: "openai",
  model: "fake",
  async toolTurn(a) {
    deadlines.push({ phase: a.phase, deadline: a.deadline });
    return { content: [], toolUses: [], text: "", stopReason: "end_turn" };
  },
  async structured(a) {
    deadlines.push({ phase: a.phase, deadline: a.deadline });
    if (a.phase === "conceive") return { concepts: [] } as never;
    // A slow brief whose every sentence fails the validator: the loop would normally regenerate.
    skew += 120_000;
    return { recommendedLever: "market", rationale: [{ text: "Totally Invented Partner Network wins.", factIds: ["F1"] }], whyNotOthers: [], tradeoffs: [], testChecklist: [] } as never;
  },
};

vi.mock("@/lib/llm/provider", async (orig) => ({ ...(await orig<typeof import("@/lib/llm/provider")>()), getLLM: () => fake }));

describe("run time budget", () => {
  afterEach(() => vi.restoreAllMocks());
  it("skips the brief regeneration when the wall clock has run out, and caps every model call", async () => {
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    const { runPlan } = await import("@/lib/agent/loop");
    const { PRESETS } = await import("@/lib/presets");
    const { QlooClient } = await import("@/lib/qloo/client");
    const { bestCandidate, resolveComps } = await import("@/lib/agent/resolve");
    const p = PRESETS[0];
    const comps = (await resolveComps(new QlooClient({ maxCalls: 10, mode: "fixture" }), p.brief.comps, p.compTypes)).map(bestCandidate).filter((c): c is Comp => !!c);
    const started = Date.now();
    const r = await runPlan({ brief: p.brief, comps, mode: "fixture" });
    expect(r.trace.some((t) => t.message.startsWith("No time to regenerate the brief"))).toBe(true);
    expect(deadlines.filter((d) => d.phase === "brief")).toHaveLength(1);
    expect(r.decision.writtenBy).toBe("template");
    for (const d of deadlines) {
      expect(d.deadline).toBeDefined();
      expect(d.deadline! - started).toBeLessThanOrEqual(100_000 + 1000);
    }
  });
});
