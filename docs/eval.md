# Evaluation

Status: **first run on 2026-10-31, 4 of 6 briefs completed.** Results below come from that run only (`npm run eval`, `scripts/eval.ts`); nothing is estimated. Raw runs contain Qloo data and stay in gitignored `.data/eval/`.

## Run 1 — 2026-10-31

Setup: live demo (`https://crossover-murex.vercel.app`, build `6d6eaab`), `gpt-4.1-mini` (OpenAI) for both arms, live Qloo. Arm C is `/api/plan`; arm A is `/api/baseline` on the same brief and comps, fact-checked by the same code. One run per brief.

| # | Brief | Result |
|---|---|---|
| 1 | prestige-horror, as preset | completed |
| 2 | prestige-horror, no exclusions | **failed**: the live stream dropped mid-run (client saw `terminated`); not retried |
| 3 | indie-coming-of-age, as preset | completed |
| 4 | indie-coming-of-age, exclusions: alcohol | completed |
| 5 | dark-comedy-series, as preset | completed |
| 6 | dark-comedy-series, no exclusions | **not run**: the demo's 6-runs-per-visitor-per-hour cap was reached (one earlier manual run counted) |

n = 4 completed briefs. Small; read as a first look, not a benchmark.

| Metric | Arm A (model alone) | Arm C (Crossover) |
|---|---|---|
| Partners named (4 briefs) | 59 | 67 |
| Verifiability: resolve to a Qloo entity | 83% | 100% by construction (names come from Qloo facts), not a measured result |
| Audience grounding: measured affinity with these comps' audiences | 31% | 100% by construction |
| Specificity: mean partner-list overlap (Jaccard) between briefs with different comps, as-preset briefs, 3 pairs (lower = more specific) | 0.011 | 0.043 |
| Exclusion violations (name match only; a weak check) | 0 | 0 |
| Wall time per run (median / max) | — | 29.8 s / 29.9 s |
| Qloo calls per run | — | 5, 27, 0, 30 (the 5 and 0 were mostly served from the server's response cache, filled by earlier runs of the same comps) |
| Brief written by the model / validator removals | — | 4 of 4 / 6 items removed in total |
| Recommended lever | — | market ×3, crossover ×1 (build `6d6eaab` let the model choose; the recommendation is now picked in code) |

What this shows and does not show:
- Without Qloo, about one in six partners the model named does not resolve to any Qloo entity, and fewer than a third have any measured affinity with the comps' audiences. Crossover's partners all do, because they are taken from Qloo results.
- On specificity Crossover did **not** beat the baseline in this run: its lists overlapped more across briefs. All of the overlap is four music artists shared by the coming-of-age and dark-comedy briefs; the horror brief shared no partner with either.
- One of five attempted live streams dropped. It needs a server-side check before more runs.
- Not yet measured: comp sensitivity, refinement responsiveness, the retrospective check and marketer feedback.

## Run 2 — protocol (not run yet)

Fixed before the run, against a build with lift scoring, the cross-affinity verdict and resumable streams. Run it with live Qloo and the durable store configured:

```
npm run eval -- --reps=3 --swaps --refine
```

| What | How | Pass / report |
|---|---|---|
| Reliability | every plan, swap and refinement goes through the browser's stream client, so a dropped stream is resumed, not failed | completion rate (target: all), resumes after a drop, p95 wall time |
| Run-to-run variance | each brief run 3 times | partner-list Jaccard with the first run |
| Comp sensitivity | each comp swapped once (`SWAPS` in `scripts/eval.ts`, fixed before the run), re-planned with `priorRunId` as the UI does | share of the recommended concept's partners and markets that changed; whether the lead changed; median Qloo calls per swap |
| Refinement responsiveness | exclude the recommended concept's top partner and pin the #8 market | constraints honoured and ≥ 30% of the recommended concept changed |
| Both arms scored by Qloo | `/api/baseline` scores the model's partners and Crossover's partners with the same lift calls | positive-lift partners per arm, median lift per brief |
| Generic rate | recommended-concept partners with lift ≤ 0 | target 0 |
| Specificity | as run 1 | should fall below the model alone's 0.011 |

## Verdict calibration — protocol (not run yet)

`npm run calibrate` (live key, about 50 Qloo calls) scores ten film pairs labelled before the run (`PAIRS` in `scripts/calibrate.ts`: five "one audience", two "adjacent", three "different") with the same code as a run, plus the two control titles for film. Report the printed table here: mutual lift, verdict, agreement with the labels, and whether the controls stay near zero. The labels are judgement, not ground truth; if agreement is low, retune `oneAudienceLift` and `adjacentLift` in `lib/thresholds.ts` on this table and say so.

## Test set (fixed before the first comparison run)

6 briefs = 3 presets (`lib/presets.ts`) × 2 constraint sets:

| # | Preset | Constraint set |
|---|---|---|
| 1 | prestige-horror | as preset (exclusions: alcohol) |
| 2 | prestige-horror | no exclusions |
| 3 | indie-coming-of-age | as preset (none) |
| 4 | indie-coming-of-age | exclusions: alcohol |
| 5 | dark-comedy-series | as preset (exclusions: gambling) |
| 6 | dark-comedy-series | no exclusions |

Record for every run: date, `LLM_MODEL`, Qloo host, mode (must be `live`).

## Arms

- **A — LLM only.** Same model, same brief and constraints, no tools (`/api/baseline`, prompt in `lib/agent/prompts.ts` `BASELINE_SYSTEM`).
- **C — Crossover.** Full agent (`/api/plan`).

Both arms' partners are checked against Qloo by the same code (`lib/baseline.ts`).

## Metrics

| Metric | How measured | Arm | Result |
|---|---|---|---|
| Verifiability | % named partners that resolve to Qloo entities | A, C | — |
| Audience grounding | % named partners with measured affinity to the comps' audiences | A, C | — |
| Specificity | partner-list overlap across briefs with different comps (lower = more specific) | A, C | — |
| Comp sensitivity | % of the recommended concept that changes when one comp is swapped (`--swaps`) | C | — |
| Constraint adherence | exclusion violations | A, C | — |
| Grounding of prose | % sentences with valid citations; % dropped by validator | C | — |
| Latency | p50 / p95 full run and comp swap | C | — |
| API health | Qloo error rate by status; calls per run | C | — |
| Refinement responsiveness | excluded item absent, pinned market in every concept, ≥ 30% of the recommended concept changed (`--refine`) | C | — |
| Partner lift | % of named partners with positive lift vs the reference audience; median lift | A, C | — |
| Generic rate | % of recommended-concept partners with lift ≤ 0 | C | — |

## Retrospective sanity check

2–3 past releases with publicly documented marketing partners or regions. Give Crossover only their comps. Report hits and misses plainly; n is tiny and this is not validation.

## Marketer feedback (qualitative)

3–5 people. Shuffled, unlabeled A and C concept sets for one brief. Report n, mean ratings, short paraphrased quotes with permission.

## What we never claim

Invented traction, accuracy against campaign outcomes, box-office/stream forecasts, market sizes without a source.
