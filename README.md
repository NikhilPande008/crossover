# Crossover

**Find the audience your release can actually reach, and turn it into a launch plan you can defend.**

Crossover is a release-marketing agent for studio, streamer and record-label marketers. It answers the question every launch starts with, *which comparable title ("comp") should we position against?*, and turns the answer into a launch plan: which cities get the budget, which partners to approach, and which creative angle leads. You give it a release and 2–4 comps; it uses Qloo's taste graph to work out where the comps' fans live, what else they love across music, podcasts, TV, film and brands, and whether the comps share one audience or split into two. It then proposes three campaign concepts and recommends one. Every partner and market in the plan traces back to the Qloo request that produced it.

**Live demo:** https://crossover-murex.vercel.app (click **Prestige horror film** → **Plan campaign**, about 30 s; the live demo uses OpenAI `gpt-4.1-mini`).

> Qloo affinity describes aggregate taste overlap among audiences. It is not a forecast of box office, streams, ticket sales or campaign performance.

## Problem

Mid-size marketers commit a fixed launch budget to markets, partners and a creative angle with little audience research. The hardest call is usually *which comp to position against*. That choice decides the audience, the cities, the partners and the creative. Today it is settled by gut feel or by repeating the last campaign.

## Who it's for and what's next (hypotheses, not yet tested with buyers)

- **User:** the marketing lead at a mid-size film distributor, streamer or record label who sets a release's launch plan without a research team. The decision Crossover supports is one they already make: which comp to position against, which cities get the budget, which partners to approach, which angle leads.
- **Buyer:** that team's head of marketing, paying for a seat per marketer rather than per report, because the value is in re-planning (swap a comp, exclude a partner) during campaign planning. We have no pricing evidence yet; this is the model we would test first.
- **What we would need to learn:** whether marketers trust a comp-based audience map enough to change a market or partner choice, and whether the "test before you spend" checklist matches how they actually pilot. The evaluation protocol in [docs/eval.md](docs/eval.md) and 3–5 marketer interviews come first.
- **What's next in the product:** more regions once Qloo location coverage is verified, artist-led presets for album rollouts, more specific brand partners (Qloo's popularity filters were tested and return noise, so this needs a category filter), and an MCP endpoint so other agents can call Crossover.

Crossover is release marketing, not tour routing or sponsorship matching: it starts from the comps a marketer already uses and ends with a launch plan for one release.

## What the agent does

