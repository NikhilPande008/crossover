// Every Qloo-derived value lives here as a Fact with the request that produced it.
// The LLM only ever sees compact summaries keyed by fact ID.

import type { Fact } from "@/lib/types";

export class FactStore {
  private facts = new Map<string, Fact>();
  private seq = 0;

  add(f: Omit<Fact, "id">): Fact {
    const fact = { ...f, id: `F${++this.seq}` };
    this.facts.set(fact.id, fact);
    return fact;
  }

  /** Restore facts from a previous run (comp swap), keeping their IDs. */
  adopt(prev: Fact[]) {
    for (const f of prev) {
      this.facts.set(f.id, f);
      const n = Number(f.id.slice(1));
      if (n > this.seq) this.seq = n;
    }
  }

  get(id: string) {
    return this.facts.get(id);
  }

  has(id: string) {
    return this.facts.has(id);
  }

  all(): Fact[] {
    return [...this.facts.values()];
  }

  byKind(kind: Fact["kind"]) {
    return this.all().filter((f) => f.kind === kind);
  }

  /** Compact, LLM-facing summary lines. Entity names are data, quoted and escaped. */
  summary(filter?: (f: Fact) => boolean, limit = 400): string {
    return this.all()
      .filter(filter ?? (() => true))
      .slice(0, limit)
      .map((f) => {
        const subj = f.subject ? ` ${JSON.stringify(f.subject.name)}${f.subject.type ? ` (${f.subject.type})` : ""}` : "";
        const val = typeof f.value === "number" ? f.value : JSON.stringify(f.value);
        return `${f.id} ${f.kind} comps=[${f.compIds.join(",")}]${subj} value=${val}`;
      })
      .join("\n");
  }
}
