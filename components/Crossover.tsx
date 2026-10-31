"use client";

import { useEffect, useRef, useState } from "react";
import type { AudienceMap, Brief, Comp, RunResult, TraceEntry } from "@/lib/types";
import type { Candidate } from "@/lib/qloo/api";
import { PRESETS, type Preset } from "@/lib/presets";
import { isCloseMatch } from "@/lib/match";
import { Badge, Button, Card, Label, cx } from "./ui";
import { Results, EarlyAudience } from "./Results";
import { streamPlan } from "@/lib/client/stream";

type Resolution = { query: string; candidates: Candidate[] };
type Stage = "landing" | "brief" | "confirm" | "working" | "results";
type Refinements = { excludedPartners: string[]; pinnedMarkets: string[] };

const EMPTY_BRIEF: Brief = { title: "", format: "film", logline: "", comps: ["", ""], regions: ["US"], budget: "M", exclusions: [] };

export { streamPlan };

/** `suggest` marks autocomplete lookups, which the server caps separately from the confirm step. */
export async function resolveNames(names: string[], format: Brief["format"], suggest = false): Promise<{ mode: string; resolutions: Resolution[] } | { error: string }> {
  const res = await fetch("/api/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ comps: names, format, ...(suggest ? { suggest } : {}) }) });
  const j = await res.json();
  return res.ok ? j : { error: j.error ?? "Could not resolve comps" };
}

function toComp(c: Candidate): Comp {
  return { name: c.name, entityId: c.entityId, type: c.type, year: c.year, descriptor: c.descriptor, genres: c.genres };
}

export function Crossover() {
  const [stage, setStage] = useState<Stage>("landing");
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [resolutions, setResolutions] = useState<Resolution[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<{ message: string; calls: number }[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [early, setEarly] = useState<{ audience: AudienceMap; comps: Comp[] } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [previous, setPrevious] = useState<RunResult | null>(null);
  const [refinements, setRefinements] = useState<Refinements>({ excludedPartners: [], pinnedMarkets: [] });
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => setMode(h.mode))
      .catch(() => {});
  }, []);

  async function resolve(b: Brief) {
    setBusy(true);
    setError(null);
    const r = await resolveNames(b.comps.filter(Boolean), b.format);
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setResolutions(r.resolutions);
    const pre: Record<string, string> = {};
    for (const x of r.resolutions) {
      const exact = x.candidates.find((c) => c.name.toLowerCase() === x.query.toLowerCase()) ?? x.candidates[0];
      if (exact) pre[x.query] = exact.entityId;
    }
    setPicked(pre);
    setStage("confirm");
  }

  async function run(opts: { comps: Comp[]; brief: Brief; prior?: RunResult; refinements?: Refinements }) {
    setStage(opts.prior ? "results" : "working");
    setBusy(true);
    setError(null);
    setSteps([]);
    setTrace([]);
    setEarly(null);
    let got: RunResult | null = null;
    await streamPlan(
      {
        brief: opts.brief,
        comps: opts.comps,
        refinements: opts.refinements ?? refinements,
        priorRunId: opts.prior?.runId,
        presetId: preset && opts.brief.title === preset.brief.title ? preset.id : undefined,
      },
      (e) => {
        if (e.type === "step") setSteps((s) => [...s, { message: e.message, calls: e.calls }]);
        if (e.type === "trace") setTrace((t) => [...t, e.entry]);
        if (e.type === "audience") setEarly({ audience: e.audience, comps: e.comps });
        if (e.type === "error") setError(e.message);
        if (e.type === "result") got = e.result;
      },
    );
    setBusy(false);
    if (got) {
      setPrevious(opts.prior ?? null);
      setResult(got);
      setStage("results");
    } else if (!opts.prior) setStage("confirm");
  }

  const confirmedComps = resolutions
    .map((r) => r.candidates.find((c) => c.entityId === picked[r.query]))
    .filter((c): c is Candidate => !!c)
    .map(toComp);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
      <header className="flex items-center justify-between py-5 print:hidden">
        <button onClick={() => setStage("landing")} className="flex items-center gap-2 text-left">
          <Logo />
          <span className="text-lg font-semibold tracking-tight">Crossover</span>
        </button>
        <div className="flex items-center gap-2">
          {mode === "fixture" && <Badge tone="warn">Synthetic data — not Qloo</Badge>}
          {mode === "live" && <Badge tone="evidence">Live Qloo</Badge>}
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-line bg-warn-bg px-4 py-3 text-sm text-warn print:hidden">
          {error}
        </div>
      )}

      {stage === "landing" && (
        <Landing
          busy={busy}
          onPreset={(p) => {
            setPreset(p);
            setBrief(p.brief);
            setRefinements({ excludedPartners: [], pinnedMarkets: [] });
            resolve(p.brief);
          }}
          onCustom={() => {
            setPreset(null);
            setBrief(EMPTY_BRIEF);
            setStage("brief");
          }}
        />
      )}

      {stage === "brief" && <BriefForm brief={brief} setBrief={setBrief} busy={busy} onBack={() => setStage("landing")} onSubmit={() => resolve(brief)} />}

      {stage === "confirm" && (
        <Confirm
          brief={brief}
          resolutions={resolutions}
          picked={picked}
          setPicked={setPicked}
          busy={busy}
          onBack={() => setStage(preset ? "landing" : "brief")}
          onRun={() => {
            setRefinements({ excludedPartners: [], pinnedMarkets: [] });
            const exclusions = brief.exclusions.map((s) => s.trim()).filter(Boolean);
            run({ comps: confirmedComps, brief: { ...brief, exclusions, comps: confirmedComps.map((c) => c.name) }, refinements: { excludedPartners: [], pinnedMarkets: [] } });
          }}
          comps={confirmedComps}
        />
      )}

      {stage === "working" && <Working steps={steps} trace={trace} early={early} format={brief.format} />}

      {stage === "results" && result && (
        <Results
          result={result}
          previous={previous}
          busy={busy}
          steps={steps}
          preset={preset}
          refinements={refinements}
          onRefine={(r) => {
            setRefinements(r);
            run({ comps: result.comps, brief: result.brief, prior: result, refinements: r });
          }}
          onRelax={(constraint, kind) => {
            if (kind === "not-a-fit") {
              const r = { ...refinements, excludedPartners: refinements.excludedPartners.filter((x) => x !== constraint) };
              setRefinements(r);
              run({ comps: result.comps, brief: result.brief, prior: result, refinements: r });
            } else {
              run({ comps: result.comps, brief: { ...result.brief, exclusions: result.brief.exclusions.filter((x) => x !== constraint) }, prior: result });
            }
          }}
          onSwap={async (fromId, newName) => {
            setBusy(true);
            setError(null);
            const r = await resolveNames([newName], result.brief.format);
            if ("error" in r || !r.resolutions[0]?.candidates.length) {
              setBusy(false);
              setError(`We couldn't find "${newName}" in Qloo. Try the exact title.`);
              return;
            }
            const x = r.resolutions[0];
            const c = x.candidates.find((c) => c.name.toLowerCase() === newName.toLowerCase()) ?? x.candidates[0];
            // Same checks as the confirm step: never silently swap in a different title or a duplicate.
            if (!isCloseMatch(newName, c.name)) {
              setBusy(false);
              setError(`No close match for "${newName}" in Qloo (nearest: "${c.name}"). Try the exact title.`);
              return;
            }
            if (result.comps.some((k) => k.entityId === c.entityId && k.entityId !== fromId)) {
              setBusy(false);
              setError(`"${c.name}" is already one of the comps.`);
              return;
            }
            const comps = result.comps.map((k) => (k.entityId === fromId ? toComp(c) : k));
            await run({ comps, brief: { ...result.brief, comps: comps.map((k) => k.name) }, prior: result });
          }}
        />
      )}
    </div>
  );
}

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="10" cy="13" r="7.5" fill="none" stroke="var(--accent)" strokeWidth="2.2" />
      <circle cx="16" cy="13" r="7.5" fill="none" stroke="var(--evidence)" strokeWidth="2.2" />
    </svg>
  );
}

