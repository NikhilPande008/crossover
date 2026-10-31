"use client";

import { useMemo, useState } from "react";
import type { BaselineResult, Concept, Domain, RunResult } from "@/lib/types";
import type { Preset } from "@/lib/presets";
import { diffRuns } from "@/lib/diff";
import { THRESHOLDS } from "@/lib/thresholds";
import { formatUsage } from "@/lib/llm/usage";
import { Badge, Button, Card, CONFIDENCE_TONE, Label, cx } from "./ui";
import { EvidenceProvider, FactChips, useEvidence } from "./Evidence";

type Refinements = { excludedPartners: string[]; pinnedMarkets: string[] };

const TABS = ["Concepts", "Audience map", "Without Qloo", "Decision brief", "Agent trace"] as const;
type Tab = (typeof TABS)[number];

const DOMAIN_LABEL: Record<Domain, string> = { podcast: "Podcasts", artist: "Artists", tv_show: "TV", movie: "Films", book: "Books", brand: "Brands" };
const LEVER_LABEL = { market: "Market-led", partner: "Partner-led", crossover: "Crossover" };
/** Match the server's limits on refinements (lib/validate/input.ts). */
const MAX_PINS = 5;
const MAX_EXCLUDED = 20;

export function Results(props: {
  result: RunResult;
  previous: RunResult | null;
  busy: boolean;
  steps: { message: string; calls: number }[];
  preset: Preset | null;
  refinements: Refinements;
  onRefine: (r: Refinements) => void;
  onSwap: (fromId: string, name: string) => void;
  onRelax: (constraint: string, kind: "exclusion" | "not-a-fit") => void;
}) {
  const { result } = props;
  const [tab, setTab] = useState<Tab>("Concepts");
  return (
    <EvidenceProvider facts={result.facts} comps={result.comps}>
      <div className="print:hidden">
        <RunHeader key={result.runId} {...props} />
        {props.previous && <DiffBanner before={props.previous} after={result} />}
        <nav className="mt-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cx("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", tab === t ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")}
            >
              {t}
            </button>
          ))}
        </nav>
      </div>
      <div className={cx("mt-6", props.busy && "opacity-60 transition")}>
        {tab === "Concepts" && <Concepts {...props} />}
        {tab === "Audience map" && <AudienceMap {...props} />}
        {/* Keyed by run: a comp swap must not keep showing the previous comps' baseline. */}
        {tab === "Without Qloo" && <WithoutQloo key={result.runId} result={result} />}
        {tab === "Decision brief" && <BriefView result={result} />}
        {tab === "Agent trace" && <Trace result={result} />}
      </div>
      {tab !== "Decision brief" && (
        <div className="hidden print:block">
          <BriefView result={result} />
        </div>
      )}
    </EvidenceProvider>
  );
}

function ModeBanner({ result }: { result: RunResult }) {
  if (result.mode === "fixture") return <Badge tone="warn">Synthetic data — not Qloo. Set QLOO_API_KEY for live results.</Badge>;
  if (result.mode === "recorded")
    return (
      <Badge tone="warn">
        Recorded live{result.facts[0] ? ` on ${new Date(result.facts[0].retrievedAt).toLocaleDateString()}` : ""}; replayed now, no Qloo calls made
      </Badge>
    );
  if (result.qlooCalls === 0 && result.cachedCalls > 0) return <Badge tone="warn">Qloo data retrieved earlier (served from cache)</Badge>;
  return <Badge tone="evidence">Live Qloo data</Badge>;
}

