# Crossover

**Find the audience your release can actually reach, and turn it into a launch plan you can defend.**

Crossover is an agent for studio, streamer and label marketers. You give it a release and 2–4 comparable titles ("comps"). It uses Qloo's taste graph to work out where the comps' fans live, what else they love across music, podcasts, TV, film, books and brands, and whether the comps share one audience or split into two. It then proposes three campaign concepts and recommends one. Every partner, market and number links to the Qloo request that produced it.

> Qloo affinity describes aggregate taste overlap among audiences. It is not a forecast of box office, streams, ticket sales or campaign performance.

## Problem

Mid-size marketers commit a fixed launch budget to markets, partners and a creative angle with little audience research. The hardest call is usually *which comp to position against*. That choice decides the audience, the cities, the partners and the creative. Today it is settled by gut feel or by repeating the last campaign.

## How it works

1. **Brief** — title, format, logline, 2–4 comps, regions, budget band, exclusions.
2. **Confirm comps** — each comp is resolved to a Qloo entity before any expensive call.
3. **Agent research** — a tool-calling loop chooses which Qloo calls to make (domains, per-comp vs combined signals, recovery when a signal is thin). Code checks evidence sufficiency after every turn and fills gaps.
4. **Score** — deterministic ranking of partners (weighted mean affinity across comps, optional popularity penalty) and markets (mean heatmap percentile across comps). One audience or two: the share of two comps' combined top audience affinities (fetched per comp, all domains) that both comps have, falling back to shared taste tags when per-comp affinities are missing. The compare endpoint adds the themes the comps share and the themes unique to each.
5. **Conceive** — three concepts with different levers: market-led, partner-led (bridge), crossover. The model picks partners and markets **by candidate key only**; names always come from Qloo facts.
6. **Critique** — exclusions, regions and pinned markets enforced in code; near-duplicate concepts replaced.
7. **Brief** — a recommendation with cited rationale, trade-offs and a "test before you spend" checklist. A grounding validator removes any sentence with an uncited claim, an unknown number, an unknown name, a partner, show, artist, brand or city that none of the sentence's own cited facts is about, or a comparison ("higher than", "the strongest", "among the top") that the run's scores contradict. It does not judge whether cited tags actually support an angle's wording.

### Evidence model

| Layer | Produced by | Shown as |
|---|---|---|
| Retrieved evidence | Qloo client (code) | Solid chip with fact ID; click opens the request |
| Interpretation | LLM, validated | Text with citations |
| Hypothesis | LLM, labelled | Italic, "Hypothesis — test before spending" |

Confidence labels are computed in code (comp agreement and affinity strength), never by the model.

## How Qloo powers it

| Capability | Endpoint | Used for |
|---|---|---|
| Entity search | `GET /search` | Resolve comps; fact-check the no-Qloo baseline |
| Cross-domain affinities | `GET /v2/insights` `filter.type=urn:entity:{artist,podcast,tv_show,movie,book,brand}` | Partner shortlists with per-comp attribution |
| Taste tags | `GET /v2/insights` `filter.type=urn:tag` | Creative-angle evidence |
| Demographics | `GET /v2/insights` `filter.type=urn:demographics` | Aggregate age and gender skew |
| Heatmap | `GET /v2/insights` `filter.type=urn:heatmap` | Rank cities by fan concentration |
| Theme compare | `GET /v2/analysis/compare` (`a.signal.interests.entities`, `b.signal.interests.entities`) | Themes two comps share and themes unique to each. Qloo compares the titles' tags here, not their audiences; the one-audience-or-two verdict comes from the per-comp affinities above |

A full run is about 26 Qloo calls (hard cap 30). A comp swap or refinement re-uses still-valid facts and costs under 10.

**What an LLM alone cannot do:** say where *these* comps' fans concentrate, tell whether two comps share an audience, or attribute a partner to a specific comp. The **Without Qloo** tab runs the same model on the same brief with no tools and fact-checks every partner it names against Qloo.

## Judge click path

1. Open the app and click **Prestige horror film**.
2. Keep the confirmed comps and click **Plan campaign**. Watch the agent's steps and call counter.
3. On the recommended concept, click any fact chip (e.g. `F12`) to open the evidence drawer and the exact request.
4. Click **Swap comp** (pre-filled: Midsommar → Lady Bird) and **Re-plan**. Read the diff banner; click **What moved?**
5. Open **Without Qloo**, then **Show without Qloo**.
6. Open **Decision brief**, then **Print / PDF**.
7. Negative case: **Plan my own release** with a made-up comp title to see the not-found path.

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

The model plans the research calls and writes the concepts and brief; all retrieval, scoring, confidence and validation are code. Pick a provider with `LLM_PROVIDER`:

