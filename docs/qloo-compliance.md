# Qloo hackathon requirements: checklist

Checked 2026-10-25 against the [developer guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide), the [parameter guide](https://docs.qloo.com/reference/available-parameters-by-entity-type), the use-case pages (demographics, heatmaps, taste analysis, analysis compare), the [hackathon kit](https://github.com/qloo/qloo-hackathon-kit) and the `@qloo/qloo-harness` 0.1.26 source. The live key arrived the same day: rows marked "live" were confirmed against `hackathon.api.qloo.com` on 2026-10-25 (`npm run api-test`, results in [api-findings.md](api-findings.md)); the rest mean "matches the docs and Qloo's own tooling", not "tested live".

## Access and setup

| Requirement | Status |
|---|---|
| Request key via the form | ✅ key received and working (2026-10-25) |
| Base URL `https://hackathon.api.qloo.com` (staging/prod keys 401) | ✅ `QLOO_BASE_URL` default |
| `X-Api-Key` header, no query param or Bearer | ✅ `lib/qloo/client.ts` |
| `/v2/insights` is GET with query-string params | ✅ |
| Array params comma-joined | ✅ same as the harness |
| Key never in a web page, app or repo | ✅ server-side only; `.env*` gitignored |
| Install harness, `qloo setup --qloo`, `qloo setup --status` → "Qloo data: ready" | ⏳ needs the key. Harness not installed on this machine yet (Node 26.7 ≥ 22.19 ✅) |
| Run `qloo exec find_tags --input-file request.json` | ⏳ needs the key |

## Endpoints and parameters

| Item | Docs | Crossover |
|---|---|---|
| `/search` for entity IDs | ✅ | ✅ |
| Insights `filter.type` for artist/podcast/tv_show/movie/book/brand | ✅ documented | ✅ |
| `urn:tag` insights with `signal.interests.entities` | Taste-analysis guide and harness use it; parameter table omits it | ✅ live: tags differ by comp (1 of 12 identical across two comps) |
| `urn:demographics` | Documented use case; one block per signal, affinity vs. average | ✅ now matched by `entity_id` |
| `urn:heatmap` with `filter.location.query` | Documented; examples use cities | ✅ live: "United States" and "United Kingdom" resolve. `take` must be 1–50 (60 returns 400), so we send 50. api-findings.md still shows the earlier 400s; re-run `npm run api-test` to refresh it |
| Heatmap `affinity_rank` | 0–1, rank-normalised | ✅ fixed (was treated as an integer rank) |
| Affinity location | Harness reads top-level `affinity` or `query.affinity` | ✅ fixed (was `query.affinity` only) |
| Compare | `GET /v2/analysis/compare`, `a.`/`b.signal.interests.entities`; `filter.type` does **not** accept `urn:tag`; 404 = "No results"; `results` is an array of undocumented item types | ✅ fixed path, params and 404 handling; tolerant parser in `lib/qloo/compare.ts`. Live shape: `results.tags` (shared, with a score) plus `results.a` / `results.b` (each side's tags). The share of distinct themes both titles have decides "one audience or two" (10% or more = one); top-affinity overlap is shown alongside but does not decide it (`lib/score.ts` `buildOverlap`) |
| `feature.explainability` | Not in the parameter table; the harness sends it | ✅ kept |
| `page` | Not documented; `offset` is | ✅ allowlist now uses `offset` |
| Invalid params silently ignored | ✅ documented | ✅ allowlist + filters re-checked in code |
| Legacy `/recommendations`, `/recs`, `/v2/insights/search` | Do not use | ✅ never used |

## Data use and safe use

| Rule | Status |
|---|---|
| Private server-side caching allowed, no time limit | ✅ in-memory LRU; recorded runs in gitignored `.data/` |
| No Qloo response data in a public repo | ✅ only synthetic fixtures; api-test writes shapes, not values |
| Don't send personal data to Qloo | ✅ only titles go to Qloo; comp inputs that look like emails, phone numbers or links are rejected |
| Results describe groups, not individuals | ✅ disclaimer on every brief; demographics aggregate only; sensitive-trait validator |
| Distinguish Qloo results from interpretation | ✅ evidence / interpretation / hypothesis layers |
| Bounded retries, respect quota | ✅ ≤4 attempts, pacing, per-run cap, per-visitor caps, quota floor |

## Open questions for `#api-help` on Discord

1. **Direct REST vs. the harness.** The kit says the event's "supported surfaces are `qloo explore`, `qloo exec`, `qloo api`, and `qloo mcp`". The developer guide shows direct REST with curl and Python. Is a hosted app calling the REST API directly with our event key acceptable? Crossover does this today.
2. ~~Does `filter.location.query` accept country names for heatmaps?~~ Answered live: yes, for the US and UK.
3. ~~What is the item schema of `/v2/analysis/compare` `results`?~~ Answered live: see the Compare row.
4. Monthly quota and rate limit for our key (the guide gives no numbers), and which response headers report the remaining monthly quota. Until this is known, `/api/health` lists the rate-limit and quota header names Qloo has sent (`quotaHeadersSeen`); the quota floor only works if one of them reports a monthly remaining count.

## Submission guide (kit) items

- Problem statement, the Qloo calls used and why: README and the Devpost submission
- Request-to-result walkthrough: every fact chip in the app opens the exact request behind it
- A short demo or screenshots with no credentials or personal data: ⏳
- Clean-environment setup steps: README (fixture mode needs no keys)
- Known limitations: README "API usage, quotas and limitations"