1. **Confirm comps before spending research.** The marketer enters a release (title, format, logline, US/UK regions, budget band, exclusions) and 2–4 comps, or opens one of three presets. Each comp is resolved to a Qloo entity and shown for confirmation before any research call; a made-up title gets a "No close match" warning.
2. **Choose its own research.** An LLM agent runs a bounded tool-calling loop (up to 6 turns). It decides which Qloo calls to make: which partner domains, per-comp or combined signals, which comp pairs to compare. The steps, the agent's reasons and a live Qloo call counter stream to the screen. Default coverage is podcasts, music artists, brands and the other screen format (TV shows for a film, films for a series); books and the release's own format are fetched when the agent asks for them.
3. **Check its evidence and recover.** After every turn, code checks for missing domains, thin results, unmapped markets and uncompared comp pairs, and makes the recovery calls (for example, combining comps into one signal when per-comp results are thin).
4. **Score in code, not by the model.** Partners are ranked by weighted mean affinity across the comps, and markets by mean heatmap percentile across the comps. Each comp pair gets a verdict, **"one audience or two?"**: the share of distinct themes the two titles have in common in Qloo's compare analysis (10% or more = one audience), falling back to each comp's own taste tags. Overlap of each comp's own top audience affinities is shown alongside, but it was low (1–7%) for every pair we ran live, so it does not decide the verdict. Taste tags are filtered to story and media tags; Qloo's tag list also contains restaurant, payment and hotel tags. Confidence labels come from comp agreement and affinity strength.
5. **Propose three concepts with different levers:** market-led, partner-led (bridge both audiences) and crossover into an adjacent fandom. Each has ranked markets, a partner shortlist, a creative angle, a confidence label and the main risk. The model picks partners and markets **by candidate key only**, so every name on a concept comes from a Qloo fact. Exclusions, regions and pinned markets are enforced in code, and near-duplicate concepts are replaced.
6. **Recommend and justify.** Code picks the recommendation (highest confidence; a tie goes to the bridge concept when most comp pairs share an audience, else to the market-led one), so the same evidence always gives the same pick. The results header states it as **"Lead with …"**. The model writes a cited rationale, trade-offs and a "test before you spend" checklist, whose items may name only partners and markets from the recommended concept. A grounding validator removes any sentence with an uncited claim, a number that is not in its cited facts, a quantity in words ("ten times", "twice as", "one in five"), a capitalised name with a word that appears in no known name, a partner, show, artist, brand or city that none of the sentence's own cited facts is about, a comparison ("higher than", "the strongest", "among the top") that the run's scores contradict, or sensitive-trait language. It is a word-level check, not a judge: it does not decide whether cited tags actually support an angle's wording, and a new name built only from words of known names (two tags, say) can still pass. The brief is printable.
7. **Re-plan when the marketer changes their mind.** Swap a comp (e.g. Midsommar → Lady Bird), mark a partner "not a fit" or pin a market, and the agent re-plans. A diff banner shows how many markets and partners changed and whether the lead concept changed; **"What moved?"** lists each new item with its evidence.
8. **Prove the value of Qloo.** The **Without Qloo** tab gives the same model the same brief with no tools, then fact-checks every partner it names against Qloo: does it exist, and does it have measured affinity with these comps' audiences?

### Evidence model

| Layer | Produced by | Shown as |
|---|---|---|
| Retrieved evidence | Qloo client (code) | Solid chip with fact ID; click opens the request |
| Interpretation | LLM, validated | Text with citations |
| Hypothesis | LLM, labelled | Italic, "Hypothesis — test before spending" |

Confidence labels are computed in code (comp agreement and affinity strength), never by the model. Agreement counts only per-comp requests: a partner found by one combined request for several comps is evidence, but not evidence that the comps agree.

## How Qloo powers it

Qloo's taste graph provides the evidence; the model only plans the research and writes the text.

| Qloo capability | Endpoint | What it decides in Crossover |
|---|---|---|
| Entity search | `GET /search` | Which real titles anchor the audience; fact-checks the model-only baseline |
| Cross-domain affinities | `GET /v2/insights` `filter.type=urn:entity:{podcast,artist,tv_show,movie,brand}` (`book` when the agent asks) | Which partners to approach, attributed to the comp whose audience produced them |
| Taste tags | `GET /v2/insights` `filter.type=urn:tag` (story and media tags) | Which creative angle the evidence supports |
| Demographics | `GET /v2/insights` `filter.type=urn:demographics` | Aggregate audience skew (age and gender, group-level only) |
| Heatmap | `GET /v2/insights` `filter.type=urn:heatmap` | Which US and UK cities get the budget |
| Theme compare | `GET /v2/analysis/compare` (`a.signal.interests.entities`, `b.signal.interests.entities`) | One audience or two: bridge both comps, or pick a lead (live: Hereditary/The Witch share 17% of themes, Hereditary/Lady Bird 3%) |

