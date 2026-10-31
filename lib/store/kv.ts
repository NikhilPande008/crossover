// Durable key-value store shared by every server instance: runs, run events, Qloo
// responses, preset recordings and per-visitor caps. It speaks the Redis REST protocol
// (Upstash, provisioned from the Vercel Marketplace, which sets KV_REST_API_URL and
// KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN).
// Without one it falls back to this instance's memory: fine on one long-running host,
// but on Vercel a request can then land on an instance that has never seen the run.
// Qloo-derived values stored here live server-side only, like the in-memory cache;
// none are ever written to the repo.

type Cmd = (string | number)[];

const url = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function kvDurable(): boolean {
  return Boolean(url() && token());
}

async function rest(cmds: Cmd[]): Promise<unknown[]> {
  const r = await fetch(`${url()}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) throw new Error(`KV ${r.status}`);
  const out = (await r.json()) as { result?: unknown; error?: string }[];
  return out.map((x) => {
    if (x.error) throw new Error(`KV error: ${x.error}`);
    return x.result;
  });
}

// ---- memory fallback (also a read-through cache in front of the REST store) ----

type Entry = { v: string; exp: number };
// On globalThis: route handlers and pages are bundled separately, and each bundle would
// otherwise get its own copy, so a share-link page could not see a run its API just saved.
type List = { items: string[]; exp: number };
type MemStore = { mem: Map<string, Entry>; lists: Map<string, List> };
const g = globalThis as { __crossoverKv?: MemStore };
const shared: MemStore = (g.__crossoverKv ??= { mem: new Map(), lists: new Map() });
const mem = shared.mem;
const lists = shared.lists;
const MEM_MAX = 3000;

function memGet(key: string): string | undefined {
  const e = mem.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) {
    mem.delete(key);
    return undefined;
  }
  return e.v;
}

function memSet(key: string, v: string, ttlSec: number) {
  mem.delete(key);
  mem.set(key, { v, exp: Date.now() + ttlSec * 1000 });
  while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value!);
}

function memList(key: string) {
  const l = lists.get(key);
  if (l && l.exp < Date.now()) {
    lists.delete(key);
    return undefined;
  }
  return l;
}

/** Errors from the durable store are logged once and treated as a miss, so a store outage never breaks a run. */
let warned = false;
function warn(e: unknown) {
  if (warned) return;
  warned = true;
  console.warn("[kv] durable store unavailable, using memory:", e instanceof Error ? e.message : e);
}

export const kv = {
  async get<T>(key: string): Promise<T | undefined> {
    const local = memGet(key);
    if (local !== undefined) return JSON.parse(local) as T;
    if (!kvDurable()) return undefined;
    try {
      const [v] = await rest([["GET", key]]);
      if (typeof v !== "string") return undefined;
      memSet(key, v, 300);
      return JSON.parse(v) as T;
    } catch (e) {
      warn(e);
      return undefined;
    }
  },

  async set(key: string, value: unknown, ttlSec: number): Promise<void> {
    const v = JSON.stringify(value);
    memSet(key, v, ttlSec);
    if (!kvDurable()) return;
    try {
      await rest([["SET", key, v, "EX", ttlSec]]);
    } catch (e) {
      warn(e);
    }
  },

  /** Append values to a list and refresh its expiry. */
  async push(key: string, values: unknown[], ttlSec: number): Promise<void> {
    if (!values.length) return;
    const vs = values.map((x) => JSON.stringify(x));
    const l = memList(key) ?? { items: [], exp: 0 };
    l.items.push(...vs);
    l.exp = Date.now() + ttlSec * 1000;
    lists.set(key, l);
    if (!kvDurable()) return;
    try {
      await rest([["RPUSH", key, ...vs], ["EXPIRE", key, ttlSec]]);
    } catch (e) {
      warn(e);
    }
  },

  /** List items from index `from` to the end. Reads the durable store, which other instances also write. */
  async range<T>(key: string, from: number): Promise<T[]> {
    if (kvDurable()) {
      try {
        const [v] = await rest([["LRANGE", key, from, -1]]);
        if (Array.isArray(v)) return v.map((x) => JSON.parse(String(x)) as T);
      } catch (e) {
        warn(e);
      }
    }
    return (memList(key)?.items.slice(from) ?? []).map((x) => JSON.parse(x) as T);
  },

  /** Fixed-window counter: increments and returns the count for this window. */
  async incr(key: string, ttlSec: number): Promise<number> {
    if (kvDurable()) {
      try {
        const [n] = await rest([["INCR", key], ["EXPIRE", key, ttlSec, "NX"]]);
        return Number(n);
      } catch (e) {
        warn(e);
      }
    }
    const n = Number(memGet(key) ?? 0) + 1;
    memSet(key, String(n), ttlSec);
    return n;
  },
};

/** Test hook. */
export function resetKvMemory() {
  mem.clear();
  lists.clear();
}
