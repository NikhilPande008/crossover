// Thin Qloo REST client: X-Api-Key auth, param allowlist, retries on 429/5xx,
// burst pacing, quota tracking from response headers, an in-memory LRU cache,
// and a trace hook. In fixture mode it answers from the synthetic generator.

import { config } from "@/lib/config";
import { kv, kvDurable } from "@/lib/store/kv";
import { assertParams } from "./params";
import { fixtureResponse } from "./fixture";

export type QlooRequest = { path: string; params: Record<string, string> };

export type QlooResponse = {
  data: unknown;
  status: number;
  cached: boolean;
  synthetic: boolean;
  retrievedAt: string;
  ms: number;
};

export class QlooError extends Error {
  constructor(
    message: string,
    public status: number,
    public request: QlooRequest,
  ) {
    super(message);
  }
}

export class BudgetExhaustedError extends Error {}

// ---- process-wide state; responses are also shared across instances through the durable store ----

type CacheEntry = { data: unknown; retrievedAt: string; synthetic: boolean };
const CACHE_MAX = 2000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry & { at: number }>();

const quota = {
  remaining: undefined as number | undefined,
  limit: undefined as number | undefined,
  liveCalls: 0,
  errors: {} as Record<string, number>,
  /** Names (never values) of rate-limit and quota headers Qloo has sent, so /api/health shows what the floor can read. */
  headersSeen: [] as string[],
};

export function quotaStatus() {
  return { ...quota, floor: config.quotaFloor() };
}

export function belowQuotaFloor(): boolean {
  return quota.remaining !== undefined && quota.remaining < config.quotaFloor();
}

let lastCallAt = 0;
const MIN_GAP_MS = 220; // ~4.5 req/s, under the observed 5 req/s burst limit

async function pace() {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  lastCallAt = Math.max(Date.now(), lastCallAt + MIN_GAP_MS);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export function cacheKey(req: QlooRequest): string {
  const sorted = Object.keys(req.params)
    .sort()
    .map((k) => `${k}=${req.params[k]}`)
    .join("&");
  return `${req.path}?${sorted}`;
}

/** Test hook: empty the process-wide response cache, so call counts reflect only this run's own reuse. */
export function resetQlooCache() {
  cache.clear();
}

function readCache(key: string): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit); // LRU bump
  return hit;
}

function writeCache(key: string, entry: CacheEntry) {
  cache.set(key, { ...entry, at: Date.now() });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function captureQuotaHeaders(h: Headers) {
  // Header names are unverified; capture any monthly/remaining counters we see. Without one,
  // quota.remaining stays undefined and the quota floor cannot trigger (see headersSeen).
  for (const [k, v] of h.entries()) {
    const key = k.toLowerCase();
    if (/limit|remaining|quota|reset/.test(key) && !quota.headersSeen.includes(key) && quota.headersSeen.length < 20) quota.headersSeen.push(key);
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (key.includes("remaining") && (key.includes("month") || key.includes("quota"))) quota.remaining = n;
    if (key.includes("limit") && (key.includes("month") || key.includes("quota"))) quota.limit = n;
  }
}

// ---- per-run client ----

export type CallListener = (info: { req: QlooRequest; res?: QlooResponse; error?: QlooError }) => void;

export class QlooClient {
  calls = 0; // network calls (live or synthetic) this run
  cachedCalls = 0;

  constructor(
    private opts: { maxCalls: number; onCall?: CallListener; mode?: "live" | "fixture"; signal?: AbortSignal } = {
      maxCalls: config.maxCallsPerRun(),
    },
  ) {}

  get mode() {
    return this.opts.mode ?? config.mode;
  }

  get remaining() {
    return this.opts.maxCalls - this.calls;
  }

  async get(path: string, params: Record<string, string>): Promise<QlooResponse> {
    const req = { path, params };
    assertParams(path, params);
    const key = `${this.mode}:${cacheKey(req)}`;
    let hit = readCache(key);
    // Another instance may have fetched it: a comp swap on Vercel then re-uses its calls.
    if (!hit && kvDurable() && this.mode === "live") {
      const shared = await kv.get<CacheEntry & { at: number }>(`qloo:${key}`);
      if (shared && Date.now() - shared.at < CACHE_TTL_MS) {
        writeCache(key, shared);
        hit = shared;
      }
    }
    if (hit) {
      this.cachedCalls++;
      const res: QlooResponse = { ...hit, status: 200, cached: true, ms: 0 };
      this.opts.onCall?.({ req, res });
      return res;
    }
    if (this.opts.signal?.aborted) throw new QlooError("Request aborted", 0, req);
    if (this.calls >= this.opts.maxCalls) throw new BudgetExhaustedError(`Qloo call budget (${this.opts.maxCalls}) exhausted`);
    this.calls++;

    const started = Date.now();
    try {
      const { data, status } = this.mode === "fixture" ? { data: fixtureResponse(req), status: 200 } : await this.fetchLive(req);
      const res: QlooResponse = {
        data,
        status,
        cached: false,
        synthetic: this.mode === "fixture",
        retrievedAt: new Date().toISOString(),
        ms: Date.now() - started,
      };
      writeCache(key, { data, retrievedAt: res.retrievedAt, synthetic: res.synthetic });
      if (kvDurable() && this.mode === "live") void kv.set(`qloo:${key}`, { data, retrievedAt: res.retrievedAt, synthetic: false, at: Date.now() }, CACHE_TTL_MS / 1000);
      this.opts.onCall?.({ req, res });
      return res;
    } catch (e) {
      const err = e instanceof QlooError ? e : new QlooError(String(e), 0, req);
      quota.errors[String(err.status)] = (quota.errors[String(err.status)] ?? 0) + 1;
      this.opts.onCall?.({ req, error: err });
      throw err;
    }
  }

  private async fetchLive(req: QlooRequest): Promise<{ data: unknown; status: number }> {
    const url = new URL(config.qlooBaseUrl() + req.path);
    for (const [k, v] of Object.entries(req.params)) url.searchParams.set(k, v);

    for (let attempt = 0; attempt < 4; attempt++) {
      await pace();
      quota.liveCalls++;
      const r = await fetch(url, {
        headers: { "X-Api-Key": config.qlooKey(), accept: "application/json" },
        signal: this.opts.signal ? AbortSignal.any([AbortSignal.timeout(15_000), this.opts.signal]) : AbortSignal.timeout(15_000),
      });
      captureQuotaHeaders(r.headers);
      if (r.ok) return { data: await r.json(), status: r.status };
      if (r.status === 429 || r.status >= 500) {
        const reset = Number(r.headers.get("x-second-ratelimit-reset") ?? r.headers.get("retry-after"));
        const waitMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : 400 * 2 ** attempt;
        await new Promise((res) => setTimeout(res, Math.min(waitMs, 4000)));
        continue;
      }
      const body = await r.text().catch(() => "");
      throw new QlooError(`Qloo ${r.status} on ${req.path}: ${body.slice(0, 200)}`, r.status, req);
    }
    throw new QlooError(`Qloo retries exhausted on ${req.path}`, 429, req);
  }
}
