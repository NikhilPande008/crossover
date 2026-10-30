# Evaluation

Status: **not yet run.** Needs a live Qloo key and an LLM key. Fill this in from real runs only; never estimate.

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
| Comp sensitivity | % concept content that changes when one comp is swapped | A, C | — |
| Constraint adherence | exclusion violations | A, C | — |
| Grounding of prose | % sentences with valid citations; % dropped by validator | C | — |
| Latency | p50 / p95 full run and comp swap | C | — |
| API health | Qloo error rate by status; calls per run | C | — |
| Refinement responsiveness | excluded item absent and ≥30% of top-5 changed | C | — |

## Retrospective sanity check

2–3 past releases with publicly documented marketing partners or regions. Give Crossover only their comps. Report hits and misses plainly; n is tiny and this is not validation.

## Marketer feedback (qualitative)

3–5 people. Shuffled, unlabeled A and C concept sets for one brief. Report n, mean ratings, short paraphrased quotes with permission.

## What we never claim

Invented traction, accuracy against campaign outcomes, box-office/stream forecasts, market sizes without a source.