function RunHeader({ result, busy, steps, preset, refinements, onRefine, onSwap }: Parameters<typeof Results>[0]) {
  const [swapFrom, setSwapFrom] = useState(result.comps.find((c) => c.name === preset?.swap.from)?.entityId ?? result.comps.at(-1)!.entityId);
  const [swapTo, setSwapTo] = useState(preset && result.comps.some((c) => c.name === preset.swap.from) ? preset.swap.to : "");
  const [showSwap, setShowSwap] = useState(false);
  return (
    <section className="pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <ModeBanner result={result} />
        <Badge>
          {result.qlooCalls} Qloo calls{result.cachedCalls ? ` · ${result.cachedCalls} from cache` : ""}
        </Badge>
        <Badge>{(result.ms / 1000).toFixed(1)} s</Badge>
        {!result.llmUsed && <Badge tone="warn">Written without the language model</Badge>}
        {result.llmUsage?.calls > 0 && (
          <span title={result.llmUsage.byPhase.map((p) => `${p.phase}: ${formatUsage({ ...p, provider: result.llmUsage.provider })}`).join("\n")}>
            <Badge>
              {result.llmUsage.models.join(", ")} · {formatUsage(result.llmUsage)}
            </Badge>
          </span>
        )}
      </div>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">“{result.brief.title}”</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>Positioned against</span>
        {result.comps.map((c) => (
          <span key={c.entityId} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-ink">
            {c.name}
            {c.year ? <span className="text-muted"> {c.year}</span> : null}
          </span>
        ))}
        <Button variant="quiet" onClick={() => setShowSwap((s) => !s)} disabled={busy}>
          Swap comp
        </Button>
      </div>
      <LeadLine result={result} />
      {showSwap && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (swapTo.trim()) {
              setShowSwap(false);
              onSwap(swapFrom, swapTo.trim());
            }
          }}
        >
          Replace
          <select className="rounded-lg border border-line bg-surface px-2 py-1" value={swapFrom} onChange={(e) => setSwapFrom(e.target.value)} aria-label="Comp to replace">
            {result.comps.map((c) => (
              <option key={c.entityId} value={c.entityId}>
                {c.name}
              </option>
            ))}
          </select>
          with
          <input className="rounded-lg border border-line bg-surface px-2 py-1" value={swapTo} onChange={(e) => setSwapTo(e.target.value)} placeholder="Another released title" aria-label="New comp" />
          <Button type="submit" disabled={busy || !swapTo.trim()}>
            Re-plan
          </Button>
        </form>
      )}
      {(refinements.excludedPartners.length > 0 || refinements.pinnedMarkets.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Refinements:</span>
          {refinements.pinnedMarkets.map((m) => (
            <button key={m} className="rounded-full bg-surface-2 px-2 py-0.5" onClick={() => onRefine({ ...refinements, pinnedMarkets: refinements.pinnedMarkets.filter((x) => x !== m) })}>
              📍 {m} ×
            </button>
          ))}
          {refinements.excludedPartners.map((p) => (
            <button key={p} className="rounded-full bg-surface-2 px-2 py-0.5 line-through" onClick={() => onRefine({ ...refinements, excludedPartners: refinements.excludedPartners.filter((x) => x !== p) })}>
              {p} ×
            </button>
          ))}
        </div>
      )}
      {busy && (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted" aria-live="polite">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
          Re-planning… {steps.at(-1)?.message ?? ""}
        </div>
      )}
    </section>
  );
}

/**
 * The core decision in one line: which comp(s) the recommended concept positions against, and
 * how many comp pairs Qloo's theme compare says share an audience. Built from the run's own data.
 */
function LeadLine({ result }: { result: RunResult }) {
  const { facts } = useEvidence();
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId);
  if (!rec) return null;
  const name = (id: string) => result.comps.find((c) => c.entityId === id)?.name ?? id;
  const pairs = result.audience.overlaps;
  const shared = pairs.filter((o) => o.similar).length;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <Badge tone="accent">Lead with</Badge>
      <b>{rec.leadComps.map(name).join(" + ")}</b>
      <span className="text-muted">
        · {LEVER_LABEL[rec.lever].toLowerCase()} concept
        {pairs.length > 0 && ` · ${shared} of ${pairs.length} comp pair${pairs.length === 1 ? "" : "s"} share an audience (Qloo theme overlap)`}
      </span>
      {/* The verdict rests on the compare facts (shared vs. one-sided themes), so those are the evidence shown. */}
      {pairs.length > 0 && <FactChips ids={pairs.flatMap((o) => o.factIds).filter((id) => facts.get(id)?.kind === "compare")} title="One audience or two?" max={1} />}
    </div>
  );
}