- **Every value is traceable.** Each Qloo value is stored with the request that produced it. Clicking any partner or market chip opens an evidence drawer with the exact endpoint and parameters, marked live, recorded or synthetic.
- **Comp-anchored and attributed.** Partners and markets are measured per comp, so the plan shows which comp's audience each one comes from, and the swap diff shows how the plan changes when the anchor changes.
- **Measured against the model alone.** See [Testing and evaluation](#testing-and-evaluation) and [docs/eval.md](docs/eval.md).

A full run is about 27–30 Qloo calls. The per-run cap is `QLOO_MAX_CALLS_PER_RUN`: 36 by default, set to 30 on the live demo (its `/api/health` shows the value in use). On Vercel a comp swap or refinement often lands on a different server instance and becomes a full run of about 30 calls; only when it reaches the instance that planned the original run does it re-use the still-valid facts and fetch just what changed. The diff banner works either way, because the browser keeps the previous result.

**What an LLM alone cannot do:** say where *these* comps' fans concentrate, tell whether two comps share an audience, or attribute a partner to a specific comp. The **Without Qloo** tab runs the same model on the same brief with no tools and fact-checks every partner it names against Qloo.

## Judge click path

1. Open the app and click **Prestige horror film**.
2. Keep the confirmed comps and click **Plan campaign**. Watch the agent's steps and call counter.
3. Read the **Lead with …** line in the header. On the recommended concept, click any fact chip (e.g. `F12`) to open the evidence drawer and the exact request.
4. Click **Swap comp** (pre-filled: Midsommar → Lady Bird) and **Re-plan**. Read the diff banner; click **What moved?**
5. Open **Without Qloo**, then **Show without Qloo**.
6. Open **Decision brief**, then **Print / PDF**.
7. Negative case: go back, choose **Plan my own release**, and enter a made-up comp title to see the "No close match" path.

## Architecture

One Next.js app (App Router, TypeScript) on a long-running Node host. No separate backend, no agent framework, no database.

```
app/api/plan        SSE: runs the agent, streams steps and trace
app/api/resolve     comp → Qloo entity candidates
app/api/baseline    LLM-only arm + Qloo fact-check
app/api/health      mode, quota, LLM status
lib/qloo/           client (X-Api-Key, retries, pacing, quota headers, LRU cache, trace),
                    param allowlist, loose response schemas, typed API, synthetic fixtures
lib/agent/          loop, tools, assess (gaps + recovery), concepts, brief, prompts
lib/facts/store.ts  Fact store; the LLM sees compact summaries only
lib/score.ts        pure scoring and confidence
lib/validate/       grounding validator, constraints, input schemas
components/         UI
scripts/plan.ts     CLI end-to-end spike
scripts/api-test.ts API spike: writes shapes and pass/fail to docs/api-findings.md
```

### Language model

The model plans the research calls and writes the concepts and brief; all retrieval, scoring, confidence and validation are code. Pick a provider with `LLM_PROVIDER`. **The live demo runs `LLM_PROVIDER=openai` with OpenAI `gpt-4.1-mini`**; the results header and `/api/health` name the model in use.

| Provider | What it is | Cost logging |
|---|---|---|
| `anthropic` (default) | Claude via the Anthropic SDK, `claude-opus-5-5` by default, server-side refusal fallbacks on | Built-in list prices |
| `ollama` | Open-weights models on a local [Ollama](https://ollama.com) server (default `crossover-gpt-oss`: `gpt-oss:20b` with a 16K context) | $0 (local) |
| `openai` | Any OpenAI-compatible API (Groq, Together, Fireworks, OpenRouter, vLLM, LM Studio) with `LLM_BASE_URL` + `LLM_MODEL` | Set `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` |
| `none` | Deterministic templates, no model | — |

The model must support tool calling. Every model call is metered: token counts and cost appear on the results header, in the agent trace (per call), in the CLI output, in server logs (`[llm-usage]`), and as totals since boot at `/api/health`.

Every model call has a time limit inside the run's budget (research ends by `RUN_WALL_SECONDS`; writing ends at most 40 s later, inside the 120 s route limit) and stops when the browser goes away. If the model is unavailable, Crossover still renders the audience map and ranked markets with templated concepts, labelled "Generated without the writing model".

Local open model in one go:

```bash
ollama pull gpt-oss:20b
npm run ollama:setup        # same weights, 16K context (Ollama's 4K default silently truncates our prompts)
LLM_PROVIDER=ollama npm run plan -- prestige-horror
```

Open models get `reasoning_effort=low` on Ollama by default (`LLM_REASONING_EFFORT` to change). If Ollama ever truncates a prompt, the run fails loudly instead of producing confident garbage.

## Setup

```bash
npm install
cp .env.example .env.local   # optional: add QLOO_API_KEY and LLM_API_KEY
npm run dev
```

Without `QLOO_API_KEY` the app runs in **fixture mode**: invented entities from a seeded generator, clearly bannered "Synthetic data — not Qloo". No Qloo response data is committed to this repo.

```bash
npm test             # unit + fixture-mode agent tests
npx playwright install chromium   # once, before the first e2e run
npm run e2e          # Playwright smoke (desktop + mobile) on a fixture-mode build; no keys used
npm run plan -- prestige-horror          # CLI run
npm run plan -- prestige-horror --swap   # with the demo comp swap
npm run plan -- prestige-horror --save=/tmp/run.json   # keep the full run (Qloo data: outside the repo or under .data/)
npm run revalidate -- /tmp/run.json      # re-apply the current validator to a saved run
npm run eval         # arm-vs-arm evaluation (docs/eval.md) against the live demo; ~50 Qloo calls per brief, raw runs to .data/eval/
npm run api-test     # live API spike (needs QLOO_API_KEY)
```

### Environment variables

See [.env.example](.env.example). Keys stay server-side; the browser never sees them.

| Variable | Default | Purpose |
|---|---|---|
| `QLOO_API_KEY` | — | Qloo hackathon key |
| `QLOO_BASE_URL` | `https://hackathon.api.qloo.com` | Qloo host |
| `CROSSOVER_MODE` | `live` if key set, else `fixture` | Force a mode |
| `LLM_PROVIDER` | `anthropic` | `anthropic`, `ollama`, `openai` (any OpenAI-compatible API) or `none` |
| `LLM_API_KEY` | — | Provider key (Anthropic also reads `ANTHROPIC_API_KEY`; Ollama needs none) |
| `LLM_MODEL` | `claude-opus-5-5` / `crossover-gpt-oss` (Ollama) | Model ID |
| `LLM_REASONING_EFFORT` | `low` on Ollama | `reasoning_effort` for open reasoning models (`low`, `medium`, `high`, `off`) |
| `LLM_BASE_URL` | Ollama: `http://localhost:11434/v1` | Endpoint for `ollama` / `openai` providers |
| `LLM_PRICE_INPUT_PER_MTOK`, `LLM_PRICE_OUTPUT_PER_MTOK` | — | USD per million tokens, for cost logging of hosted open models |
| `RUN_WALL_SECONDS` | 60 (240 for Ollama) | Wall-clock budget per run |
| `QLOO_QUOTA_FLOOR` | `1500` | Below this monthly remaining, live runs pause and presets replay recorded runs. Works only if Qloo sends a monthly-remaining header; `/api/health` lists the quota header names it has seen (`quotaHeadersSeen`) and the value read (`quotaRemaining`) |
| `QLOO_MAX_CALLS_PER_RUN` | `36` | Hard cap per run |
| `LIVE_RUNS_PER_IP_HOUR` | `6` | Per-visitor live-run cap (re-plans get 3×, "Without Qloo" 2×; comp lookups are capped at 30 and autocomplete at 40 per hour) |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front of the app that append to `X-Forwarded-For` (1 for Render, Railway or Vercel); sets which entry is the visitor's IP for the per-visitor caps |

### Deployment

Any long-running Node host that supports streaming responses (Render, Railway, Fly, or Vercel with Fluid Compute). Set the env vars in the host's secret store. Recorded preset runs are written to `.data/recorded/` on the server for quota-floor replay and are never committed. On Vercel they go to `/tmp`, which lasts only as long as the instance, so replay there is best-effort. The local Ollama provider can't run on a hosted deploy; use `anthropic`, a hosted OpenAI-compatible API, or `none`.

## API usage, quotas and limitations

- Observed hackathon limits: about 5 requests/s and 10,000/month per key. The client paces to about 4.5 req/s, backs off on 429 using `x-second-ratelimit-reset`, and caches responses in memory.
- **Unverified parameters.** Qloo has been reported to ignore invalid parameters silently. Every parameter is allowlisted in `lib/qloo/params.ts`, and filters (e.g. exclusions) are re-asserted in code. Run `npm run api-test` with a key to verify.
- Affinity thresholds in `lib/thresholds.ts` were calibrated on live runs (2026-10-25 and 2026-10-30) for a handful of comps; treat them as provisional for other genres.
- Location coverage is verified for the US and UK first; other regions are not offered yet.
- Demographics are aggregate audience skew only. The validator blocks descriptions by sensitive traits, including when a taste tag has a sensitive name.
- Per-visitor caps, the run store, the response cache and recorded preset runs live in each server instance's memory (or `/tmp`). On a multi-instance host a re-plan can land on a fresh instance and cost a full run.
- Brand partners still include household-name brands. Qloo's popularity filters were tested and return noise; a brand-category filter is planned after the hackathon.
- Planned after the hackathon: shared run storage across server instances (so a comp swap on Vercel always re-uses facts) and a semantic check that cited tags support an angle's wording.

## Testing and evaluation

Unit tests cover scoring, constraints, the grounding validator, the Qloo client's retries, time budgets and a fixture-mode end-to-end run (budget, distinct levers, citations, exclusions, comp swap, refinements). CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests, a fixture-mode build and the Playwright smoke test with no keys.

**First evaluation run** (2026-10-31, live demo, `gpt-4.1-mini` for both arms; 4 of 6 fixed briefs completed, one stream dropped and one hit the per-visitor cap). Full table and caveats in [docs/eval.md](docs/eval.md); `npm run eval` reruns it.

| | Model alone (same brief, no Qloo) | Crossover |
|---|---|---|
| Named partners that resolve to a Qloo entity | 83% of 59 | all 67, by construction |
| …with measured affinity to these comps' audiences | 31% | all, by construction |
| Partner-list overlap between briefs with different comps (lower = more specific) | 0.011 | 0.043 (four music artists shared by two briefs) |

## Credits

| What | Used for | Terms |
|---|---|---|
| [Qloo](https://www.qloo.com) Insights API (hackathon host) | All taste, affinity, heatmap, demographic and compare data | Qloo hackathon terms. No Qloo response data is committed or redistributed here; only synthetic fixtures |
| [OpenAI](https://openai.com) `gpt-4.1-mini` via the OpenAI-compatible provider | Research planner and writer on the live demo | OpenAI API terms |
| [Claude](https://www.anthropic.com/claude) via the Anthropic TypeScript SDK | Default provider in code | Anthropic commercial terms; SDK Apache-2.0 |
| [gpt-oss](https://ollama.com/library/gpt-oss) via [Ollama](https://ollama.com) (optional) | Local open-weights alternative | Apache-2.0 model weights; Ollama MIT |
| [Next.js](https://nextjs.org), [React](https://react.dev) | App framework | MIT |
| [Tailwind CSS](https://tailwindcss.com) | Styling | MIT |
| [Geist and Geist Mono](https://vercel.com/font) via `next/font/google` | Typefaces | SIL Open Font License 1.1 |
| [zod](https://zod.dev) | Request and response validation | MIT |
| [Vitest](https://vitest.dev), [Playwright](https://playwright.dev), [tsx](https://tsx.is) | Tests and scripts | MIT; Playwright Apache-2.0 |

Comp titles in the presets are referenced by name only. The app shows no posters, stills, trailers or third-party logos.

## License

[MIT](LICENSE)