function Landing({ onPreset, onCustom, busy }: { onPreset: (p: Preset) => void; onCustom: () => void; busy: boolean }) {
  return (
    <section className="pt-8 sm:pt-14">
      <div className="max-w-3xl">
        <Label>For studio, streamer and label marketers</Label>
        <h1 className="mt-3 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">Find the audience your release can actually reach.</h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">
          Every campaign starts with one argument: is our release more like Comp A or Comp B? Crossover settles it with Qloo&apos;s taste graph — where the comps&apos;
          fans live, what else they love, and which comp to lead with — then builds three campaign concepts you can defend, with every claim linked to its evidence.
        </p>
      </div>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {PRESETS.map((p) => (
          <button key={p.id} disabled={busy} onClick={() => onPreset(p)} className="group text-left disabled:opacity-60">
            <Card className="h-full transition group-hover:border-accent">
              <Label>Preset</Label>
              <div className="mt-2 text-lg font-semibold">{p.label}</div>
              <div className="mt-1 text-sm text-muted">“{p.brief.title}” — {p.blurb}</div>
              <div className="mt-4 text-sm font-medium text-accent">{busy ? "Resolving comps…" : "Plan this release →"}</div>
            </Card>
          </button>
        ))}
      </div>
      <div className="mt-6">
        <Button variant="ghost" onClick={onCustom}>
          Plan my own release
        </Button>
      </div>
      <div className="mt-14 grid gap-6 text-sm text-muted sm:grid-cols-3">
        <div>
          <div className="font-semibold text-ink">Retrieved evidence</div>
          <p className="mt-1">Solid chips are values returned by Qloo. Click one to see the exact request.</p>
        </div>
        <div>
          <div className="font-semibold text-ink">Interpretation</div>
          <p className="mt-1">Plain text cites the facts it rests on. Uncited claims are removed by a validator before you see them.</p>
        </div>
        <div>
          <div className="font-semibold text-ink">
            <em>Hypothesis</em>
          </div>
          <p className="mt-1">Italic, labelled ideas that need a real-world test before you spend.</p>
        </div>
      </div>
    </section>
  );
}

