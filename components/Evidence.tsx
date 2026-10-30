"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Comp, Fact } from "@/lib/types";
import { Badge, Button, Label } from "./ui";

const QLOO_HOST = "https://hackathon.api.qloo.com";

type Ctx = { open: (ids: string[], title?: string) => void; facts: Map<string, Fact>; comps: Comp[] };
const EvidenceCtx = createContext<Ctx>({ open: () => {}, facts: new Map(), comps: [] });

export function useEvidence() {
  return useContext(EvidenceCtx);
}

export function EvidenceProvider({ facts, comps, children }: { facts: Fact[]; comps: Comp[]; children: ReactNode }) {
  const [state, setState] = useState<{ ids: string[]; title?: string } | null>(null);
  const map = new Map(facts.map((f) => [f.id, f]));
  return (
    <EvidenceCtx.Provider value={{ open: (ids, title) => setState({ ids, title }), facts: map, comps }}>
      {children}
      {state && <Drawer ids={state.ids} title={state.title} facts={map} comps={comps} onClose={() => setState(null)} />}
    </EvidenceCtx.Provider>
  );
}

/** Solid chip for retrieved evidence. Click opens the request behind it. */
export function FactChips({ ids, title, max = 3 }: { ids: string[]; title?: string; max?: number }) {
  const { open, facts } = useEvidence();
  const valid = ids.filter((id) => facts.has(id));
  if (!valid.length) return <span className="text-xs text-muted">No Qloo signal</span>;
  return (
    <span className="inline-flex shrink-0 gap-1 whitespace-nowrap align-middle">
      {valid.slice(0, max).map((id) => (
        <button
          key={id}
          onClick={() => open(valid, title)}
          className="rounded bg-evidence-bg px-1.5 py-0.5 font-mono text-[11px] font-medium text-evidence hover:ring-1 hover:ring-evidence"
          aria-label={`Open evidence ${id}`}
        >
          {id}
        </button>
      ))}
      {valid.length > max && (
        <button onClick={() => open(valid, title)} className="font-mono text-[11px] text-evidence hover:underline">
          +{valid.length - max}
        </button>
      )}
    </span>
  );
}

function requestUrl(f: Fact) {
  const qs = new URLSearchParams(f.request.params).toString();
  return `${QLOO_HOST}${f.request.path}?${qs}`;
}

function Drawer({ ids, title, facts, comps, onClose }: { ids: string[]; title?: string; facts: Map<string, Fact>; comps: Comp[]; onClose: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const list =ids.map((id) => facts.get(id)).filter((f): f is Fact => !!f);
  const name = (id: string) => comps.find((c) => c.entityId === id)?.name ?? id;
  const copy = async (f: Fact) => {
    await navigator.clipboard?.writeText(`curl -H "X-Api-Key: $QLOO_API_KEY" "${requestUrl(f)}"`);
    setCopied(f.id);
    setTimeout(() => setCopied(null), 1500);
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden" role="dialog" aria-modal="true" aria-label="Evidence">
      <button className="absolute inset-0 bg-black/30" aria-label="Close evidence" onClick={onClose} />
      <aside className="relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-surface p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <Label>Evidence</Label>
            <h2 className="mt-1 text-lg font-semibold">{title ?? "Qloo facts"}</h2>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <ul className="space-y-3">
          {list.map((f) => (
            <li key={f.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-evidence-bg px-1.5 py-0.5 font-mono text-xs font-semibold text-evidence">{f.id}</span>
                <Badge>{f.kind}</Badge>
                {f.synthetic ? <Badge tone="warn">synthetic</Badge> : f.recorded ? <Badge tone="warn">recorded</Badge> : <Badge tone="evidence">live</Badge>}
              </div>
              <div className="mt-2 text-sm">
                <span className="font-medium">{f.subject?.name ?? "—"}</span>
                {f.subject?.type && <span className="text-muted"> · {f.subject.type}</span>}
              </div>
              <div className="mt-1 text-sm">
                {f.kind === "compare"
                  ? f.detail?.group && typeof f.detail?.a !== "number"
                    ? `group ${f.detail.group === "shared" ? "shared" : `unique to ${f.detail.group.toString().toUpperCase()}`}, score`
                    : "affinity A − B"
                  : f.kind === "heatmap"
                    ? "heatmap affinity"
                    : f.kind === "demographic"
                      ? "affinity vs. average"
                      : "affinity"}
                :{" "}
                <span className="font-mono font-semibold" title={String(f.value)}>
                  {fmt(f.value)}
                </span>
                {f.detail && (
                  <span className="text-muted">
                    {" "}
                    ({Object.entries(f.detail)
                      .filter(([k]) => k !== "tags")
                      .map(([k, v]) => `${k} ${fmt(v)}`)
                      .join(", ")}
                    )
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted">Audience: {f.compIds.map(name).join(" + ")}</div>
              <div className="mt-2 rounded-lg bg-surface-2 p-2 font-mono text-[11px] leading-relaxed break-all text-muted">
                GET {f.request.path}
                {Object.entries(f.request.params).map(([k, v]) => (
                  <div key={k}>
                    {k}={v}
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-muted">
                <span>{f.recorded ? "Recorded" : "Retrieved"} {new Date(f.retrievedAt).toLocaleString()}</span>
                <Button variant="quiet" onClick={() => copy(f)}>
                  {copied === f.id ? "Copied" : "Copy request"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs text-muted">
          Every number in Crossover comes from a Qloo response like these. Qloo affinity describes aggregate taste overlap; it is not a forecast of box office,
          streams or ticket sales.
        </p>
      </aside>
    </div>
  );
}

/** Qloo returns up to 16 decimals; three are plenty to read. The exact value stays in the tooltip. */
function fmt(v: unknown): string {
  return typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : String(v);
}
