// In-memory run store, per-IP live-run caps, and recorded-run replay.
// Recorded runs are cached Qloo-derived results; they live in .data/ (gitignored)
// on the server and are never committed.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "@/lib/types";
import { config } from "@/lib/config";

const RUNS_MAX = 300;
const runs = new Map<string, RunResult>();

export function saveRun(r: RunResult) {
  runs.set(r.runId, r);
  while (runs.size > RUNS_MAX) runs.delete(runs.keys().next().value!);
}

export function getRun(id: string): RunResult | undefined {
  return runs.get(id);
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

const hits = new Map<string, number[]>();

/** Sliding one-hour window per (bucket, ip). Records the hit only when allowed. */
export function allowHit(bucket: CapBucket, ip: string, now = Date.now()): boolean {
  const key = `${bucket}:${ip}`;
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3600_000);
  const ok = recent.length < capLimit(bucket);
  if (ok) recent.push(now);
  hits.set(key, recent);
  return ok;
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

// Vercel's filesystem is read-only except /tmp, which lasts only as long as the instance.
const DIR = process.env.VERCEL ? join("/tmp", "crossover", "recorded") : join(process.cwd(), ".data", "recorded");

// Preset ids become file names; anything but a plain slug is refused.
const SAFE_ID = /^[a-z0-9-]{1,64}$/;

export function recordPreset(presetId: string, r: RunResult) {
  if (r.mode !== "live" || !SAFE_ID.test(presetId)) return;
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${presetId}.json`), JSON.stringify(r));
  } catch {
    // Read-only filesystem: recording is best-effort.
  }
}

export function loadRecorded(presetId: string): RunResult | undefined {
  if (!SAFE_ID.test(presetId)) return undefined;
  const p = join(DIR, `${presetId}.json`);
  if (!existsSync(p)) return undefined;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as RunResult;
    return {
      ...r,
      mode: "recorded",
      facts: r.facts.map((f) => ({ ...f, recorded: true })),
      qlooCalls: 0,
      cachedCalls: 0,
    };
  } catch {
    return undefined;
  }
}
