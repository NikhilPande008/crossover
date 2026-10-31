// Browser stream: a dropped or silent connection resumes the same run from the last event.

import { describe, expect, it } from "vitest";
import { streamPlan } from "@/lib/client/stream";
import type { ProgressEvent } from "@/lib/types";

const sse = (events: { id: number; e: unknown }[], opts: { hang?: boolean } = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const { id, e } of events) c.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify(e)}\n\n`));
        if (!opts.hang) c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const result = { type: "result", result: { runId: "r1" } };
const fast = { backoffMs: () => 1 };

describe("streamPlan", () => {
  it("resumes from the next event after a dropped stream", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url === "/api/plan") return sse([{ id: 0, e: { type: "run", runId: "r1" } }, { id: 1, e: { type: "step", message: "a", calls: 3 } }]);
      return sse([{ id: 2, e: result }]);
    }) as typeof fetch;
    const got: ProgressEvent[] = [];
    await streamPlan({}, (e) => got.push(e), { ...fast, fetchImpl });
    expect(urls[1]).toBe("/api/runs/r1/events?from=2");
    expect(got.at(-1)?.type).toBe("result");
    expect(got.some((e) => e.type === "error")).toBe(false);
  });

  it("reconnects when the stream goes silent past the watchdog", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      if (url === "/api/plan") return sse([{ id: 0, e: { type: "run", runId: "r1" } }], { hang: true });
      return sse([{ id: 1, e: result }]);
    }) as typeof fetch;
    const got: ProgressEvent[] = [];
    await streamPlan({}, (e) => got.push(e), { ...fast, watchdogMs: 30, fetchImpl });
    expect(calls).toBe(2);
    expect(got.some((e) => e.type === "step" && /No progress/.test(e.message))).toBe(true);
    expect(got.at(-1)?.type).toBe("result");
  });

  it("reports an error when the run cannot be resumed", async () => {
    const fetchImpl = (async (url: string) =>
      url === "/api/plan" ? sse([{ id: 0, e: { type: "run", runId: "r1" } }]) : Response.json({ error: "Run not found" }, { status: 404 })) as typeof fetch;
    const got: ProgressEvent[] = [];
    await streamPlan({}, (e) => got.push(e), { ...fast, fetchImpl });
    expect(got.at(-1)).toMatchObject({ type: "error" });
  });

  it("passes the server's error through when the plan request is refused", async () => {
    const fetchImpl = (async () => Response.json({ error: "Invalid request" }, { status: 422 })) as unknown as typeof fetch;
    const got: ProgressEvent[] = [];
    await streamPlan({}, (e) => got.push(e), { ...fast, fetchImpl });
    expect(got).toEqual([{ type: "error", message: "Invalid request" }]);
  });
});