function DiffBanner({ before, after }: { before: RunResult; after: RunResult }) {
  const d = useMemo(() => diffRuns(before, after), [before, after]);
  const { open } = useEvidence();
  const [more, setMore] = useState(false);
  const compChange = d.compsBefore.join() !== d.compsAfter.join();
  return (
    <div className="mt-5 rounded-2xl border border-accent/40 bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span className="font-semibold">{compChange ? "Comp swapped — the plan changed" : "Re-planned"}</span>
        <span>
          Markets changed: <b>{d.marketsChanged}</b> of {d.marketsTotal}
        </span>
        <span>
          Partners changed: <b>{d.partnersChanged}</b> of {d.partnersTotal}
        </span>
        <span>
          Lead concept: {d.leadChanged ? (
            <>
              <s className="text-muted">{d.leadBefore}</s> → <b>{d.leadAfter}</b>
            </>
          ) : (
            <b>unchanged</b>
          )}
        </span>
        <Button variant="quiet" onClick={() => setMore((m) => !m)}>
          {more ? "Hide" : "What moved?"}
        </Button>
      </div>
      {more && (
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <Label>New in the plan</Label>
            <ul className="mt-1 space-y-1">
              {d.added.map((a) => (
                <li key={a.kind + a.name}>
                  <button className="text-left hover:underline" onClick={() => open(a.factIds, a.name)}>
                    + {a.name} <span className="text-muted">({a.kind})</span>
                  </button>{" "}
                  <FactChips ids={a.factIds} title={a.name} max={2} />
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Label>Dropped</Label>
            <ul className="mt-1 space-y-1 text-muted">
              {d.removed.map((r) => (
                <li key={r.kind + r.name}>
                  − {r.name} ({r.kind})
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function ConstraintNotice({ result, onRelax, busy }: Pick<Parameters<typeof Results>[0], "result" | "onRelax" | "busy">) {
  const removals = result.constraintRemovals ?? [];
  const starved = result.concepts.filter((c) => c.partners.length === 0 || c.markets.length === 0);
  if (!removals.length && !starved.length) return null;
  const top = removals[0];
  const total = removals.reduce((s, r) => s + r.count, 0);
  if (!starved.length)
    return (
      <p className="mb-4 text-xs text-muted">
        Your constraints removed {total} partner candidate{total === 1 ? "" : "s"}: {removals.map((r) => `“${r.constraint}” (${r.count})`).join(", ")}.
      </p>
    );
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">
      <span>
        Constraints left {starved.map((c) => c.name).join(" and ")} without {starved.some((c) => c.partners.length === 0) ? "partners" : "markets"}.
        {top && (
          <>
            {" "}
            The biggest remover is “{top.constraint}” ({top.count} candidate{top.count === 1 ? "" : "s"}).
          </>
        )}
      </span>
      {top && (
        <Button variant="ghost" disabled={busy} onClick={() => onRelax(top.constraint, top.kind)}>
          Relax “{top.constraint}” and re-plan
        </Button>
      )}
    </div>
  );
}

function Concepts({ result, refinements, onRefine, onRelax, busy }: Parameters<typeof Results>[0]) {
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId);
  return (
    <section>
      <ConstraintNotice result={result} onRelax={onRelax} busy={busy} />
      <div className="grid gap-4 lg:grid-cols-3">
        {[...result.concepts]
          .sort((a, b) => Number(b.id === rec?.id) - Number(a.id === rec?.id))
          .map((c) => (
            <ConceptCard
              key={c.id}
              c={c}
              result={result}
              recommended={c.id === rec?.id}
              busy={busy}
              onExclude={refinements.excludedPartners.length < MAX_EXCLUDED ? (name) => onRefine({ ...refinements, excludedPartners: [...refinements.excludedPartners, name] }) : undefined}
            />
          ))}
      </div>
      {result.decision.whyNotOthers.length > 0 && (
        <Card className="mt-4">
          <Label>Why not the others</Label>
          <ul className="mt-2 space-y-1 text-sm">
            {result.decision.whyNotOthers.map((w, i) => (
              <li key={i}>
                {w.text} <FactChips ids={w.factIds} max={2} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">{result.decision.disclaimer}</p>
    </section>
  );
}

function ConceptCard({ c, result, recommended, onExclude, busy }: { c: Concept; result: RunResult; recommended: boolean; onExclude?: (name: string) => void; busy: boolean }) {
  const name = (id: string) => result.comps.find((x) => x.entityId === id)?.name ?? id;
  return (
    <Card className={cx("flex flex-col gap-4", recommended && "border-accent ring-1 ring-accent")}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          {recommended && <Badge tone="accent">Recommended</Badge>}
          <Badge>{LEVER_LABEL[c.lever]}</Badge>
          <Badge tone={CONFIDENCE_TONE[c.confidence]}>{c.confidence} confidence</Badge>
        </div>
        <h3 className="mt-2 text-xl font-semibold leading-snug">{c.name}</h3>
        <div className="mt-1 text-xs text-muted">Lead audience: {c.leadComps.map(name).join(" + ")}</div>
      </div>
      <div>
        <Label>Markets</Label>
        <ol className="mt-1 space-y-1 text-sm">
          {c.markets.length ? (
            c.markets.map((m, i) => (
              <li key={m.name} className="flex items-center justify-between gap-2">
                <span>
                  <span className="mr-1 font-mono text-xs text-muted">{i + 1}</span>
                  {m.name}
                </span>
                <FactChips ids={m.factIds} title={`${m.name}: fan concentration`} max={1} />
              </li>
            ))
          ) : (
            <li className="text-muted">No location signal for these comps</li>
          )}
        </ol>
      </div>
      <div>
        <Label>Partners</Label>
        <ul className="mt-1 space-y-1 text-sm">
          {c.partners.map((p) => (
            <li key={p.name} className="group flex items-center justify-between gap-2">
              <span className="min-w-0">
                {p.name} <span className="text-xs text-muted">{DOMAIN_LABEL[p.domain as Domain] ?? p.domain}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  className="whitespace-nowrap text-xs text-muted sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 hover:text-warn disabled:cursor-not-allowed"
                  disabled={busy || !onExclude}
                  onClick={() => onExclude?.(p.name)}
                  title={onExclude ? "Exclude and re-plan" : `Up to ${MAX_EXCLUDED} excluded partners`}
                >
                  Not a fit
                </button>
                <FactChips ids={p.factIds} title={`${p.name}: audience affinity`} max={1} />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <Label>Creative angle</Label>
        <p className="mt-1 text-sm">
          {c.creativeAngle.text} <FactChips ids={c.creativeAngle.factIds} title="Creative angle evidence" max={3} />
        </p>
      </div>
      {c.hypotheses.length > 0 && (
        <div className="rounded-xl bg-hyp-bg p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-hyp">Hypothesis — test before spending</div>
          <ul className="mt-1 space-y-1 text-sm italic text-hyp">
            {c.hypotheses.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {c.risks.length > 0 && (
        <div className="mt-auto text-sm">
          <Label>Main risk</Label>
          <p className="mt-1 text-muted">{c.risks[0]}</p>
        </div>
      )}
    </Card>
  );
}

function Bar({ value, tone = "evidence" }: { value: number; tone?: "evidence" | "accent" }) {
  return (
    <span className="relative inline-block h-1.5 w-20 overflow-hidden rounded-full bg-surface-2 align-middle">
      <span className={cx("absolute inset-y-0 left-0 rounded-full", tone === "evidence" ? "bg-evidence" : "bg-accent")} style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </span>
  );
}

function AudienceMap({ result, refinements, onRefine, busy }: Parameters<typeof Results>[0]) {
  const a = result.audience;
  const name = (id: string) => result.comps.find((x) => x.entityId === id)?.name ?? id;
  const domains = (Object.keys(a.partners) as Domain[]).filter((d) => a.partners[d].length);
  return (
    <section className="space-y-6">
      {a.gaps.length > 0 && (
        <div className="rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">
          <b>Evidence gaps:</b> {a.gaps.join("; ")}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <Label>Where fans concentrate</Label>
          <p className="mt-1 text-xs text-muted">Mean heatmap percentile across comps</p>
          <ol className="mt-3 space-y-1.5 text-sm">
            {a.markets.slice(0, 12).map((m, i) => (
              <li key={m.name} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  <span className="mr-1 font-mono text-xs text-muted">{i + 1}</span>
                  {m.name} <span className="text-xs text-muted">{m.country}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Bar value={m.score} tone="accent" />
                  <button
                    className={cx("text-xs disabled:cursor-not-allowed", refinements.pinnedMarkets.includes(m.name) ? "text-accent" : "text-muted hover:text-ink")}
                    disabled={busy || refinements.pinnedMarkets.includes(m.name) || refinements.pinnedMarkets.length >= MAX_PINS}
                    onClick={() => onRefine({ ...refinements, pinnedMarkets: [...refinements.pinnedMarkets, m.name] })}
                    title={refinements.pinnedMarkets.length >= MAX_PINS && !refinements.pinnedMarkets.includes(m.name) ? `Up to ${MAX_PINS} pinned markets` : "Pin this market into every concept"}
                  >
                    {refinements.pinnedMarkets.includes(m.name) ? "Pinned" : "Pin"}
                  </button>
                  <FactChips ids={m.factIds} title={`${m.name}: fan concentration`} max={1} />
                </span>
              </li>
            ))}
            {!a.markets.length && <li className="text-muted">No location signal for these comps</li>}
          </ol>
        </Card>
        <Card className="lg:col-span-2">
          <Label>One audience or two?</Label>
          <p className="mt-1 text-xs text-muted">
            The verdict uses the share of themes the two titles have in common in Qloo&apos;s compare analysis. Top-affinity overlap is how many of each comp&apos;s own top audience affinities (podcasts, artists, TV, film, books, brands) the other comp also has.
          </p>
          <div className="mt-3 space-y-4">
            {a.overlaps.map((o) => (
              <div key={o.a + o.b}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <b>{name(o.a)}</b> vs <b>{name(o.b)}</b>
                  <Bar value={o.themeShare} />
                  <span className="font-mono text-xs" title={`${o.themesCompared} distinct themes compared`}>
                    {Math.round(o.themeShare * 100)}% of themes shared
                  </span>
                  <Badge tone={o.similar ? "evidence" : "warn"}>{o.similar ? "shared audience" : "different audiences"}</Badge>
                  {o.source === "estimated-from-tags" && <Badge>estimated from taste tags</Badge>}
                  <span className="text-xs text-muted" title={`Share of ${o.compared} top audience ${o.basis === "audience-affinities" ? "affinities" : "taste tags"} that both comps have`}>
                    top-affinity overlap {Math.round(o.score * 100)}%
                  </span>
                  <FactChips ids={o.factIds} title={`${name(o.a)} vs ${name(o.b)}`} max={1} />
                </div>
                {o.sharedAudience.length > 0 && (
                  <div className="mt-1 text-xs text-muted">
                    <span className="font-semibold text-ink">Both audiences rank highly:</span> {o.sharedAudience.join(", ")}
                  </div>
                )}
                <div className="mt-1 grid gap-2 text-xs text-muted sm:grid-cols-3">
                  <div>
                    <span className="font-semibold text-ink">Shared themes{o.source === "estimated-from-tags" ? " (from tags)" : ""}:</span> {o.shared.join(", ") || "—"}
                  </div>
                  <div>
                    <span className="font-semibold text-ink">More {name(o.a)}:</span> {o.onlyA.join(", ") || "—"}
                  </div>
                  <div>
                    <span className="font-semibold text-ink">More {name(o.b)}:</span> {o.onlyB.join(", ") || "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <Label>Audience skew (aggregate)</Label>
            <ul className="mt-2 space-y-1 text-sm">
              {a.demographics.map((d) => (
                <li key={d.compId}>
                  <b>{name(d.compId)}</b>: {d.summary} <FactChips ids={d.factIds} max={2} />
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
      <Card>
        <Label>What they love across domains</Label>
        <div className="mt-3 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {domains.map((d) => (
            <div key={d} className="min-w-0">
              <div className="text-sm font-semibold">{DOMAIN_LABEL[d]}</div>
              <ul className="mt-2 space-y-1.5 text-sm">
                {a.partners[d].slice(0, 6).map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate" title={p.name}>
                      {p.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="flex gap-0.5" title={result.comps.map((c) => `${c.name}: ${p.perComp[c.entityId] ?? "no signal"}`).join("\n")}>
                        {result.comps.map((c) => (
                          <span key={c.entityId} className="inline-block h-3 w-1.5 rounded-sm bg-evidence" style={{ opacity: Math.max(0.12, p.perComp[c.entityId] ?? 0) }} />
                        ))}
                      </span>
                      <FactChips ids={p.factIds} title={`${p.name}: audience affinity`} max={1} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">Bars show each comp&apos;s affinity ({result.comps.map((c) => c.name).join(", ")}, in order). Hover for values.</p>
      </Card>
      <Card>
        <Label>Taste themes (creative-angle evidence)</Label>
        <div className="mt-3 flex flex-wrap gap-2">
          {a.tags.slice(0, 16).map((t) => (
            <span key={t.name} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-sm">
              {t.name} <FactChips ids={t.factIds} title={`Tag: ${t.name}`} max={1} />
            </span>
          ))}
        </div>
      </Card>
      <Advanced result={result} />
    </section>
  );
}

function Advanced({ result }: { result: RunResult }) {
  const t = THRESHOLDS;
  return (
    <details className="rounded-2xl border border-line bg-surface p-5 text-sm">
      <summary className="cursor-pointer font-semibold">Advanced: how scores are computed</summary>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <div>
          <Label>Partner score</Label>
          <p className="mt-1 font-mono text-xs">score = (1/|C|) · Σ w_c · affinity_c − λ · popularity</p>
          <p className="mt-1 text-muted">A comp with no signal for a partner contributes zero, so partners loved by every comp rank above partners loved by one.</p>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {result.comps.map((c) => (
                <tr key={c.entityId} className="border-t border-line">
                  <td className="py-1">w · {c.name}</td>
                  <td className="py-1 text-right font-mono">1</td>
                </tr>
              ))}
              <tr className="border-t border-line">
                <td className="py-1">λ popularity penalty</td>
                <td className="py-1 text-right font-mono">{t.popularityLambda}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <Label>Market score</Label>
          <p className="mt-1 font-mono text-xs">score = mean over comps of heatmap percentile</p>
          <p className="mt-1 text-muted">Each comp&apos;s cities are ranked against each other first, so one comp with high raw values cannot dominate.</p>
          <Label>
            <span className="mt-4 block">Thresholds (provisional until the live API test)</span>
          </Label>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {[
                ["Affinity floor for a signal", t.affinityFloor],
                ["Strong, specific affinity", t.strongAffinity],
                ["Min. strong results per domain", t.minItemsPerDomain],
                ["Theme share at which comps count as one audience", t.sharedThemes],
                ["Max. shared partners+markets between concepts", t.maxConceptSimilarity],
                ["Validator drop share that triggers a rewrite", t.maxDroppedShare],
              ].map(([k, v]) => (
                <tr key={String(k)} className="border-t border-line">
                  <td className="py-1">{k}</td>
                  <td className="py-1 text-right font-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">
        Confidence: high when most items are backed by three or more comps (or one strong, specific signal); medium when backed by at least one comp above the floor; low
        otherwise or when a recovery fallback was needed.
      </p>
    </details>
  );
}

function WithoutQloo({ result }: { result: RunResult }) {
  const [state, setState] = useState<{ loading: boolean; data?: BaselineResult; error?: string }>({ loading: false });
  const load = async () => {
    setState({ loading: true });
    // The run goes along too: on a multi-instance host the server that planned it may not get this request.
    const { runId, mode, brief, comps, facts } = result;
    const r = await fetch("/api/baseline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, run: { runId, mode, brief, comps, facts } }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setState(r?.ok ? { loading: false, data: j } : { loading: false, error: j.error ?? "Could not reach the server. Please try again." });
  };
  const d = state.data;
  return (
    <section>
      <Card>
        <Label>Same brief, same model, no Qloo</Label>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          We give the language model the identical brief and comps without any Qloo tools, then fact-check every partner it names against Qloo using the same code as
          Crossover.
        </p>
        {(!d || d.error) && (
          <Button className="mt-4" onClick={load} disabled={state.loading}>
            {state.loading ? "Asking the model alone…" : state.error || d?.error ? "Try again" : "Show without Qloo"}
          </Button>
        )}
        {(state.error || d?.error) && <p className="mt-3 text-sm text-warn">{state.error ?? d?.error}</p>}
        {d?.note && <p className="mt-3 text-sm text-warn">{d.note}</p>}
        {d?.llmUsage && d.llmUsage.calls > 0 && (
          <p className="mt-3 text-xs text-muted">
            Model call: {d.llmUsage.models.join(", ")} · {formatUsage(d.llmUsage)}
          </p>
        )}
      </Card>
      {d && !d.error && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <Label>Partners that resolve in Qloo</Label>
              <div className="mt-1 text-3xl font-semibold">{Math.round(d.verifiability * 100)}%</div>
              <p className="text-xs text-muted">of {d.checks.length} partners named by the model alone</p>
            </Card>
            <Card>
              <Label>With measured affinity to these comps&apos; audiences</Label>
              <div className="mt-1 text-3xl font-semibold">{Math.round(d.grounding * 100)}%</div>
              <p className="text-xs text-muted">appear in Crossover&apos;s Qloo evidence for this run</p>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {d.concepts.map((c, i) => (
              <Card key={i}>
                <h3 className="font-semibold">{c.name}</h3>
                <div className="mt-2 text-sm text-muted">{c.markets.join(", ")}</div>
                <ul className="mt-2 space-y-1 text-sm">
                  {c.partners.map((p) => {
                    const chk = d.checks.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
                    return (
                      <li key={p.name} className="flex justify-between gap-2">
                        <span>
                          {p.name} <span className="text-xs text-muted">{DOMAIN_LABEL[p.domain as Domain] ?? p.domain}</span>
                        </span>
                        {chk?.inCrossoverEvidence ? <Badge tone="evidence">in evidence</Badge> : chk?.resolved ? <Badge>no affinity found</Badge> : <Badge tone="warn">not in Qloo</Badge>}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-sm italic text-muted">{c.angle}</p>
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted">
            “No affinity found” means the partner exists in Qloo but did not appear among these comps&apos; audience affinities in this run. Markets from the model
            alone have no fan-concentration evidence.
          </p>
        </div>
      )}
    </section>
  );
}

function briefText(result: RunResult) {
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId)!;
  const d = result.decision;
  return [
    `CROSSOVER DECISION BRIEF — "${result.brief.title}"`,
    `Comps: ${result.comps.map((c) => c.name).join(", ")}`,
    ``,
    `RECOMMENDATION: ${rec.name} (${LEVER_LABEL[rec.lever]}, ${rec.confidence} confidence)`,
    `Markets: ${rec.markets.map((m) => m.name).join(", ")}`,
    `Partners: ${rec.partners.map((p) => p.name).join(", ")}`,
    `Creative angle: ${rec.creativeAngle.text}`,
    ``,
    `WHY (evidence)`,
    ...d.rationale.map((r) => `- ${r.text} [${r.factIds.join(", ")}]`),
    ``,
    `TRADE-OFFS`,
    ...d.tradeoffs.map((t) => `- ${t}`),
    ``,
    `HYPOTHESES TO TEST BEFORE SPENDING`,
    ...rec.hypotheses.map((h) => `- ${h}`),
    ...d.testChecklist.map((t) => `[ ] ${t}`),
    ``,
    d.disclaimer,
  ].join("\n");
}

function BriefView({ result }: { result: RunResult }) {
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId)!;
  const d = result.decision;
  const [copied, setCopied] = useState(false);
  return (
    <article className="mx-auto max-w-3xl rounded-2xl border border-line bg-surface p-6 sm:p-10 print:border-0 print:p-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Label>Decision brief</Label>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">“{result.brief.title}”</h2>
          <div className="mt-1 text-sm text-muted">
            Comps: {result.comps.map((c) => c.name).join(", ")} · {result.brief.regions.join(", ")} · budget {result.brief.budget}
          </div>
        </div>
        <div className="flex gap-2 print:hidden">
          <Button variant="ghost" onClick={() => window.print()}>
            Print / PDF
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              await navigator.clipboard?.writeText(briefText(result));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy as text"}
          </Button>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <ModeBanner result={result} />
        {d.writtenBy === "template" && <Badge tone="warn">Generated without the writing model</Badge>}
        {d.droppedSentences > 0 && <Badge>{d.droppedSentences} uncited sentence(s) removed by the validator</Badge>}
      </div>
      <section className="mt-6">
        <Label>Recommendation</Label>
        <h3 className="mt-1 text-xl font-semibold">
          {rec.name} <span className="text-sm font-normal text-muted">· {LEVER_LABEL[rec.lever]} · {rec.confidence} confidence</span>
        </h3>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[120px_1fr]">
          <dt className="text-muted">Markets</dt>
          <dd>{rec.markets.map((m) => m.name).join(", ") || "No location signal"}</dd>
          <dt className="text-muted">Partners</dt>
          <dd>{rec.partners.map((p) => p.name).join(", ")}</dd>
          <dt className="text-muted">Creative angle</dt>
          <dd>{rec.creativeAngle.text}</dd>
        </dl>
      </section>
      <section className="mt-6">
        <Label>Why — evidence and interpretation</Label>
        <ul className="mt-2 space-y-2 text-sm">
          {d.rationale.map((r, i) => (
            <li key={i}>
              {r.text} <FactChips ids={r.factIds} max={3} />
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-6">
        <Label>Trade-offs</Label>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {d.tradeoffs.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      </section>
      <section className="mt-6 rounded-xl bg-hyp-bg p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-hyp">Hypotheses — test before you spend</div>
        <ul className="mt-2 space-y-1 text-sm italic text-hyp">
          {rec.hypotheses.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        <ul className="mt-3 space-y-1 text-sm">
          {d.testChecklist.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden>☐</span>
              {t}
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-6 border-t border-line pt-4 text-xs text-muted">{d.disclaimer}</p>
    </article>
  );
}

function Trace({ result }: { result: RunResult }) {
  const [filter, setFilter] = useState<"all" | "decisions" | "qloo">("decisions");
  const rows = result.trace.filter((t) => filter === "all" || (filter === "qloo" ? t.kind === "qloo" : t.kind !== "qloo"));
  return (
    <section>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {(["decisions", "qloo", "all"] as const).map((f) => (
          <Button key={f} variant={filter === f ? "primary" : "ghost"} onClick={() => setFilter(f)}>
            {f === "decisions" ? "Agent decisions" : f === "qloo" ? `Qloo requests (${result.trace.filter((t) => t.kind === "qloo").length})` : "Everything"}
          </Button>
        ))}
      </div>
      <ol className="mt-4 space-y-1 font-mono text-xs">
        {rows.map((t, i) => (
          <li key={i} className="flex gap-3 rounded-lg px-2 py-1 hover:bg-surface-2">
            <span className="w-20 shrink-0 text-muted">{new Date(t.at).toLocaleTimeString()}</span>
            <span className={cx("w-20 shrink-0 uppercase", t.kind === "validator" || t.kind === "error" || t.kind === "limit" ? "text-warn" : t.kind === "decision" || t.kind === "plan" ? "text-accent" : "text-evidence")}>
              {t.kind}
            </span>
            <span className="break-words">{t.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
