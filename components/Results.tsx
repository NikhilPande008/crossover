"use client";

import { useMemo, useState } from "react";
import type { AudienceMap as AudienceMapT, BaselineResult, Comp, Concept, Domain, Format, Overlap, RankedPartner, RunResult, TestType } from "@/lib/types";
import type { Preset } from "@/lib/presets";
import { diffRuns } from "@/lib/diff";
import { THRESHOLDS } from "@/lib/thresholds";
import { formatUsage } from "@/lib/llm/usage";
import { Badge, Button, Card, CONFIDENCE_TONE, Label, cx } from "./ui";
import { EvidenceProvider, FactChips, useEvidence } from "./Evidence";
import { CompOrbit, LiftStrip, MarketMap, MarketQuadrant } from "./Viz";
import { liftPoints, referenceLabel } from "@/lib/labels";

type Refinements = { excludedPartners: string[]; pinnedMarkets: string[] };

const TABS = ["Concepts", "Audience map", "Without Qloo", "Decision brief", "Agent trace"] as const;
type Tab = (typeof TABS)[number];

const DOMAIN_LABEL: Record<Domain, string> = { podcast: "Podcasts", artist: "Artists", tv_show: "TV", movie: "Films", book: "Books", brand: "Brands" };
const LEVER_LABEL = { market: "Market-led", partner: "Partner-led", crossover: "Expansion" };
/** Match the server's limits on refinements (lib/validate/input.ts). */
const MAX_PINS = 5;
const MAX_EXCLUDED = 20;

const TEST_LABEL: Record<TestType, string> = {
  geo_ab: "Market A/B",
  podcast_host_read: "Podcast host read",
  artist_social_collab: "Artist collab",
  screen_cross_promo: "Screen cross-promo",
  brand_copromo: "Brand co-promo",
  creative_ab: "Creative A/B",
};

const compName = (comps: Comp[], id: string) => comps.find((c) => c.entityId === id)?.name ?? id;

/** The ranked-partner row behind a plan partner (for its measured lift), by name and domain. */
function rankedPartner(audience: AudienceMapT, name: string, domain: string): RankedPartner | undefined {
  const key = name.toLowerCase();
  return (audience.partners[domain as Domain] ?? []).find((p) => p.name.toLowerCase() === key);
}

function LiftBadge({ lift, format }: { lift?: number; format: Format }) {
  if (lift === undefined) return null;
  return (
    <span title={`Qloo affinity for these comps' fans minus affinity for ${referenceLabel(format)}, in points`}>
      <Badge tone={lift > 0 ? "evidence" : "warn"}>{liftPoints(lift)} vs typical</Badge>
    </span>
  );
}

function verdictLabel(o: Overlap): string {
  if (o.verdict === "one") return "one audience";
  if (o.verdict === "adjacent") return "adjacent audiences";
  return "different audiences";
}

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
  /** Shared brief link: no swaps, refinements or exclusions. */
  readOnly?: boolean;
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

function ShareButton({ runId }: { runId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      variant="quiet"
      onClick={async () => {
        const url = `${window.location.origin}/r/${runId}`;
        const ok = await navigator.clipboard?.writeText(url).then(
          () => true,
          () => false,
        );
        setState(ok ? "copied" : "failed");
        if (!ok) window.prompt("Copy this link", url);
        setTimeout(() => setState("idle"), 2000);
      }}
      title="Read-only link to this brief, kept for 30 days"
    >
      {state === "copied" ? "Link copied" : "Share link"}
    </Button>
  );
}