| Provider | What it is | Cost logging |
|---|---|---|
| `anthropic` (default) | Claude via the Anthropic SDK, `claude-opus-5-5` by default, server-side refusal fallbacks on | Built-in list prices |
| `ollama` | Open-weights models on a local [Ollama](https://ollama.com) server (default `crossover-gpt-oss`: `gpt-oss:20b` with a 16K context) | $0 (local) |
| `openai` | Any OpenAI-compatible API (Groq, Together, Fireworks, OpenRouter, vLLM, LM Studio) with `LLM_BASE_URL` + `LLM_MODEL` | Set `LLM_PRICE_INPUT_PER_MTOK` / `LLM_PRICE_OUTPUT_PER_MTOK` |
| `none` | Deterministic templates, no model | — |

The model must support tool calling. Every model call is metered: token counts and cost appear on the results header, in the agent trace (per call), in the CLI output, in server logs (`[llm-usage]`), and as totals since boot at `/api/health`.

If the model is unavailable, Crossover still renders the audience map and ranked markets with templated concepts, labelled "Generated without the writing model".

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
npm run e2e          # Playwright smoke (desktop + mobile) on a fixture-mode build; no keys used
npm run plan -- prestige-horror          # CLI run
npm run plan -- prestige-horror --swap   # with the demo comp swap
npm run plan -- prestige-horror --save=/tmp/run.json   # keep the full run (Qloo data: outside the repo or under .data/)
npm run revalidate -- /tmp/run.json      # re-apply the current validator to a saved run
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
| `QLOO_QUOTA_FLOOR` | `1500` | Below this monthly remaining, live runs pause and presets replay recorded runs |
| `QLOO_MAX_CALLS_PER_RUN` | `30` | Hard cap per run |
| `LIVE_RUNS_PER_IP_HOUR` | `6` | Per-visitor live-run cap |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front of the app that append to `X-Forwarded-For` (1 for Render, Railway or Vercel); sets which entry is the visitor's IP for the per-visitor caps |

### Deployment

Any long-running Node host that supports streaming responses (Render, Railway, Fly, or Vercel with Fluid Compute). Set the env vars in the host's secret store. Recorded preset runs are written to `.data/recorded/` on the server for quota-floor replay and are never committed.

## API usage, quotas and limitations

- Observed hackathon limits: about 5 requests/s and 10,000/month per key. The client paces to about 4.5 req/s, backs off on 429 using `x-second-ratelimit-reset`, and caches responses in memory.
- **Unverified parameters.** Qloo has been reported to ignore invalid parameters silently. Every parameter is allowlisted in `lib/qloo/params.ts`, and filters (e.g. exclusions) are re-asserted in code. Run `npm run api-test` with a key to verify.
- Affinity thresholds in `lib/thresholds.ts` are provisional until the live API test.
- Location coverage is verified for the US and UK first; other regions are not offered yet.
- Demographics are aggregate audience skew only. The validator blocks descriptions by sensitive traits.

## Testing and evaluation

Unit tests cover scoring, constraints, the grounding validator and a fixture-mode end-to-end run (budget, distinct levers, citations, exclusions, comp swap, refinements). The arm-vs-arm evaluation protocol is in [docs/eval.md](docs/eval.md); results are reported there only from real runs.

## Credits

| What | Used for | Terms |
|---|---|---|
| [Qloo](https://www.qloo.com) Insights API (hackathon host) | All taste, affinity, heatmap, demographic and compare data | Qloo hackathon terms. No Qloo response data is committed or redistributed here; only synthetic fixtures |
| [Claude](https://www.anthropic.com/claude) via the Anthropic TypeScript SDK | Default research planner and writer | Anthropic commercial terms; SDK Apache-2.0 |
| [gpt-oss](https://ollama.com/library/gpt-oss) via [Ollama](https://ollama.com) (optional) | Local open-weights alternative | Apache-2.0 model weights; Ollama MIT |
| [Next.js](https://nextjs.org), [React](https://react.dev) | App framework | MIT |
| [Tailwind CSS](https://tailwindcss.com) | Styling | MIT |
| [Geist and Geist Mono](https://vercel.com/font) via `next/font/google` | Typefaces | SIL Open Font License 1.1 |
| [zod](https://zod.dev) | Request and response validation | MIT |
| [Vitest](https://vitest.dev), [Playwright](https://playwright.dev), [tsx](https://tsx.is) | Tests and scripts | MIT; Playwright Apache-2.0 |

Comp titles in the presets are referenced by name only. The app shows no posters, stills, trailers or third-party logos.

## License

[MIT](LICENSE)
