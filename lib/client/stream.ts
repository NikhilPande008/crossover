// Browser side of a plan run: reads the SSE progress stream and, when the connection drops or
// goes silent, reconnects to the same run (GET /api/runs/{id}/events?from=n) instead of failing.
// The server keeps the run going after a dropped stream and logs every event, so a resume
// picks up exactly where the last delivered event left off.

import type { ProgressEvent } from "@/lib/types";

/** No bytes at all (the server pings every 10 s) for this long means the connection is dead. */
export const WATCHDOG_MS = 45_000;
export const MAX_RESUMES = 3;

type Opts = {
  watchdogMs?: number;
  maxResumes?: number;
  /** Delay before resume attempt i (0-based). */
  backoffMs?: (i: number) => number;
  fetchImpl?: typeof fetch;
};

type Attempt = { ok: true } | { ok: false; status: number; error?: string };

/** Parse an SSE body, calling onEvent for each `data:` event (with its `id:`) and onBytes for any chunk, pings included. */
async function readSSE(res: Response, signal: AbortSignal, onEvent: (e: ProgressEvent, id: number | undefined) => void, onBytes: () => void) {
  const reader = res.body!.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel);
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onBytes();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = chunk.split("\n");
        const data = lines.find((l) => l.startsWith("data: "));
        if (!data) continue;
        const idLine = lines.find((l) => l.startsWith("id: "));
        const id = idLine ? Number(idLine.slice(4)) : undefined;
        onEvent(JSON.parse(data.slice(6)) as ProgressEvent, Number.isFinite(id) ? id : undefined);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Never throws: a stream that cannot be resumed becomes an error event. */
export async function streamPlan(body: unknown, onEvent: (e: ProgressEvent) => void, opts: Opts = {}) {
  const watchdogMs = opts.watchdogMs ?? WATCHDOG_MS;
  const maxResumes = opts.maxResumes ?? MAX_RESUMES;
  const backoff = opts.backoffMs ?? ((i: number) => 1000 * 2 ** i);
  const doFetch = opts.fetchImpl ?? fetch;

  let finished = false;
  let runId: string | undefined;
  let next = 0;
  let calls = 0;
  let silent = false;

  const emit = (e: ProgressEvent, id: number | undefined) => {
    if (finished) return;
    if (id !== undefined) next = Math.max(next, id + 1);
    if (e.type === "run") runId = e.runId;
    if (e.type === "step") calls = e.calls;
    if (e.type === "result" || e.type === "error") finished = true;
    onEvent(e);
  };

  async function attempt(open: (signal: AbortSignal) => Promise<Response>): Promise<Attempt> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        silent = true;
        ctl.abort();
      }, watchdogMs);
    };
    arm();
    try {
      const res = await open(ctl.signal);
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: j.error };
      }
      runId ??= res.headers.get("x-run-id") ?? undefined;
      await readSSE(res, ctl.signal, emit, arm);
    } catch {
      // Network drop, abort by the watchdog, or a malformed chunk: resumed below.
    } finally {
      clearTimeout(timer);
    }
    return { ok: true };
  }

  const first = await attempt((signal) => doFetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal }));
  if (!first.ok) {
    emit({ type: "error", message: first.error ?? `Request failed (${first.status})` }, undefined);
    return;
  }

  for (let i = 0; !finished && runId && i < maxResumes; i++) {
    await new Promise((r) => setTimeout(r, backoff(i)));
    emit({ type: "step", message: silent ? "No progress for a while; reconnecting to the same run" : "Connection dropped; reconnecting to the same run", calls }, undefined);
    silent = false;
    const id = runId;
    const r = await attempt((signal) => doFetch(`/api/runs/${encodeURIComponent(id)}/events?from=${next}`, { signal }));
    // 404: this server has no record of the run (no durable store), so there is nothing to resume.
    if (!r.ok) break;
  }

  if (!finished) emit({ type: "error", message: "The connection dropped before the run finished, and it could not be resumed. Please try again." }, undefined);
}