function BriefForm({ brief, setBrief, busy, onBack, onSubmit }: { brief: Brief; setBrief: (b: Brief) => void; busy: boolean; onBack: () => void; onSubmit: () => void }) {
  const comps = brief.comps;
  const valid = brief.title.trim() && comps.filter((c) => c.trim()).length >= 2 && brief.regions.length >= 1;
  const input = "mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent";
  return (
    <section className="max-w-2xl pt-6">
      <h1 className="text-3xl font-semibold tracking-tight">Your release</h1>
      <p className="mt-2 text-muted">Comps are 2–4 released titles you believe share your audience. They anchor the audience in real Qloo entities.</p>
      <form
        className="mt-6 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit();
        }}
      >
        <label className="block text-sm font-medium">
          Release title
          <input className={input} value={brief.title} onChange={(e) => setBrief({ ...brief, title: e.target.value })} required maxLength={120} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">
            Format
            <select className={input} value={brief.format} onChange={(e) => setBrief({ ...brief, format: e.target.value as Brief["format"] })}>
              <option value="film">Film</option>
              <option value="series">Series</option>
              <option value="album">Album</option>
              <option value="tour">Tour</option>
              <option value="special">Comedy special</option>
            </select>
          </label>
          <label className="block text-sm font-medium">
            Budget band
            <select className={input} value={brief.budget} onChange={(e) => setBrief({ ...brief, budget: e.target.value as Brief["budget"] })}>
              <option value="S">Small</option>
              <option value="M">Medium</option>
              <option value="L">Large</option>
            </select>
          </label>
        </div>
        <label className="block text-sm font-medium">
          Logline <span className="font-normal text-muted">(optional)</span>
          <textarea className={input} rows={2} value={brief.logline} onChange={(e) => setBrief({ ...brief, logline: e.target.value })} maxLength={400} />
        </label>
        <fieldset>
          <legend className="text-sm font-medium">Comparable titles (2–4)</legend>
          <div className="mt-1 space-y-2">
            {comps.map((c, i) => (
              <div key={i} className="flex gap-2">
                <CompInput
                  className={cx(input, "mt-0")}
                  index={i}
                  format={brief.format}
                  value={c}
                  onChange={(v) => setBrief({ ...brief, comps: comps.map((x, j) => (j === i ? v : x)) })}
                />
                {comps.length > 2 && (
                  <Button type="button" variant="quiet" onClick={() => setBrief({ ...brief, comps: comps.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                )}
              </div>
            ))}
            {comps.length < 4 && (
              <Button type="button" variant="quiet" onClick={() => setBrief({ ...brief, comps: [...comps, ""] })}>
                + Add comp
              </Button>
            )}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">Target regions</legend>
          <div className="mt-2 flex gap-4 text-sm">
            {[
              ["US", "United States"],
              ["GB", "United Kingdom"],
            ].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={brief.regions.includes(k)}
                  onChange={(e) => setBrief({ ...brief, regions: e.target.checked ? [...brief.regions, k] : brief.regions.filter((r) => r !== k) })}
                />
                {l}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">More regions after we verify Qloo location coverage.</p>
        </fieldset>
        <label className="block text-sm font-medium">
          Exclusions <span className="font-normal text-muted">(comma-separated: brand categories, competitors)</span>
          <input
            className={input}
            placeholder="e.g. alcohol, gambling"
            value={brief.exclusions.join(", ")}
            onChange={(e) =>
              setBrief({
                ...brief,
                exclusions: e.target.value
                  .split(",")
                  .map((s) => s.trimStart())
                  .filter((s, i, a) => s || i === a.length - 1),
              })
            }
          />
        </label>
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? "Finding comps in Qloo…" : "Find comps"}
          </Button>
        </div>
      </form>
    </section>
  );
}

const suggestCache = new Map<string, string[]>();

/** Comp field with Qloo-search autocomplete (debounced, cached, min 3 chars). */
function CompInput({ value, onChange, index, format, className }: { value: string; onChange: (v: string) => void; index: number; format: Brief["format"]; className: string }) {
  const [options, setOptions] = useState<string[]>([]);
  useEffect(() => {
    const q = value.trim();
    if (q.length < 3) return;
    const key = `${format}:${q.toLowerCase()}`;
    const hit = suggestCache.get(key);
    const t = setTimeout(
      async () => {
        if (hit) return setOptions(hit);
        const r = await resolveNames([q], format, true).catch(() => ({ error: "" }));
        if ("error" in r) return;
        const names = [...new Set(r.resolutions[0]?.candidates.map((c) => c.name) ?? [])];
        suggestCache.set(key, names);
        setOptions(names);
      },
      hit ? 0 : 600,
    );
    return () => clearTimeout(t);
  }, [value, format]);
  const listId = `comp-suggest-${index}`;
  return (
    <>
      <input
        className={className}
        placeholder={["e.g. Hereditary", "e.g. The Witch", "e.g. Midsommar", ""][index]}
        value={value}
        aria-label={`Comp ${index + 1}`}
        list={listId}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {options
          .filter((o) => o.toLowerCase() !== value.trim().toLowerCase())
          .map((o) => (
            <option key={o} value={o} />
          ))}
      </datalist>
    </>
  );
}

function Confirm({
  brief,
  resolutions,
  picked,
  setPicked,
  busy,
  onBack,
  onRun,
  comps,
}: {
  brief: Brief;
  resolutions: Resolution[];
  picked: Record<string, string>;
  setPicked: (p: Record<string, string>) => void;
  busy: boolean;
  onBack: () => void;
  onRun: () => void;
  comps: Comp[];
}) {
  const missing = resolutions.filter((r) => !r.candidates.length);
  return (
    <section className="max-w-3xl pt-6">
      <Label>“{brief.title}” · step 2 of 3</Label>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Confirm your comps</h1>
      <p className="mt-2 text-muted">We matched each comp to a Qloo entity. Check these before we spend any research calls.</p>
      <div className="mt-6 space-y-3">
        {resolutions.map((r) => (
          <Card key={r.query} className="p-4">
            <div className="text-sm text-muted">You typed “{r.query}”</div>
            {r.candidates.length === 0 ? (
              <div className="mt-1 text-sm text-warn">We couldn&apos;t find “{r.query}” in Qloo. Try the exact title{resolutions.length - missing.length >= 2 ? ", or continue without it" : ""}.</div>
            ) : (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  {(() => {
                    const c = r.candidates.find((c) => c.entityId === picked[r.query]);
                    return c ? (
                      <div>
                        {!isCloseMatch(r.query, c.name) && (
                          <div className="mb-1 text-sm text-warn">No close match for “{r.query}” in Qloo. This is the nearest result; pick another or leave it out.</div>
                        )}
                        <span className="font-semibold">{c.name}</span>{" "}
                        <span className="text-sm text-muted">
                          {c.type.replace("_", " ")}
                          {c.year ? ` · ${c.year}` : ""}
                        </span>
                        {c.descriptor && <div className="text-xs text-muted">{c.descriptor}</div>}
                      </div>
                    ) : (
                      <span className="text-sm text-muted">Excluded from this run</span>
                    );
                  })()}
                </div>
                <label className="text-xs text-muted">
                  Not this one?{" "}
                  <select
                    className="ml-1 rounded-lg border border-line bg-surface px-2 py-1 text-sm text-ink"
                    value={picked[r.query] ?? ""}
                    onChange={(e) => setPicked({ ...picked, [r.query]: e.target.value })}
                  >
                    {r.candidates.map((c) => (
                      <option key={c.entityId} value={c.entityId}>
                        {c.name} {c.year ? `(${c.year})` : ""} — {c.type.replace("_", " ")}
                      </option>
                    ))}
                    <option value="">Leave out</option>
                  </select>
                </label>
              </div>
            )}
          </Card>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onRun} disabled={comps.length < 2 || busy}>
          Plan campaign
        </Button>
        {comps.length < 2 && <span className="text-sm text-warn">Need at least 2 confirmed comps.</span>}
      </div>
    </section>
  );
}

function Working({
  steps,
  trace,
  early,
  format,
}: {
  steps: { message: string; calls: number }[];
  trace: TraceEntry[];
  early: { audience: AudienceMap; comps: Comp[] } | null;
  format: Brief["format"];
}) {
  const calls = steps.at(-1)?.calls ?? 0;
  // Count only requests actually sent: cache hits and failed requests are traced too.
  const qloo = trace.filter((t) => t.kind === "qloo" && /^(live|synthetic) /.test(t.message)).length;
  const decisions = trace.filter((t) => t.kind === "decision" || t.kind === "plan" || t.kind === "tool").slice(-6);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and React would call it as the cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [trace.length]);
  return (
    <section className="max-w-3xl pt-6" aria-live="polite">
      <Label>Agent working</Label>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Researching the comps&apos; audiences</h1>
      <div className="mt-4 flex items-center gap-3 text-sm">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
        <span className="font-mono">{Math.max(calls, qloo)} Qloo calls</span>
        <span className="text-muted">· usually 20–60 s</span>
      </div>
      <ol className="mt-6 space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex items-baseline gap-3 text-sm">
            <span className="text-evidence">✓</span>
            <span>{s.message}</span>
            <span className="font-mono text-xs text-muted">{s.calls} calls</span>
          </li>
        ))}
      </ol>
      {decisions.length > 0 && (
        <Card className="mt-6 p-4">
          <Label>Agent decisions</Label>
          <ul className="mt-2 space-y-1 text-sm text-muted">
            {decisions.map((d, i) => (
              <li key={i}>
                <span className="font-mono text-[11px] uppercase">{d.kind}</span> {d.message}
              </li>
            ))}
          </ul>
          <div ref={end} />
        </Card>
      )}
      {early && <EarlyAudience audience={early.audience} comps={early.comps} format={format} />}
    </section>
  );
}