function RunHeader({ result, busy, steps, preset, refinements, onRefine, onSwap, readOnly }: Parameters<typeof Results>[0]) {
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
        {readOnly ? <Badge>Shared brief · read-only</Badge> : <ShareButton runId={result.runId} />}
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
        {!readOnly && (
          <Button variant="quiet" onClick={() => setShowSwap((s) => !s)} disabled={busy}>
            Swap comp
          </Button>
        )}
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
      {!readOnly && (refinements.excludedPartners.length > 0 || refinements.pinnedMarkets.length > 0) && (
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
 * The core decision in one line: which comp to lead with (the comp audit), which comps to bridge
 * to (one or adjacent audience with the lead) and which is a stretch (a different audience).
 * Falls back to the recommended concept's lead comps when the run has no comp audit.
 */
function LeadLine({ result }: { result: RunResult }) {
  const { facts } = useEvidence();
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId);
  if (!rec) return null;
  const name = (id: string) => compName(result.comps, id);
  const advice = result.audience.advice;
  const pairs = result.audience.overlaps;
  const measured = pairs.some((o) => o.mutualLift !== undefined);
  const evidence = pairs.flatMap((o) => o.factIds).filter((id) => (measured ? facts.get(id)?.kind === "cross" : facts.get(id)?.kind === "compare"));
  if (advice) {
    const verdictWithLead = (id: string) => pairs.find((o) => (o.a === advice.lead && o.b === id) || (o.b === advice.lead && o.a === id))?.verdict;
    const others = result.comps.filter((c) => c.entityId !== advice.lead && c.entityId !== advice.drop?.compId);
    const bridge = others.filter((c) => verdictWithLead(c.entityId) !== "different");
    const stretch = others.filter((c) => verdictWithLead(c.entityId) === "different");
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Badge tone="accent">Lead with</Badge>
        <b>{name(advice.lead)}</b>
        <span className="text-muted">
          {[
            bridge.length > 0 && `bridge to ${bridge.map((c) => c.name).join(" and ")}`,
            stretch.length > 0 && `${stretch.map((c) => c.name).join(" and ")} ${stretch.length === 1 ? "is the stretch" : "are stretches"}`,
            advice.drop && `consider dropping ${name(advice.drop.compId)}`,
            advice.add && `consider adding ${advice.add.name}`,
            `${LEVER_LABEL[rec.lever].toLowerCase()} concept recommended`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {evidence.length > 0 && <FactChips ids={evidence} title="One audience or two?" max={1} />}
      </div>
    );
  }
  const shared = pairs.filter((o) => o.similar).length;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <Badge tone="accent">Lead with</Badge>
      <b>{rec.leadComps.map(name).join(" + ")}</b>
      <span className="text-muted">
        · {LEVER_LABEL[rec.lever].toLowerCase()} concept
        {pairs.length > 0 && ` · ${shared} of ${pairs.length} comp pair${pairs.length === 1 ? "" : "s"} share an audience (${measured ? "Qloo cross-affinity" : "Qloo theme overlap"})`}
      </span>
      {evidence.length > 0 && <FactChips ids={evidence} title="One audience or two?" max={1} />}
    </div>
  );
}

/** Comp audit: the lead comp and why, a title to add and a comp to drop, and any comp weights. */
function AdviceCard({ result }: { result: RunResult }) {
  const advice = result.audience.advice;
  const weights = result.audience.weights;
  if (!advice && !weights) return null;
  const name = (id: string) => compName(result.comps, id);
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <Label>Comp audit</Label>
        {advice && <Badge>{advice.by === "agent" ? "agent decision, checked against Qloo" : "computed from Qloo cross-affinity"}</Badge>}
      </div>
      <ul className="mt-2 space-y-1.5 text-sm">
        {advice && (
          <li>
            <b>Lead with {name(advice.lead)}.</b> <span className="text-muted">{advice.leadReason}</span>
          </li>
        )}
        {advice?.drop && (
          <li>
            <Badge tone="warn">weak anchor</Badge> <b>{name(advice.drop.compId)}</b> <span className="text-muted">{advice.drop.reason}</span> <FactChips ids={advice.drop.factIds} title={`${name(advice.drop.compId)}: weak anchor`} max={1} />
          </li>
        )}
        {advice?.add && (
          <li>
            <Badge tone="evidence">suggested comp</Badge> <b>{advice.add.name}</b> <span className="text-muted">{advice.add.reason}</span> <FactChips ids={advice.add.factIds} title={`${advice.add.name}: fans also love`} max={1} />
          </li>
        )}
        {weights && (
          <li className="text-muted">
            Comp weights set by the agent:{" "}
            {Object.entries(weights)
              .map(([id, w]) => `${name(id)} ×${w}`)
              .join(", ")}
          </li>
        )}
      </ul>
    </Card>
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
                  <FactChips ids={a.factIds} title={a.name} max={1} />
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

function Concepts({ result, refinements, onRefine, onRelax, busy, readOnly }: Parameters<typeof Results>[0]) {
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId);
  return (
    <section>
      {!readOnly && <ConstraintNotice result={result} onRelax={onRelax} busy={busy} />}
      <AdviceCard result={result} />
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
              readOnly={readOnly}
              onExclude={!readOnly && refinements.excludedPartners.length < MAX_EXCLUDED ? (name) => onRefine({ ...refinements, excludedPartners: [...refinements.excludedPartners, name] }) : undefined}
            />
          ))}
      </div>
      {result.decision.whyNotOthers.length > 0 && (
        <Card className="mt-4">
          <Label>Why not the others</Label>
          <ul className="mt-2 space-y-1 text-sm">
            {result.decision.whyNotOthers.map((w, i) => (
              <li key={i}>
                {w.text} <FactChips ids={w.factIds} max={1} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">{result.decision.disclaimer}</p>
    </section>
  );
}

function ConceptCard({
  c,
  result,
  recommended,
  onExclude,
  busy,
  readOnly,
}: {
  c: Concept;
  result: RunResult;
  recommended: boolean;
  onExclude?: (name: string) => void;
  busy: boolean;
  readOnly?: boolean;
}) {
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
                {!readOnly && (
                  <button
                    className="whitespace-nowrap text-xs text-muted sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 hover:text-warn disabled:cursor-not-allowed"
                    disabled={busy || !onExclude}
                    onClick={() => onExclude?.(p.name)}
                    title={onExclude ? "Exclude and re-plan" : `Up to ${MAX_EXCLUDED} excluded partners`}
                  >
                    Not a fit
                  </button>
                )}
                <LiftBadge lift={rankedPartner(result.audience, p.name, p.domain)?.lift} format={result.brief.format} />
                <FactChips ids={p.factIds} title={`${p.name}: audience affinity`} max={1} />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <Label>Creative angle</Label>
        <p className="mt-1 text-sm">
          {c.creativeAngle.text} <FactChips ids={c.creativeAngle.factIds} title="Creative angle evidence" max={1} />
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

function AudienceMap({ result, previous, refinements, onRefine, busy, readOnly }: Parameters<typeof Results>[0]) {
  const a = result.audience;
  const name = (id: string) => compName(result.comps, id);
  const domains = (Object.keys(a.partners) as Domain[]).filter((d) => a.partners[d].length);
  const ref = referenceLabel(result.brief.format);
  const measuredMarkets = a.markets.some((m) => m.overIndex !== undefined);
  return (
    <section className="space-y-6">
      {a.gaps.length > 0 && (
        <div className="rounded-xl bg-warn-bg px-4 py-3 text-sm text-warn">
          <b>Evidence gaps:</b> {a.gaps.join("; ")}
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label>Where fans concentrate</Label>
          <span className="text-xs text-muted">
            Dot size: market score. {measuredMarkets ? `Faded: no more concentrated than for ${ref}.` : ""} {previous ? "Dashed rings: before the last change." : ""}
          </span>
        </div>
        <div className="mt-3 grid gap-6 lg:grid-cols-[1fr_minmax(0,22rem)]">
          <MarketMap markets={a.markets} previous={previous?.audience.markets} countries={result.brief.regions} />
          <ol className="space-y-1.5 text-sm">
            {a.markets.slice(0, 12).map((m, i) => (
              <li key={m.name} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  <span className="mr-1 font-mono text-xs text-muted">{i + 1}</span>
                  {m.name} <span className="text-xs text-muted">{m.country}</span>
                  {m.broad && (
                    <span title="Over-indexes for every comp: possibly how Qloo's sample is spread rather than this audience. Check before spending.">
                      {" "}
                      <Badge tone="warn">broad</Badge>
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  {m.overIndex !== undefined ? (
                    <span className={cx("font-mono text-xs", m.overIndex > 0 ? "text-evidence" : "text-muted")} title={`Concentration percentile minus ${ref}'s percentile for this city`}>
                      {liftPoints(m.overIndex)}
                    </span>
                  ) : (
                    <Bar value={m.score} tone="accent" />
                  )}
                  {!readOnly && (
                    <button
                      className={cx("text-xs disabled:cursor-not-allowed", refinements.pinnedMarkets.includes(m.name) ? "text-accent" : "text-muted hover:text-ink")}
                      disabled={busy || refinements.pinnedMarkets.includes(m.name) || refinements.pinnedMarkets.length >= MAX_PINS}
                      onClick={() => onRefine({ ...refinements, pinnedMarkets: [...refinements.pinnedMarkets, m.name] })}
                      title={refinements.pinnedMarkets.length >= MAX_PINS && !refinements.pinnedMarkets.includes(m.name) ? `Up to ${MAX_PINS} pinned markets` : "Pin this market into every concept"}
                    >
                      {refinements.pinnedMarkets.includes(m.name) ? "Pinned" : "Pin"}
                    </button>
                  )}
                  <FactChips ids={m.factIds} title={`${m.name}: fan concentration`} max={1} />
                </span>
              </li>
            ))}
            {!a.markets.length && <li className="text-muted">No location signal for these comps</li>}
          </ol>
        </div>
        {measuredMarkets && a.markets.some((m) => m.population) && (
          <div className="mt-5 grid gap-4 border-t border-line pt-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
            <MarketQuadrant markets={a.markets} />
            <p className="text-xs text-muted">
              Over-index is how much more these comps&apos; fans concentrate in a city than {ref}&apos;s do (percentile points, ranked within each country). Metro size is a
              static census estimate. <b className="text-ink">Efficient</b> cities over-index but are small: cheap places to test. <b className="text-ink">Scale</b> cities
              over-index and are large: where to expand once a test works.
            </p>
          </div>
        )}
      </Card>
      {(result.brief.format === "special" || result.brief.format === "tour") && <TourCities result={result} />}
      <Card>
        <Label>One audience or two?</Label>
        <p className="mt-1 text-xs text-muted">
          {a.overlaps.some((o) => o.mutualLift !== undefined)
            ? `Each comp is scored inside the other comp's audience and inside ${ref}'s; the verdict uses the smaller lift. One audience at ${liftPoints(THRESHOLDS.oneAudienceLift)} points or more, adjacent from ${liftPoints(THRESHOLDS.adjacentLift)}, otherwise different. Control titles show what no shared audience looks like.`
            : "The verdict uses the share of themes the two titles have in common in Qloo's compare analysis."}
        </p>
        <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,18rem)_1fr]">
          <CompOrbit comps={result.comps} overlaps={a.overlaps} />
          <div className="space-y-4">
            {a.overlaps.map((o) => (
              <div key={o.a + o.b}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <b>{name(o.a)}</b> vs <b>{name(o.b)}</b>
                  <Badge tone={o.verdict === "one" ? "evidence" : o.verdict === "adjacent" ? "neutral" : "warn"}>{verdictLabel(o)}</Badge>
                  {o.mutualLift === undefined && (
                    <span className="font-mono text-xs" title={`${o.themesCompared} distinct themes compared`}>
                      {Math.round(o.themeShare * 100)}% of themes shared
                    </span>
                  )}
                  {o.source === "estimated-from-tags" && o.mutualLift === undefined && <Badge>estimated from taste tags</Badge>}
                  <FactChips ids={o.factIds} title={`${name(o.a)} vs ${name(o.b)}`} max={1} />
                </div>
                {o.mutualLift !== undefined && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted">
                    <li>
                      {name(o.b)} inside {name(o.a)}&apos;s audience: <b className="text-ink">{liftPoints(o.liftBinA!)}</b> points vs {ref}
                      {o.rankBinA ? ` · #${o.rankBinA} title ${name(o.a)} fans love` : ""}
                    </li>
                    <li>
                      {name(o.a)} inside {name(o.b)}&apos;s audience: <b className="text-ink">{liftPoints(o.liftAinB!)}</b> points
                      {o.rankAinB ? ` · #${o.rankAinB} title ${name(o.b)} fans love` : ""}
                    </li>
                    {o.controls && o.controls.length > 0 && (
                      <li className="opacity-70">
                        Controls:{" "}
                        {o.controls
                          .map((c) => `${c.name} ${c.liftInA !== undefined ? liftPoints(c.liftInA) : "?"} / ${c.liftInB !== undefined ? liftPoints(c.liftInB) : "?"}`)
                          .join("; ")}
                      </li>
                    )}
                  </ul>
                )}
                {o.sharedAudience.length > 0 && (
                  <div className="mt-1 text-xs text-muted">
                    <span className="font-semibold text-ink">Both audiences rank highly:</span> {o.sharedAudience.join(", ")}
                  </div>
                )}
                {o.shared.length > 0 && (
                  <div className="mt-1 text-xs text-muted">
                    <span className="font-semibold text-ink">Shared themes{o.source === "estimated-from-tags" ? " (from tags)" : ""}:</span> {o.shared.join(", ")}
                    {o.onlyA.length > 0 && (
                      <>
                        {" "}
                        · <span className="font-semibold text-ink">more {name(o.a)}:</span> {o.onlyA.join(", ")}
                      </>
                    )}
                    {o.onlyB.length > 0 && (
                      <>
                        {" "}
                        · <span className="font-semibold text-ink">more {name(o.b)}:</span> {o.onlyB.join(", ")}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
        <SharedVsUnique result={result} />
        <Demographics result={result} />
      </Card>
      <Card>
        <Label>What they love across domains</Label>
        <div className="mt-3 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {domains.map((d) => (
            <div key={d} className="min-w-0">
              <div className="text-sm font-semibold">{DOMAIN_LABEL[d]}</div>
              <ul className="mt-2 space-y-1.5 text-sm">
                {a.partners[d].slice(0, 6).map((p) => (
                  <li key={p.name} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate" title={p.source === "model" ? `${p.name} (suggested by the agent, measured in Qloo)` : p.name}>
                      {p.name}
                      {p.source === "model" && <span className="text-xs text-muted"> · agent idea</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {p.lift !== undefined ? (
                        <span className={cx("font-mono text-xs", p.lift > 0 ? "text-evidence" : "text-warn")} title={`${p.combined} for these fans, ${p.baseline} for ${ref}`}>
                          {liftPoints(p.lift)}
                        </span>
                      ) : (
                        <span className="flex gap-0.5" title={result.comps.map((c) => `${c.name}: ${p.perComp[c.entityId] ?? "no signal"}`).join("\n")}>
                          {result.comps.map((c) => (
                            <span key={c.entityId} className="inline-block h-3 w-1.5 rounded-sm bg-evidence" style={{ opacity: Math.max(0.12, p.perComp[c.entityId] ?? 0) }} />
                          ))}
                        </span>
                      )}
                      <FactChips ids={p.factIds} title={`${p.name}: audience affinity`} max={1} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          {domains.some((d) => a.partners[d].some((p) => p.lift !== undefined))
            ? `Numbers are lift: Qloo affinity for these comps' fans minus affinity for ${ref}, in points. Partners these fans like no more than everyone else are listed below, not used.`
            : `Bars show each comp's affinity (${result.comps.map((c) => c.name).join(", ")}, in order). Hover for values.`}
        </p>
        <GenericRail result={result} />
      </Card>
      <Card>
        <Label>Taste themes (creative-angle evidence)</Label>
        <div className="mt-3 flex flex-wrap gap-2">
          {a.tags.slice(0, 16).map((t) => {
            const support = result.comps.filter((c) => t.perComp[c.entityId] !== undefined).length;
            return (
              <span key={t.name} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-sm" title={`Supported by ${support} of ${result.comps.length} comps`}>
                {t.name} <span className="text-xs text-muted">{support}/{result.comps.length}</span> <FactChips ids={t.factIds} title={`Tag: ${t.name}`} max={1} />
              </span>
            );
          })}
        </div>
      </Card>
      <Advanced result={result} />
    </section>
  );
}

/** Partners left out because these fans like them no more than a typical audience does. */
function GenericRail({ result }: { result: RunResult }) {
  const generic = result.audience.generic ?? [];
  if (!generic.length) return null;
  const ref = referenceLabel(result.brief.format);
  return (
    <details className="mt-4 rounded-xl border border-line px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">
        Generic for any audience ({generic.length}) <span className="font-normal text-muted">· loved here, and just as much by {ref}</span>
      </summary>
      <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {generic.slice(0, 20).map((p) => (
          <li key={p.domain + p.name} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              {p.name} <span className="text-xs text-muted">{DOMAIN_LABEL[p.domain]}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted">
              <span className="font-mono">
                {p.combined?.toFixed(3)} here, {p.baseline?.toFixed(3)} for {ref}
              </span>
              <FactChips ids={p.factIds} title={`${p.name}: these fans vs ${ref}`} max={1} />
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Of the measured partners, how many each comp's fans love, and how many both or all do. */
function SharedVsUnique({ result }: { result: RunResult }) {
  const all = Object.values(result.audience.partners).flat();
  const comps = result.comps;
  if (all.length < 4 || comps.length < 2) return null;
  const STRONG = THRESHOLDS.affinityFloor;
  const strongFor = (p: RankedPartner) => comps.filter((c) => (p.perComp[c.entityId] ?? 0) >= STRONG).map((c) => c.entityId);
  const rows = all.map((p) => strongFor(p));
  const allComps = rows.filter((r) => r.length === comps.length).length;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <Label>Shared vs unique partners</Label>
      <p className="mt-1 text-xs text-muted">
        Of {all.length} measured partners, <b className="text-ink">{allComps}</b> are in every comp&apos;s own top results (affinity ≥ {STRONG}).
      </p>
      <div className="mt-2 space-y-1">
        {comps.map((c) => {
          const mine = rows.filter((r) => r.includes(c.entityId));
          const shared = mine.filter((r) => r.length > 1).length;
          const unique = mine.length - shared;
          const total = all.length || 1;
          return (
            <div key={c.entityId} className="flex items-center gap-2 text-xs">
              <span className="w-32 truncate">{c.name}</span>
              <span className="flex h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                <span className="bg-evidence" style={{ width: `${(shared / total) * 100}%` }} title={`${shared} shared with another comp`} />
                <span className="bg-accent opacity-60" style={{ width: `${(unique / total) * 100}%` }} title={`${unique} only for ${c.name}`} />
              </span>
              <span className="w-36 whitespace-nowrap text-right font-mono text-muted">
                {shared} shared · {unique} own
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const AGE_ORDER = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"];
const AGE_SHORT: Record<string, string> = { "24_and_younger": "≤24", "25_to_29": "25–29", "30_to_34": "30–34", "35_to_44": "35–44", "45_to_54": "45–54", "55_and_older": "55+" };

/** Age indexes are relative (over/under the average Qloo user), so they are drawn as diverging bars. */
function Demographics({ result }: { result: RunResult }) {
  const { facts } = useEvidence();
  const a = result.audience;
  if (!a.demographics.length) return null;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <Label>Audience skew (aggregate index, not shares)</Label>
      <ul className="mt-2 space-y-3 text-sm">
        {a.demographics.map((d) => {
          const age = d.factIds.map((id) => facts.get(id)).find((f) => f?.subject?.type === "age");
          const idx = AGE_ORDER.map((k) => ({ k, v: Number(age?.detail?.[k]) })).filter((x) => Number.isFinite(x.v));
          const max = Math.max(0.05, ...idx.map((x) => Math.abs(x.v)));
          return (
            <li key={d.compId}>
              <div>
                <b>{compName(result.comps, d.compId)}</b>: {d.summary} <FactChips ids={d.factIds} max={1} />
              </div>
              {idx.length > 0 && (
                <div className="mt-1 flex items-end gap-1" aria-label="Age index by bracket">
                  {idx.map(({ k, v }) => (
                    <div key={k} className="flex w-12 flex-col items-center text-[10px] text-muted" title={`${AGE_SHORT[k]}: index ${v > 0 ? "+" : ""}${v.toFixed(2)}`}>
                      <div className="relative h-8 w-full">
                        <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
                        <span
                          className={cx("absolute inset-x-2 rounded-sm", v >= 0 ? "bg-evidence" : "bg-warn")}
                          style={v >= 0 ? { bottom: "50%", height: `${(v / max) * 50}%` } : { top: "50%", height: `${(-v / max) * 50}%` }}
                        />
                      </div>
                      {AGE_SHORT[k]}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** For a comedy special or tour: where to premiere (large, over-indexing metros) and the tour routing. */
function TourCities({ result }: { result: RunResult }) {
  const ms = result.audience.markets.filter((m) => !m.broad);
  if (ms.length < 3) return null;
  const premiere = ms.filter((m) => (m.population ?? 0) >= 4 && (m.overIndex === undefined || m.overIndex > 0)).slice(0, 2);
  const tour = ms.slice(0, 12);
  return (
    <Card>
      <Label>Premiere screening &amp; tour cities</Label>
      <p className="mt-1 text-xs text-muted">From the comps&apos; fan concentration{ms.some((m) => m.overIndex !== undefined) ? " and over-index" : ""}; cities that over-index for every comp are left out until checked.</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-[14rem_1fr]">
        <div>
          <div className="text-sm font-semibold">Premiere in</div>
          <ul className="mt-1 text-sm">
            {(premiere.length ? premiere : ms.slice(0, 2)).map((m) => (
              <li key={m.name}>
                {m.name} {m.population ? <span className="text-xs text-muted">~{m.population}M</span> : null} <FactChips ids={m.factIds} title={`${m.name}: fan concentration`} max={1} />
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-sm font-semibold">{tour.length}-city tour, by fan score</div>
          <ol className="mt-1 gap-x-6 text-sm sm:columns-2">
            {tour.map((m, i) => (
              <li key={m.name}>
                <span className="mr-1 font-mono text-xs text-muted">{i + 1}</span>
                {m.name} <span className="text-xs text-muted">{m.country}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </Card>
  );
}

function Advanced({ result }: { result: RunResult }) {
  const t = THRESHOLDS;
  const w = result.audience.weights ?? {};
  return (
    <details className="rounded-2xl border border-line bg-surface p-5 text-sm">
      <summary className="cursor-pointer font-semibold">Advanced: how scores are computed</summary>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <div>
          <Label>Partner score</Label>
          <p className="mt-1 font-mono text-xs">score = affinity(comps&apos; fans) + κ · lift</p>
          <p className="mt-1 font-mono text-xs">lift = affinity(comps&apos; fans) − affinity({referenceLabel(result.brief.format)})</p>
          <p className="mt-1 text-muted">
            Candidates come from each comp&apos;s top results, a genre-tag signal and the agent&apos;s own suggestions; Qloo scores every candidate for both audiences
            (filter.results.entities). Partners with lift ≤ 0 are left out as generic. Without lift data the score is the weighted mean of per-comp affinity.
          </p>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {result.comps.map((c) => (
                <tr key={c.entityId} className="border-t border-line">
                  <td className="py-1">w · {c.name}</td>
                  <td className="py-1 text-right font-mono">{w[c.entityId] ?? 1}</td>
                </tr>
              ))}
              <tr className="border-t border-line">
                <td className="py-1">κ lift weight</td>
                <td className="py-1 text-right font-mono">{t.liftWeight}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <Label>Market score</Label>
          <p className="mt-1 font-mono text-xs">score = concentration + {t.marketLiftWeight} · over-index</p>
          <p className="mt-1 text-muted">
            Concentration is the mean heatmap percentile across comps, ranked within each country. Over-index subtracts the reference audience&apos;s percentile.
          </p>
          <Label>
            <span className="mt-4 block">Thresholds</span>
          </Label>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {[
                ["Affinity floor for a signal", t.affinityFloor],
                ["Strong, specific affinity", t.strongAffinity],
                ["Lift that counts as distinctive", t.distinctLift],
                ["Mutual lift for one audience", t.oneAudienceLift],
                ["Mutual lift for adjacent audiences", t.adjacentLift],
                ["Over-index that flags a city as broad", t.broadOverIndex],
                ["Theme share for one audience (fallback)", t.sharedThemes],
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
        Confidence: high when most items are backed by three or more comps, or by one strong or distinctive signal; medium when backed by at least one comp above the
        floor; low otherwise or when a recovery fallback was needed.
      </p>
    </details>
  );
}

function WithoutQloo({ result }: { result: RunResult }) {
  const [state, setState] = useState<{ loading: boolean; data?: BaselineResult; error?: string }>({ loading: false });
  const load = async () => {
    setState({ loading: true });
    // The run goes along too: on a multi-instance host the server that planned it may not get this request.
    const { runId, mode, brief, comps, facts, concepts, audience } = result;
    const run = { runId, mode, brief, comps, facts, concepts: concepts.map((c) => ({ partners: c.partners })), audience: { partners: audience.partners, markets: audience.markets } };
    const r = await fetch("/api/baseline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, run }) }).catch(() => null);
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
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <Label>Partners that resolve in Qloo</Label>
              <div className="mt-1 text-3xl font-semibold">{Math.round(d.verifiability * 100)}%</div>
              <p className="text-xs text-muted">of {d.checks.length} partners named by the model alone</p>
            </Card>
            {d.modelArm && d.crossoverArm && d.modelArm.scored > 0 ? (
              <>
                <Card>
                  <Label>Partners these fans like more than {referenceLabel(result.brief.format)}</Label>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-3xl font-semibold">
                      {d.crossoverArm.positive}/{d.crossoverArm.scored}
                    </span>
                    <span className="text-sm text-muted">
                      Crossover · model alone {d.modelArm.positive}/{d.modelArm.scored}
                    </span>
                  </div>
                  <p className="text-xs text-muted">positive lift, both arms scored by the same Qloo calls</p>
                </Card>
                <Card>
                  <Label>Median lift</Label>
                  <div className="mt-1 flex items-baseline gap-3">
                    <span className="text-3xl font-semibold">{d.crossoverArm.medianLift !== null ? liftPoints(d.crossoverArm.medianLift) : "—"}</span>
                    <span className="text-sm text-muted">Crossover · model alone {d.modelArm.medianLift !== null ? liftPoints(d.modelArm.medianLift) : "—"}</span>
                  </div>
                  <p className="text-xs text-muted">points of affinity above a typical audience</p>
                </Card>
              </>
            ) : (
              <Card>
                <Label>In Crossover&apos;s top results for these comps</Label>
                <div className="mt-1 text-3xl font-semibold">{Math.round(d.grounding * 100)}%</div>
                <p className="text-xs text-muted">of the model&apos;s partners; the rest were not scored in this check</p>
              </Card>
            )}
          </div>
          {d.modelArm && d.modelArm.scored > 0 && (
            <Card>
              <Label>Model guesses, Qloo measures</Label>
              <div className="mt-2">
                <LiftStrip
                  rows={[
                    { label: "Model alone", lifts: d.checks.map((c) => c.lift).filter((x): x is number => typeof x === "number") },
                    { label: "Crossover", lifts: crossoverLifts(result) },
                  ]}
                />
              </div>
              <p className="mt-1 text-xs text-muted">Each dot is a named partner; the line is the median. Good model ideas with positive lift also enter Crossover&apos;s own candidate pool.</p>
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            {d.concepts.map((c, i) => (
              <Card key={i}>
                <h3 className="font-semibold">{c.name}</h3>
                <div className="mt-2 text-sm text-muted">
                  {c.markets.map((m, j) => {
                    const pct = d.markets?.find((x) => x.name.toLowerCase() === m.toLowerCase())?.percentile;
                    return (
                      <span key={m}>
                        {j > 0 && ", "}
                        {m}
                        {pct !== undefined && <span className="font-mono text-xs" title="Fan-concentration percentile for these comps in this run">{` (${Math.round(pct * 100)}th pct)`}</span>}
                      </span>
                    );
                  })}
                </div>
                <ul className="mt-2 space-y-1 text-sm">
                  {c.partners.map((p) => {
                    const chk = d.checks.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
                    return (
                      <li key={p.name} className="flex justify-between gap-2">
                        <span>
                          {p.name} <span className="text-xs text-muted">{DOMAIN_LABEL[p.domain as Domain] ?? p.domain}</span>
                        </span>
                        {chk?.lift !== undefined ? (
                          <LiftBadge lift={chk.lift} format={result.brief.format} />
                        ) : chk?.inCrossoverEvidence ? (
                          <Badge tone="evidence">in our top results</Badge>
                        ) : chk?.resolved ? (
                          <Badge>not in our top results</Badge>
                        ) : (
                          <Badge tone="warn">not in Qloo</Badge>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-sm italic text-muted">{c.angle}</p>
              </Card>
            ))}
          </div>
          <p className="text-xs text-muted">
            “+N vs typical” is Qloo&apos;s affinity for these comps&apos; fans minus its affinity for a typical audience, in points, measured the same way for both arms.
            {d.modelArm && d.crossoverArm && d.modelArm.medianLift !== null && d.crossoverArm.medianLift !== null
              ? ` Median lift: model alone ${Math.round(d.modelArm.medianLift * 100)}, Crossover ${Math.round(d.crossoverArm.medianLift * 100)}; positive lift: ${d.modelArm.positive} of ${d.modelArm.scored} vs ${d.crossoverArm.positive} of ${d.crossoverArm.scored}.`
              : " “Not in our top results” means the partner exists in Qloo but was not among this run's top results; it was not scored."}
            {d.markets?.some((m) => m.percentile !== undefined) && " City percentiles are the comps' fan concentration from this run's heatmaps; cities without one are not in our map."}
          </p>
        </div>
      )}
    </section>
  );
}

/** Lift of every partner across Crossover's concepts (the arm the baseline check compares with). */
function crossoverLifts(result: RunResult): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const p of result.concepts.flatMap((c) => c.partners)) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const lift = rankedPartner(result.audience, p.name, p.domain)?.lift;
    if (lift !== undefined) out.push(lift);
  }
  return out;
}

function briefText(result: RunResult) {
  const rec = result.concepts.find((c) => c.id === result.decision.recommendedId)!;
  const d = result.decision;
  return [
    `CROSSOVER DECISION BRIEF — "${result.brief.title}"`,
    `Comps: ${result.comps.map((c) => c.name).join(", ")}`,
    ...(result.audience.advice ? [`Lead comp: ${compName(result.comps, result.audience.advice.lead)}. ${result.audience.advice.leadReason}`] : []),
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
    ...(d.tests?.length ? d.tests.map((t) => `[ ] ${TEST_LABEL[t.type]}: ${t.text}${t.why ? ` (${t.why})` : ""}`) : d.testChecklist.map((t) => `[ ] ${t}`)),
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
          <dd>
            {rec.partners.map((p, i) => {
              const lift = rankedPartner(result.audience, p.name, p.domain)?.lift;
              return (
                <span key={p.name}>
                  {i > 0 && ", "}
                  {p.name}
                  {lift !== undefined && <span className="font-mono text-xs text-muted"> ({liftPoints(lift)})</span>}
                </span>
              );
            })}
          </dd>
          {result.audience.advice && (
            <>
              <dt className="text-muted">Lead comp</dt>
              <dd>
                {compName(result.comps, result.audience.advice.lead)} <span className="text-muted">— {result.audience.advice.leadReason}</span>
              </dd>
            </>
          )}
          <dt className="text-muted">Creative angle</dt>
          <dd>{rec.creativeAngle.text}</dd>
        </dl>
      </section>
      <section className="mt-6">
        <Label>Why — evidence and interpretation</Label>
        <ul className="mt-2 space-y-2 text-sm">
          {d.rationale.map((r, i) => (
            <li key={i}>
              {r.text} <FactChips ids={r.factIds} max={1} />
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
        <ul className="mt-3 space-y-1.5 text-sm">
          {d.tests?.length
            ? d.tests.map((t, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden>☐</span>
                  <span>
                    <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{TEST_LABEL[t.type]}</span>
                    {t.text}
                    {t.why && <span className="block text-xs text-muted">{t.why}</span>}
                  </span>
                </li>
              ))
            : d.testChecklist.map((t, i) => (
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
            <span className={cx("w-20 shrink-0 uppercase", t.kind === "validator" || t.kind === "error" || t.kind === "limit" ? "text-warn" : t.kind === "decision" || t.kind === "plan" || t.kind === "critic" ? "text-accent" : "text-evidence")}>
              {t.kind}
            </span>
            <span className="break-words">{t.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * First results while concepts are still being written: the audience map arrives as soon as the
 * research is measured (an "audience" progress event). Rendered outside the evidence drawer.
 */
export function EarlyAudience({ audience, comps, format }: { audience: AudienceMapT; comps: Comp[]; format: Format }) {
  const top = (Object.keys(audience.partners) as Domain[])
    .flatMap((d) => audience.partners[d].slice(0, 2))
    .sort((a, b) => (b.lift ?? b.score) - (a.lift ?? a.score))
    .slice(0, 8);
  const name = (id: string) => compName(comps, id);
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Label>First results</Label>
        <span className="text-xs text-muted">The audience is measured; the concepts are being written.</span>
      </div>
      <div className="mt-3 grid items-center gap-5 md:grid-cols-[1fr_16rem]">
        <MarketMap markets={audience.markets} countries={[...new Set(audience.markets.map((m) => m.country))].filter(Boolean)} top={4} />
        <div className="space-y-3 text-sm">
          {audience.advice && (
            <div>
              <Badge tone="accent">Lead with</Badge> <b>{name(audience.advice.lead)}</b>
              {audience.advice.add && <div className="mt-1 text-xs text-muted">Suggested comp: {audience.advice.add.name}</div>}
              {audience.advice.drop && <div className="mt-1 text-xs text-muted">Weak anchor: {name(audience.advice.drop.compId)}</div>}
            </div>
          )}
          {audience.overlaps.length > 0 && (
            <ul className="space-y-0.5 text-xs">
              {audience.overlaps.map((o) => (
                <li key={o.a + o.b}>
                  {name(o.a)} / {name(o.b)}: <b>{verdictLabel(o)}</b>
                  {o.mutualLift !== undefined && <span className="text-muted"> ({liftPoints(o.mutualLift)})</span>}
                </li>
              ))}
            </ul>
          )}
          {top.length > 0 && (
            <div>
              <div className="text-xs font-semibold">Partners {top.some((p) => p.lift !== undefined) ? `by lift vs ${referenceLabel(format)}` : "so far"}</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {top.map((p) => (
                  <li key={p.domain + p.name} className="flex justify-between gap-2">
                    <span className="truncate">
                      {p.name} <span className="text-muted">{DOMAIN_LABEL[p.domain]}</span>
                    </span>
                    {p.lift !== undefined && <span className="font-mono text-evidence">{liftPoints(p.lift)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
