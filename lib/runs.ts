// Run store, run event log, per-IP live-run caps, and recorded-run replay.
// Everything goes through lib/store/kv.ts, so with a durable store any server
// instance can resume a run's event stream, re-use a run's facts for a comp swap,
// serve a shared brief link, or replay a preset. Recorded runs are cached
// Qloo-derived results; they live server-side (store or .data/, gitignored) and are
// never committed.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ProgressEvent, RunResult } from "@/lib/types";
import { config } from "@/lib/config";
import { kv } from "@/lib/store/kv";

const RUN_TTL = 30 * 24 * 3600;
const EVENTS_TTL = 2 * 3600;

/** Partner tag lists are only needed server-side (exclusion checks) and are over a third of the payload. */
export function forClient(r: RunResult): RunResult {
  return {
    ...r,
    facts: r.facts.map((f) => {
      if (!f.detail || !("tags" in f.detail)) return f;
      const { tags: _tags, ...detail } = f.detail;
      void _tags;
      return { ...f, detail };
    }),
  };
}

export async function saveRun(r: RunResult) {
  await kv.set(`run:${r.runId}`, r, RUN_TTL);
}

export async function getRun(id: string): Promise<RunResult | undefined> {
  if (!/^[\w-]{1,64}$/.test(id)) return undefined;
  return kv.get<RunResult>(`run:${id}`);
}

// ---- run event log (resumable progress) ----

/** Stored events. The final result is stored as the run itself; the log gets a marker. */
export type LoggedEvent = Exclude<ProgressEvent, { type: "result" }> | { type: "done"; runId: string };

/** Buffers progress events and flushes them to the store in batches (one store call per ~0.5 s). */
export class EventLog {
  private buf: LoggedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private runId: string) {}

  push(e: ProgressEvent) {
    const logged: LoggedEvent = e.type === "result" ? { type: "done", runId: e.result.runId } : e;
    this.buf.push(logged);
    if (e.type === "result" || e.type === "error") void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 500);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buf.splice(0);
    this.chain = this.chain.then(() => kv.push(`events:${this.runId}`, batch, EVENTS_TTL));
    return this.chain;
  }
}

export function readEvents(runId: string, from: number): Promise<LoggedEvent[]> {
  return kv.range<LoggedEvent>(`events:${runId}`, from);
}

// ---- per-visitor caps (live mode only) ----

export type CapBucket = "run" | "refine" | "resolve" | "suggest" | "baseline";

/**
 * Per-hour limits. Refinements re-use cached facts, so they get a larger, separate budget.
 * Each resolve can spend up to 4 Qloo searches; autocomplete spends 1 per pause in typing.
 */
export function capLimit(bucket: CapBucket): number {
  const runs = config.runsPerIpHour();
  return { run: runs, refine: runs * 3, resolve: 30, suggest: 40, baseline: runs * 2 }[bucket];
}

/** Hourly fixed window per (bucket, ip), shared across instances when the store is durable. */
export async function allowHit(bucket: CapBucket, ip: string, now = Date.now()): Promise<boolean> {
  const hour = Math.floor(now / 3600_000);
  const n = await kv.incr(`cap:${bucket}:${ip}:${hour}`, 3600);
  return n <= capLimit(bucket);
}

/**
 * Visitor IP. X-Forwarded-For entries left of our own proxies are client-supplied
 * and spoofable, so take the entry TRUSTED_PROXY_HOPS from the right (default 1:
 * the address appended by the host's edge proxy).
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hops = Math.max(1, config.trustedProxyHops());
    const ip = parts[Math.max(0, parts.length - hops)];
    if (ip) return ip;
  }
  return req.headers.get("x-real-ip") || "local";
}

/**
 * A request is a refinement only if it re-uses an existing run and changes at most
 * one comp. Anything else is a new run, whatever the client claims.
 */
export function isRefinementOf(prior: RunResult | undefined, compIds: string[]): boolean {
  if (!prior) return false;
  const before = new Set(prior.comps.map((c) => c.entityId));
  const changed = compIds.filter((id) => !before.has(id)).length;
  return changed <= 1 && Math.abs(compIds.length - before.size) <= 1;
}

// ---- recorded runs ----

// Vercel's filesystem is read-only except /tmp, which lasts only as long as the instance;
// the durable store is the reliable copy there.
const DIR = process.env.VERCEL ? join("/tmp", "crossover", "recorded") : join(process.cwd(), ".data", "recorded");

// Preset ids become keys and file names; anything but a plain slug is refused.
const SAFE_ID = /^[a-z0-9-]{1,64}$/;

export async function recordPreset(presetId: string, r: RunResult) {
  if (r.mode !== "live" || !SAFE_ID.test(presetId)) return;
  await kv.set(`recorded:${presetId}`, forClient(r), RUN_TTL);
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${presetId}.json`), JSON.stringify(r));
  } catch {
    // Read-only filesystem: the store copy is enough.
  }
}

export async function loadRecorded(presetId: string): Promise<RunResult | undefined> {
  if (!SAFE_ID.test(presetId)) return undefined;
  let r = await kv.get<RunResult>(`recorded:${presetId}`);
  if (!r) {
    const p = join(DIR, `${presetId}.json`);
    if (!existsSync(p)) return undefined;
    try {
      r = JSON.parse(readFileSync(p, "utf8")) as RunResult;
    } catch {
      return undefined;
    }
  }
  return {
    ...r,
    mode: "recorded",
    facts: r.facts.map((f) => ({ ...f, recorded: true })),
    qlooCalls: 0,
    cachedCalls: 0,
  };
}
