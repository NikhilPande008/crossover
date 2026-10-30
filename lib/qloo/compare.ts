// Tolerant parser for /v2/analysis/compare. The docs give the request but not the
// result schema (results is an array of one-of several undocumented item types), so
// this accepts the shapes we can reasonably expect and reports when it recognises none:
//   0. live (2026-10-25): { tags: [{ name, query: { score, "a.signal.interests.entities": [...],
//      "b.signal.interests.entities": [...] } }], a: [{ name, query: { count } }], b: [...] }
//      tags = shared; a / b = each side's tags (they include the shared ones, de-duplicated below)
//   1. items carrying both groups' scores: { name, query: { a: { affinity }, b: { affinity } } }
//   2. items grouped under a label: [{ type: "common", tags: [...] }, { type: "unique_to_a", ... }]
//      or keyed objects: { common: [...], unique_to_a: [...], unique_to_b: [...] }

export type CompareGroup = "shared" | "a" | "b";

export type CompareItem = {
  name: string;
  id?: string;
  group: CompareGroup;
  /** a − b when both scores are present. */
  delta?: number;
  a?: number;
  b?: number;
  score?: number;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Map a group label such as "Common", "unique_to_a", "UniqueToB", "groupA" to a group. */
export function groupFromLabel(label: string | undefined): CompareGroup | undefined {
  if (!label) return undefined;
  const l = label.toLowerCase().replace(/[^a-z]/g, "");
  if (/common|shared|both|overlap|intersection/.test(l)) return "shared";
  if (/^(a|groupa|uniquetoa|onlya|aonly|first)$/.test(l)) return "a";
  if (/^(b|groupb|uniquetob|onlyb|bonly|second)$/.test(l)) return "b";
  return undefined;
}

function scoreOf(item: Rec): number | undefined {
  const q = isRec(item.query) ? item.query : undefined;
  return num(item.affinity) ?? num(q?.affinity) ?? num(item.score);
}

function sideScore(item: Rec, side: "a" | "b"): number | undefined {
  const q = isRec(item.query) ? item.query : {};
  const v = q[side] ?? item[side];
  return isRec(v) ? num(v.affinity) ?? num(v.score) : num(v);
}

function labelOf(node: Rec): string | undefined {
  for (const k of ["group", "type", "category", "label", "kind", "section"]) if (typeof node[k] === "string") return node[k] as string;
  return undefined;
}

const SHARED_DELTA = 0.12;

export function parseCompare(results: unknown): CompareItem[] {
  const out: CompareItem[] = [];
  const walk = (node: unknown, label: string | undefined, depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, label, depth + 1);
      return;
    }
    if (!isRec(node)) return;
    const isLeaf = typeof node.name === "string" && ("entity_id" in node || "tag_id" in node || "id" in node || "query" in node || "affinity" in node);
    if (isLeaf) {
      // Live shape: shared tags carry both signal groups under query plus a score.
      const q = isRec(node.query) ? node.query : {};
      if ("a.signal.interests.entities" in q && "b.signal.interests.entities" in q) {
        out.push({ name: node.name as string, id: (node.tag_id ?? node.id) as string | undefined, group: "shared", score: num(q.score) });
        return;
      }
      const a = sideScore(node, "a");
      const b = sideScore(node, "b");
      const id = (node.entity_id ?? node.tag_id ?? node.id) as string | undefined;
      if (a !== undefined && b !== undefined) {
        const delta = Math.round((a - b) * 1000) / 1000;
        out.push({ name: node.name as string, id, a, b, delta, group: Math.abs(delta) < SHARED_DELTA ? "shared" : delta > 0 ? "a" : "b" });
        return;
      }
      const group = groupFromLabel(label) ?? groupFromLabel(labelOf(node));
      if (group) out.push({ name: node.name as string, id, group, score: scoreOf(node) });
      return;
    }
    const own = labelOf(node);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v !== "object" || v === null) continue;
      walk(v, groupFromLabel(own) ? own : groupFromLabel(k) ? k : label, depth + 1);
    }
  };
  walk(results, undefined, 0);
  // De-duplicate by name, keeping the first occurrence.
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.name.toLowerCase()) ? false : (seen.add(i.name.toLowerCase()), true)));
}
